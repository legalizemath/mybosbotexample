import { subscribeToForwardRequests } from 'balanceofsatoshis/node_modules/ln-service/index.js'
import lnd from 'balanceofsatoshis/lnd/index.js'
import bos from './bos.js'
const { log10, floor, max } = Math

const mylnd = async () => (await lnd.authenticatedLnd({})).lnd

const UPDATE_DELAY = 5 * 1000 // ms between updating active count, effectively rate limiter
const FEE_UPDATE_DELAY = 60 * 60 * 1000 // ms between updating channel policies
const LND_CHECK_DELAY = 42 * 1000 // ms between retrying lnd if issue
const MIN_ORDER_OF_MAGNITUDE = 0 // lowest group possible

const byChannel = {}
const node = { policies: {} }

// get order of magnitude group number from sats
const getGroup = s => max(floor(log10(s)), MIN_ORDER_OF_MAGNITUDE)
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

// return max number of htlcs allowed for each size range
const maxForGroup = group => {
  if (group <= 1) return 2
  return group * 2
}

let pendingPaymentCount = 0
let pendingForwardCount = 0
let lastPolicyCheck = 0

const initialize = async ({ showLogs = true } = {}) => {
  const authed = await mylnd()
  const subForwardRequests = subscribeToForwardRequests({ lnd: authed })

  subForwardRequests.on('forward_request', f => {
    const group = getGroup(getFee(f))
    const inputChannelN = byChannel[f.in_channel]?.[group] ?? 0
    const outputChannelN = byChannel[f.out_channel]?.[group] ?? 0
    const ok = inputChannelN < maxForGroup(group) && outputChannelN < maxForGroup(group)
    if (ok) {
      f.accept()
      byChannel[f.in_channel][group] = inputChannelN + 1
      byChannel[f.out_channel][group] = outputChannelN + 1
      pendingForwardCount += 2
    } else {
      f.reject()
    }
    showLogs && say(f, ok)
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
    `~1e${getGroup(getFee(f))}`.padStart(7),
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
