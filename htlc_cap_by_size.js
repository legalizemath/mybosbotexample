import { subscribeToForwardRequests } from 'balanceofsatoshis/node_modules/ln-service/index.js'
import lnd from 'balanceofsatoshis/lnd/index.js'
import bos from './bos.js'
const { log10, floor } = Math

const mylnd = async () => (await lnd.authenticatedLnd({})).lnd

const updatePendingStateTimer = 10 * 1000 // update pending counts every _ ms
const maxPerGroup = 2 // max htlc per order of magnitude
const byChannel = {}
let totalCount = 0

const initialize = async () => {
  const authed = await mylnd()
  const subForwardRequests = subscribeToForwardRequests({ lnd: authed })
  subForwardRequests.on('forward_request', f => {
    const group = getGroup(f.tokens)
    const inputChannelOk = (byChannel[f.in_channel]?.[group] ?? 0) < maxPerGroup
    const outputChannelOk = (byChannel[f.out_channel]?.[group] ?? 0) < maxPerGroup
    const ok = inputChannelOk && outputChannelOk
    if (ok) f.accept()
    else f.reject()
    say(f, ok)
  })
  updatePendingCounts()
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
  console.log(
    isAccepted ? 'htlc accepted' : 'htlc rejected',
    f.in_channel,
    JSON.stringify(byChannel[f.in_channel]),
    '->',
    f.out_channel,
    JSON.stringify(byChannel[f.out_channel]),
    totalCount
  )
const sleep = async ms => await new Promise(resolve => setTimeout(resolve, ms))

initialize()
