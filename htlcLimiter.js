import { subscribeToForwardRequests } from 'balanceofsatoshis/node_modules/ln-service/index.js'
import lnd from 'balanceofsatoshis/lnd/index.js'
import bos from './bos.js'
const { log10, floor } = Math

const mylnd = async () => (await lnd.authenticatedLnd({})).lnd

const updatePendingStateTimer = 10 * 1000 // update pending counts every _ ms
const maxPerGroup = 2 // max htlc per order of magnitude
const byChannel = {}
let totalCount = 0

const initialize = async ({ showLogs = false } = {}) => {
  const authed = await mylnd()
  const subForwardRequests = subscribeToForwardRequests({ lnd: authed })
  subForwardRequests.on('forward_request', f => {
    const group = getGroup(f.tokens)
    const inputChannelN = byChannel[f.in_channel]?.[group] ?? 0
    const outputChannelN = byChannel[f.out_channel]?.[group] ?? 0
    const ok = inputChannelN < maxPerGroup && outputChannelN < maxPerGroup
    if (ok) {
      byChannel[f.in_channel][group] = inputChannelN + 1
      byChannel[f.out_channel][group] = outputChannelN + 1
      f.accept()
    } else {
      f.reject()
    }
    showLogs && say(f, ok)
  })
  updatePendingCounts()
  mention(`${getDate()} htlcLimiter() initiated`)
}

const updatePendingCounts = async () => {
  const channels = (await bos.callAPI('getChannels'))?.channels || []
  totalCount = 0
  for (const channel of channels) {
    byChannel[channel.id] = {}
    for (const htlc of channel.pending_payments) {
      const group = getGroup(htlc.tokens)
      byChannel[channel.id][group] = (byChannel[channel.id][group] || 0) + 1
      totalCount++
    }
  }
  await sleep(updatePendingStateTimer)
  updatePendingCounts()
}

// get order of magnitude for routed amount
const getGroup = v => floor(log10(v))
const say = (f, isAccepted) =>
  mention(
    `${getDate()}`,
    isAccepted ? 'accepted new htlc' : 'rejected new htlc',
    `1e${getGroup(f.tokens)}`.padStart(4),
    f.in_channel.padStart(15),
    '->',
    f.out_channel.padEnd(15),
    `in flight total: ${totalCount}, in & out:`,
    JSON.stringify(byChannel[f.in_channel]),
    JSON.stringify(byChannel[f.out_channel])
  )
const sleep = async ms => await new Promise(resolve => setTimeout(resolve, ms))
const getDate = timestamp => (timestamp ? new Date(timestamp) : new Date()).toISOString()
const mention = (...args) => console.log(`\x1b[2m${args.join(' ')}\x1b[0m`)

export default initialize
// initialize()
