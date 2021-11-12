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
import lnd from 'balanceofsatoshis/lnd/index.js'
import bos from './bos.js'
const { log2, floor, max } = Math
const mylnd = async () => (await lnd.authenticatedLnd({})).lnd

const DEBUG = false

const UPDATE_DELAY = 10 * 1000 // ms between updating active count, effectively rate limiter
const FEE_UPDATE_DELAY = 62 * 60 * 1000 // ms between updating channel policies
const LND_CHECK_DELAY = 2 * 60 * 1000 // ms between retrying lnd if issue

// fee group settings
const MIN_ORDER_OF_MAGNITUDE = 0 // lowest 2^_ fee group possible
const ALLOWED_PER_GROUP_MIN = 2 // smallest amount of htlcs allowed per fee group
const ALLOWED_PER_GROUP_IN = group => group // how many incoming htlcs allowed per fee group
const ALLOWED_PER_GROUP_OUT = group => group * 2 // how many outgoing htlcs allowed per fee group

// unsettled sats per htlc settings
const SATS_LIMIT = 10000 // can limit # of htlc below this size of sats unsettled, 0 would mean unused
const ALLOWED_BELOW_LIMIT_IN = 2 // at most _ utxo<SATS_LIMIT should end up being settled on chain out of inward ones
const ALLOWED_BELOW_LIMIT_OUT = 4 // at most _ utxo<SATS_LIMIT should end up being settled on chain out of outward ones

// internal
const limiterProcess = { stop: false } // process handler to prepare to stop node
const byChannel = {}
const node = { policies: {} }
let pendingOtherCount = 0
let pendingForwardCount = 0
let outgoingCount = 0
let incomingCount = 0
let lastPolicyCheck = 0

// get order of magnitude group number from sats
// pow of 2 better for fees which have smaller range than good for pow of 10
const getGroup = s => max(floor(log2(s)), MIN_ORDER_OF_MAGNITUDE)

const getSats = f => f.tokens // get sats routed
const getFee = (f, channelUpdate = false, foundId = null) => {
  let fee = 0

  // if fee known (as usually is in events) use that
  if (f.fee_mtokens !== undefined) return (+f.fee_mtokens || 0) / 1000

  // if not a forward with a clear outgoing channel put it into default fee group
  if (f.is_forward) {
    const outgoingChannelId = f.out_channel ?? foundId
    const fee_rate = node.policies[outgoingChannelId]?.fee_rate || 0
    const base_fee = (+node.policies[outgoingChannelId]?.base_fee_mtokens || 0) / 1000
    fee = fee_rate * 1e-6 * f.tokens + base_fee

    !node.policies[outgoingChannelId] &&
      printout('no policy found', JSON.stringify(f, fixJSON), JSON.stringify({ foundId }))
  }

  // DEBUG && printout('getFee', JSON.stringify(f, fixJSON), JSON.stringify({ foundId, fee }))

  return fee
}

// starts everything
const initialize = async ({ showLogs = true } = {}) => {
  showLogs && printout('()')
  const authed = await mylnd()
  const subForwardRequests = subscribeToForwardRequests({ lnd: authed })

  subForwardRequests.on('forward_request', f => {
    // DEBUG && printout('new request', JSON.stringify({ ...f, onion: undefined, hash: f.hash?.slice(0, 5) }, fixJSON))
    return decideOnForward({ f, showLogs })
  })

  updatePendingCounts({ subForwardRequests, showLogs })
  showLogs && printout('initialized')
  return limiterProcess
}

// decide to allow or block forward request
const decideOnForward = ({ f, showLogs }) => {
  if (limiterProcess.stop) return f.reject() // if stop all new forwards

  const group = getGroup(getFee(f))

  // how many unsettled in this fee group
  const inboundFeeGroupCount = byChannel[f.in_channel]?.[group] ?? 0
  const outboundFeeGroupCount = byChannel[f.out_channel]?.[group] ?? 0

  // count unsettled htlcs below amount of sats unsettled for in and out
  // only matters if below limit
  const isBelowLimit = f.tokens < SATS_LIMIT
  const inboundSmallSizeCount = isBelowLimit
    ? -1
    : byChannel[f.in_channel]?.raw?.reduce((count, pending) => {
        const isBelowSizeLimit = pending.tokens < SATS_LIMIT
        return count + isBelowSizeLimit ? 1 : 0
      }, 0) ?? 0
  const outboundSmallSizeCount = isBelowLimit
    ? -1
    : byChannel[f.out_channel]?.raw?.reduce((count, pending) => {
        const isBelowSizeLimit = pending.tokens < SATS_LIMIT
        return count + isBelowSizeLimit ? 1 : 0
      }, 0) ?? 0

  // 2 or more htlcs allowed per channel, more for larger fee groups, more for outgoing
  const inboundFeeGroupLimit = max(ALLOWED_PER_GROUP_MIN, ALLOWED_PER_GROUP_IN(group))
  const outboundFeeGroupLimit = max(ALLOWED_PER_GROUP_MIN, ALLOWED_PER_GROUP_OUT(group))

  const allowedBasedOnFee = inboundFeeGroupCount < inboundFeeGroupLimit && outboundFeeGroupCount < outboundFeeGroupLimit

  const allowedBasedOnSize =
    !isBelowLimit ||
    (inboundSmallSizeCount < ALLOWED_BELOW_LIMIT_IN && outboundSmallSizeCount < ALLOWED_BELOW_LIMIT_OUT)

  const allowed = allowedBasedOnFee && allowedBasedOnSize

  DEBUG &&
    printout(
      JSON.stringify(
        {
          isBelowLimit,
          inboundFeeGroupCount,
          outboundFeeGroupCount,
          inboundFeeGroupLimit,
          outboundFeeGroupLimit,
          inboundSmallSizeCount,
          outboundSmallSizeCount,
          group,
          allowedBasedOnFee,
          allowedBasedOnSize
        },
        fixJSON
      )
    )

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

  return result
}

// loop that updates all channel unsettled tx counts & more rarely checks fee policy
const updatePendingCounts = async ({ subForwardRequests, showLogs }) => {
  if (limiterProcess.stop) return printout('stop signal detected') // terminate loop

  // occasionally update fee per channel data
  if (Date.now() - lastPolicyCheck > FEE_UPDATE_DELAY) {
    // node.policies = (await bos.getNodeChannels()) || node.policies

    const gotFeeRates = await bos.callAPI('getFeeRates')

    if (gotFeeRates) {
      const feeRates = gotFeeRates.channels?.reduce((final, channel) => {
        final[channel.id] = channel
        return final
      }, {})

      if (feeRates) {
        node.policies = feeRates
        lastPolicyCheck = Date.now()
        DEBUG && printout('fee rates updated')
      }

      // global?.gc?.()
    }
  }

  // main goal is to see all existing unsettled htlcs in each channel every time this loops
  let res = await bos.callAPI('getChannels')
  // if lnd issue, keep trying until fixed and then reinitialize
  while (!res) {
    showLogs && printout(`lnd unavailable, retrying in ${LND_CHECK_DELAY} ms`)
    await sleep(LND_CHECK_DELAY)

    if (limiterProcess.stop) return printout('stop signal detected') // terminate loop

    res = await bos.callAPI('getChannels')
    if (res?.channels?.some(c => c.is_active)) {
      // at least one channel active so fixed, stop previous listener
      subForwardRequests.removeAllListeners()
      // start new ones
      showLogs && printout('lnd reached, re-initializing')
      initialize({ showLogs })
      // this loop ends, new one comes from initialize call
      return null
    }
  }
  const channels = res?.channels || []
  pendingOtherCount = 0
  pendingForwardCount = 0
  outgoingCount = 0
  incomingCount = 0
  for (const channel of channels) {
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

  await sleep(UPDATE_DELAY)

  // showLogs && printMemoryUsage()

  // loop
  // setImmediate(() =>
  updatePendingCounts({ subForwardRequests, showLogs })
  // )
}

const announce = (f, isAccepted) => {
  printout(
    isAccepted ? 'accepted new htlc' : 'rejected new htlc',
    `${getSats(f)}`.padStart(10),
    ' amt, ',
    `${getFee(f).toFixed(3)}`.padStart(9),
    ' fee ',
    `~2^${getGroup(getFee(f))}`.padStart(7),
    f.in_channel.padStart(15),
    '->',
    f.out_channel.padEnd(15),
    `all: {is_forward: ${pendingForwardCount}, other: ${pendingOtherCount}, out: ${outgoingCount}, in: ${incomingCount}}`,
    'in:',
    JSON.stringify({ ...byChannel[f.in_channel], raw: undefined }),
    'out:',
    JSON.stringify({ ...byChannel[f.out_channel], raw: undefined }),
    limiterProcess.stop ? '(stopped)' : ''
  )
}

const sleep = async ms => await new Promise(resolve => setTimeout(resolve, ms))
const getDate = timestamp => (timestamp ? new Date(timestamp) : new Date()).toISOString()
const printout = (...args) => {
  // print async when possible
  setImmediate(() => {
    console.log(`\x1b[2m${getDate()} htlcLimiter ${args.join(' ')}\x1b[0m`)
  })
}

// const printMemoryUsage = (text = '') => {
//   // if (random() > 0.2) return null

//   const memUse = process.memoryUsage()
//   const total = (memUse.heapTotal / 1024 / 1024).toFixed(1)
//   const used = (memUse.heapUsed / 1024 / 1024).toFixed(1)
//   const external = (memUse.external / 1024 / 1024).toFixed(1)

//   printout(`memory: ${total} heapTotal & ${used} MB heapUsed & ${external} MB external. ${text}`)
// }

const fixJSON = (k, v) => (v === undefined ? null : v)
const copy = item => JSON.parse(JSON.stringify(item))

export default initialize // uncomment this to import
// initialize() // OR uncomment this to run from terminal
