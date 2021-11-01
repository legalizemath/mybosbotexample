/*

Limits # of htlcs in each channel

Script periodically checks pending htlcs in channels and fee policy in channels.

In parallel in watches for forwarding requests.
It gets fee from either forwarding request or getChannels response & calculates it via policies.
It then gets which power of 2 range fee is.
It looks at how many pending htlcs are already in this fee range in request's incoming & outgoing channels
If # of htlcs for incoming channel is below some number (e.g. 2)
and if # of htlcs for outgoing channel is below some number (e.g. 4)
it grants the request, otherwise rejects

The rate of getChannels updates is rate at which granted request counts are cleared, so also acts as rate limiter.

*/

import { subscribeToForwardRequests } from 'balanceofsatoshis/node_modules/ln-service/index.js'
import lnd from 'balanceofsatoshis/lnd/index.js'
import bos from './bos.js'
const { log2, floor, max } = Math

const mylnd = async () => (await lnd.authenticatedLnd({})).lnd

const UPDATE_DELAY = 5 * 1000 // ms between updating active count, effectively rate limiter
const FEE_UPDATE_DELAY = 60 * 60 * 1000 // ms between updating channel policies
const LND_CHECK_DELAY = 42 * 1000 // ms between retrying lnd if issue
const MIN_ORDER_OF_MAGNITUDE = 0 // lowest group possible

const byChannel = {}
const node = { policies: {} }

// get order of magnitude group number from sats
// pow of 2 better for fees which have smaller range than good for pow of 10
const getGroup = s => max(floor(log2(s)), MIN_ORDER_OF_MAGNITUDE)

const getSats = f => f.tokens // get sats routed
const getFee = f => {
  if (f.fee_mtokens !== undefined) return (+f.fee_mtokens || 0) / 1000
  if (f.is_forward) {
    const fee_rate = node.policies[f.out_channel]?.local?.fee_rate || 0
    const base_fee = (+node.policies[f.out_channel]?.local?.base_fee_mtokens || 0) / 1000
    return fee_rate * 1e-6 * f.tokens + base_fee
  }
  return 0
}

// decide to allow or block forward request
const decideOnForward = ({ f }) => {
  const group = getGroup(getFee(f))

  const inboundPending = byChannel[f.in_channel]?.[group] ?? 0
  const outboundPending = byChannel[f.out_channel]?.[group] ?? 0

  // 2 or more htlcs allowed per channel, more for outgoing
  const inboundLimit = max(2, group)
  const outboundLimit = max(2, group * 2)

  const allowed = inboundPending < inboundLimit && outboundPending < outboundLimit

  if (allowed) {
    f.accept()
    byChannel[f.in_channel][group] = inboundPending + 1
    byChannel[f.out_channel][group] = outboundPending + 1
    pendingForwardCount += 2
  } else {
    f.reject()
  }

  return allowed
}

let pendingPaymentCount = 0
let pendingForwardCount = 0
let lastPolicyCheck = 0

const initialize = async ({ showLogs = true } = {}) => {
  const authed = await mylnd()
  const subForwardRequests = subscribeToForwardRequests({ lnd: authed })

  subForwardRequests.on('forward_request', f => {
    const allowed = decideOnForward({ f })
    showLogs && say(f, allowed)
  })

  updatePendingCounts({ subForwardRequests, showLogs })
  mention(`${getDate()} htlcLimiter() initialized`)
}

const updatePendingCounts = async ({ subForwardRequests, showLogs }) => {
  let res = await bos.callAPI('getChannels')
  // if lnd issue, keep trying until fixed and then reinitialize
  while (!res) {
    showLogs && mention(`${getDate()} htlcLimiter() lnd unavailable, retrying in ${LND_CHECK_DELAY} ms`)
    await sleep(LND_CHECK_DELAY)
    res = await bos.callAPI('getChannels')
    if (res?.channels?.some(c => c.is_active)) {
      // at least one channel active so fixed, stop previous listener
      subForwardRequests.removeAllListeners()
      // start new ones
      initialize({ showLogs })
      // this update loop will be replaced
      return null
    }
  }
  const channels = res?.channels || []
  pendingPaymentCount = 0
  pendingForwardCount = 0
  for (const channel of channels) {
    byChannel[channel.id] = {}
    for (const f of channel.pending_payments) {
      const group = getGroup(getFee(f))
      byChannel[channel.id][group] = (byChannel[channel.id][group] || 0) + 1
      if (f.is_forward) pendingForwardCount++
      else pendingPaymentCount++

      // if (f.is_forward) console.log(f)
    }
  }

  // occasionally update fee per channel data
  if (Date.now() - lastPolicyCheck > FEE_UPDATE_DELAY) {
    node.policies = (await bos.getNodeChannels()) || node.policies
    lastPolicyCheck = Date.now()
  }

  await sleep(UPDATE_DELAY)
  updatePendingCounts({ subForwardRequests, showLogs })
}

const say = (f, isAccepted) =>
  mention(
    `${getDate()}`,
    isAccepted ? 'accepted new htlc' : 'rejected new htlc',
    `${getSats(f)}`.padStart(10),
    ' amt, ',
    `${getFee(f).toFixed(3)}`.padStart(9),
    ' fee, ',
    `~2^${getGroup(getFee(f))}`.padStart(7),
    f.in_channel.padStart(15),
    '->',
    f.out_channel.padEnd(15),
    `(paying ${pendingPaymentCount}, forwarding ${pendingForwardCount})  in & out:`,
    JSON.stringify(byChannel[f.in_channel]),
    '&',
    JSON.stringify(byChannel[f.out_channel])
  )
const sleep = async ms => await new Promise(resolve => setTimeout(resolve, ms))
const getDate = timestamp => (timestamp ? new Date(timestamp) : new Date()).toISOString()
const mention = (...args) => console.log(`\x1b[2m${args.join(' ')}\x1b[0m`)

// export default initialize // uncomment this to import
initialize() // OR uncomment this to run from terminal
