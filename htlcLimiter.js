/*

Limits # of htlcs in each channel

Script periodically checks pending htlcs in channels and fee policy in channels.

In parallel in watches for forwarding requests.
It gets fee from either forwarding request or calculates it from getChannels response + fee policies.
It then gets which power of 2 range fee is.
It looks at how many pending htlcs are already in this fee range in request's incoming & outgoing channels
If # of htlcs for incoming channel is below some number (ALLOWED_PER_GROUP_MIN or ALLOWED_PER_GROUP_IN)
and if # of htlcs for outgoing channel is below some number (ALLOWED_PER_GROUP_MIN or ALLOWED_PER_GROUP_OUT)
it grants the request, otherwise rejects

Now also can limit # of htlcs by size of htlc as secondary check to specifically address how much can end up being settled on chain
So # of htlcs below SATS_LIMIT sats each are limited to ALLOWED_BELOW_LIMIT_OUT + ALLOWED_BELOW_LIMIT_IN per channel

The rate of getChannels updates is rate at which granted request counts are cleared, so also acts as rate limiter.

*/

import { subscribeToForwardRequests } from 'balanceofsatoshis/node_modules/ln-service/index.js'
import bos from './bos.js'
const { log2, floor, max } = Math
const { stringify, parse } = JSON

const seconds = 1000
const minutes = 60 * seconds

// settings
const DEBUG = false
const MAX_RAM_USE_MB = null // end process at _ MB usedHeap, set to null to disable
const UPDATE_DELAY = 10 * seconds // ms between re-checking active htlcs in each channel, effectively rate limiter
const FEE_UPDATE_DELAY = 42 * minutes // ms between re-checking channel policies
const LND_CHECK_DELAY = 2 * minutes // ms between retrying lnd if issue

// fee group settings
const MIN_ORDER_OF_MAGNITUDE = 0 // lowest 2^_ fee group possible (0 means all htlcs with fee rates below 1 sat are in same group)
const ALLOWED_PER_GROUP_MIN = 2 // smallest amount of htlcs allowed per fee group
const ALLOWED_PER_GROUP_IN = group => group // how many incoming htlcs allowed per fee group
const ALLOWED_PER_GROUP_OUT = group => group + 1 // * 2 // how many outgoing htlcs allowed per fee group

// unsettled sats per htlc settings (these are utxos we might potentially have to sweep or get lost on fees)
const SATS_LIMIT = 10000 // can limit # of htlc below this size of sats unsettled, 0 would mean unused
const ALLOWED_BELOW_LIMIT_IN = 2 // at most _ utxo<SATS_LIMIT should end up being settled on chain out of inward ones
const ALLOWED_BELOW_LIMIT_OUT = 3 // at most _ utxo<SATS_LIMIT should end up being settled on chain out of outward ones

// internal
const limiterProcess = { stop: false } // process handler to prepare to stop node
const byChannel = {}
const node = { policies: {}, authed: null }
let pendingOtherCount = 0
let pendingForwardCount = 0
let outgoingCount = 0
let incomingCount = 0
let lastPolicyCheck = 0
const keyToAlias = {}
const idToKey = {}

// get order of magnitude group number from sats using powers of 2 (instead of typical 10)
const getGroup = sats => max(floor(log2(sats)), MIN_ORDER_OF_MAGNITUDE)

// starts everything
const initialize = async (showLogs = true) => {
  showLogs && printout('started')
  node.auth = await bos.initializeAuth()

  try {
    // will now be listening to events about forwarding requests
    const subForwardRequests = subscribeToForwardRequests({ lnd: node.auth })
    subForwardRequests.on('forward_request', f => decideOnForward({ f, showLogs }))
    // DEBUG && printout('new request', stringify({ ...forward, onion: undefined, hash: f.hash?.slice(0, 5) }, fixJSON))

    // starts infinite async loop of updating snapshots of in flight htlcs for all channels
    updatePendingCounts({ subForwardRequests, showLogs })

    showLogs && printout('initialized')
    return limiterProcess
  } catch (e) {
    showLogs && printout(`could not subscribe to htlc requests, re-initializing in ${LND_CHECK_DELAY}`)
    await sleep(LND_CHECK_DELAY)
    return await initialize()
  }
}

// decide to allow or block forward request
const decideOnForward = ({ f, showLogs }) => {
  if (limiterProcess.stop) return f.reject() // f.reject() // if stop all new forwards

  // gets fee rate group for this forward request
  const group = getGroup(getFee(f))

  // how many unsettled in this fee group in latest byChannel snapshot for both channels in forward request
  const inboundFeeGroupCount = byChannel[f.in_channel]?.[group] ?? 0
  const outboundFeeGroupCount = byChannel[f.out_channel]?.[group] ?? 0

  // count unsettled htlcs below amount of sats unsettled for in and out
  // only matters if below limit
  const isBelowLimit = f.tokens < SATS_LIMIT
  // add up all the small-amount htlcs in the channel htlc is coming from
  const inboundSmallSizeCount = isBelowLimit
    ? -1
    : byChannel[f.in_channel]?.raw?.reduce((count, pending) => {
        const isBelowSizeLimit = pending.tokens < SATS_LIMIT
        return count + (isBelowSizeLimit ? 1 : 0)
      }, 0) ?? 0
  // add up all the small-amount htlcs in the channel htlc is asking to go to
  const outboundSmallSizeCount = isBelowLimit
    ? -1
    : byChannel[f.out_channel]?.raw?.reduce((count, pending) => {
        const isBelowSizeLimit = pending.tokens < SATS_LIMIT
        return count + (isBelowSizeLimit ? 1 : 0)
      }, 0) ?? 0

  // allow at least ALLOWED_PER_GROUP_MIN htlcs per group, and then depending on group and direction maybe more
  const inboundFeeGroupLimit = max(ALLOWED_PER_GROUP_MIN, ALLOWED_PER_GROUP_IN(group))
  const outboundFeeGroupLimit = max(ALLOWED_PER_GROUP_MIN, ALLOWED_PER_GROUP_OUT(group))

  // check if for this fee group there's enough available slots in both incoming and outgoing channel for request
  const allowedBasedOnFee = inboundFeeGroupCount < inboundFeeGroupLimit && outboundFeeGroupCount < outboundFeeGroupLimit

  // if below limit, check if there's enough available slots for below limit htlcs in incoming and outgoing channels (above sat limit is always true)
  const allowedBasedOnSize =
    !isBelowLimit ||
    (inboundSmallSizeCount < ALLOWED_BELOW_LIMIT_IN && outboundSmallSizeCount < ALLOWED_BELOW_LIMIT_OUT)

  // if both conditions pass, allow htlc
  const allowed = allowedBasedOnFee && allowedBasedOnSize

  // DEBUG &&
  //   printout(
  //     stringify(
  //       {
  //         isBelowLimit,
  //         inboundFeeGroupCount,
  //         outboundFeeGroupCount,
  //         inboundFeeGroupLimit,
  //         outboundFeeGroupLimit,
  //         inboundSmallSizeCount,
  //         outboundSmallSizeCount,
  //         group,
  //         allowedBasedOnFee,
  //         allowedBasedOnSize
  //       },
  //       fixJSON
  //     )
  //   )

  // snapshots aren't updated real time, so we update counts for tx we allow manually
  if (allowed) {
    // this htlc will be in 2 channels so add to their counters
    if (!byChannel[f.in_channel]) byChannel[f.in_channel] = {}
    if (!byChannel[f.out_channel]) byChannel[f.out_channel] = {}
    byChannel[f.in_channel][group] = inboundFeeGroupCount + 1
    byChannel[f.out_channel][group] = outboundFeeGroupCount + 1
    pendingForwardCount += 2
    outgoingCount++
    incomingCount++
  }

  const result = allowed ? f.accept() : f.reject()

  showLogs && announce(f, allowed)

  return result // result
}

// loop that updates all channel unsettled tx counts & more rarely checks fee policy
const updatePendingCounts = async ({ subForwardRequests, showLogs }) => {
  // stop signal check
  if (limiterProcess.stop) return printout('stop signal detected') // terminate loop

  // occasionally update fee per channel data
  if (Date.now() - lastPolicyCheck > FEE_UPDATE_DELAY) {
    // clean up previous data & log ram use (rarely)
    global?.gc?.()
    // showLogs && MAX_RAM_USE_MB && getMemoryUsage()

    // fee rates in case any changed
    const gotFeeRates = await bos.callAPI('getFeeRates', { auth: node.auth })

    if (gotFeeRates) {
      const feeRates = gotFeeRates.channels?.reduce((final, channel) => {
        final[channel.id] = channel
        return final
      }, {})

      if (feeRates) {
        node.policies = feeRates
        // move up last fee rate policy timestamp
        lastPolicyCheck = Date.now()

        // grab aliases for convinient logging
        const peers = (await bos.peers({})) || []
        peers.forEach(peer => {
          keyToAlias[peer.public_key] = ca(peer.alias)
        })

        DEBUG && printout('fee rates & aliases parsed')
      }
    }
  }

  // main goal is to see all existing unsettled htlcs in each channel every time this loops
  const res = await bos.callAPI('getChannels')
  // if lnd issue, keep trying until fixed and then reinitialize
  if (!res) {
    showLogs && printout(`lnd unavailable, retrying in ${LND_CHECK_DELAY} ms`)
    await sleep(LND_CHECK_DELAY)
    subForwardRequests.removeAllListeners()
    initialize(showLogs)
    // stop looping updatePendingCounts
    return null
  }

  const channels = res?.channels || []
  pendingOtherCount = 0
  pendingForwardCount = 0
  outgoingCount = 0
  incomingCount = 0
  for (const channel of channels) {
    idToKey[channel.id] = channel.partner_public_key
    byChannel[channel.id] = { raw: copy(channel.pending_payments) }
    for (const f of channel.pending_payments) {
      const group = getGroup(getFee(f, true, channel.id))
      byChannel[channel.id][group] = (byChannel[channel.id][group] || 0) + 1
      if (f.is_forward) pendingForwardCount++
      else pendingOtherCount++
      if (f.is_outgoing) outgoingCount++
      else incomingCount++
    }
  }

  DEBUG && printout(`${channels.length} channels parsed`)
  if (DEBUG && MAX_RAM_USE_MB) getMemoryUsage()

  // console.log({ idToKey, keyToAlias })
  await sleep(UPDATE_DELAY)

  // loop
  setImmediate(() => updatePendingCounts({ subForwardRequests, showLogs }))
}

const getSats = f => f.tokens // get sats routed
const getFee = (f, channelUpdate = false, foundId = null) => {
  let fee = 0

  // if fee known (as usually is in events) use that
  if (f.fee_mtokens !== undefined) return (+f.fee_mtokens || 0) / 1000

  // if not a forward with a clear outgoing channel put it into default fee group
  if (f.is_forward) {
    const outgoingChannelId = f.out_channel ?? foundId

    if (!node.policies[outgoingChannelId]) {
      // DEBUG && printout('no policy found', stringify(f, fixJSON), `found in channel ${foundId}`, `using fee ${fee}`)
      return fee
    }

    const fee_rate = node.policies[outgoingChannelId]?.fee_rate || 0
    const base_fee = (+node.policies[outgoingChannelId]?.base_fee_mtokens || 0) / 1000
    fee = fee_rate * 1e-6 * f.tokens + base_fee
  }

  // DEBUG && printout('getFee', stringify(f, fixJSON), stringify({ foundId, fee }))

  return fee
}

const announce = (f, isAccepted) => {
  printout(
    isAccepted ? 'accepted htlc' : 'rejected htlc',
    `${getSats(f)}`.padStart(10),
    ' amt, ',
    `${getFee(f).toFixed(3)}`.padStart(9),
    ' fee ',
    `~2^${getGroup(getFee(f))}`.padStart(7),
    (keyToAlias[idToKey[f.in_channel]] || f.in_channel).slice(0, 20).padStart(20),
    '->',
    (keyToAlias[idToKey[f.out_channel]] || f.out_channel).slice(0, 20).padEnd(20),
    `all: {is_forward: ${pendingForwardCount}, other: ${pendingOtherCount}, out: ${outgoingCount}, in: ${incomingCount}}`,
    f.in_channel.padStart(15),
    stringify({ ...byChannel[f.in_channel], raw: undefined }),
    '->',
    f.out_channel.padEnd(15),
    stringify({ ...byChannel[f.out_channel], raw: undefined }),
    limiterProcess.stop ? '(stopped)' : ''
  )
}

const sleep = async ms => await new Promise(resolve => setTimeout(resolve, ms))
const getDate = timestamp => (timestamp ? new Date(timestamp) : new Date()).toISOString()
const printout = (...args) => {
  // print async when possible
  setImmediate(() => {
    process.stdout.write(`\x1b[2m${getDate()} htlcLimiter() ${args.join(' ')}\x1b[0m\n`)
  })
}

const getMemoryUsage = ({ quiet = false } = {}) => {
  const memUse = process.memoryUsage()
  const heapTotal = +(memUse.heapTotal / 1024 / 1024).toFixed(0)
  const heapUsed = +(memUse.heapUsed / 1024 / 1024).toFixed(0)
  const external = +(memUse.external / 1024 / 1024).toFixed(0)
  const rss = +(memUse.rss / 1024 / 1024).toFixed(0)

  if (!quiet) {
    printout(
      `memory: ${heapTotal} heapTotal & ${heapUsed} MB heapUsed & ${external} MB external & ${rss} MB resident set size.`
    )
  }

  if (MAX_RAM_USE_MB && heapUsed > MAX_RAM_USE_MB) {
    console.log(`${getDate()} htlcLimiter heapUsed hit memory limit of ${MAX_RAM_USE_MB} & terminating`)
    process.exit(1)
  }
  return { heapTotal, heapUsed, external, rss }
}

const ca = alias => alias.replace(/[^\x00-\x7F]/g, '').trim()
// const fixJSON = (k, v) => (v === undefined ? null : v)
const copy = item => parse(stringify(item))

export default initialize
// initialize() // comment out above line & uncomment this to run from terminal via: node htlcLimiter
