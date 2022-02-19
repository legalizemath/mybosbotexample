// logs peer disconnects/connects and graph policy updates (fee rates n stuff) in our channels
// also logs forwarding successes and failures w/ reason if provided

import bos from './bos.js'
const { lnService } = bos

const run = async () => {
  const lnd = await bos.initializeAuth()
  const { public_key } = await lnService.getIdentity({ lnd })
  const publicKeyToAlias = await bos.getPublicKeyToAliasTable()
  const idToAlias = await bos.getIdToAliasTable()

  let lastPolicies = await bos.getNodeChannels()

  // subscriptions
  const graphEvents = await lnService.subscribeToGraph({ lnd })
  const peerEvents = await lnService.subscribeToPeers({ lnd })
  const forwardEvents = await lnService.subscribeToForwards({ lnd })

  // what to do on events for graph (that includes my node)
  graphEvents.on('channel_updated', async update => {
    if (!update.public_keys.includes(public_key)) return null
    const remote_key = update.public_keys.find(v => v !== public_key)
    const [announcing_key] = update.public_keys // first key announces
    const whoUpdated = announcing_key === public_key ? 'local' : 'remote'
    // get this side's last state
    const before = lastPolicies[update.id]?.[whoUpdated]

    // summarize changes
    const updates = []
    for (const prop of [
      'base_fee_mtokens',
      'cltv_delta',
      'fee_rate',
      'is_disabled',
      'max_htlc_mtokens',
      'min_htlc_mtokens',
      'updated_at'
    ]) {
      if (before?.[prop] !== update[prop]) updates.push(`${prop}: ${before?.[prop]} -> ${update[prop]}`)
    }
    log(`📣 ${whoUpdated} update for peer`, publicKeyToAlias[remote_key], remote_key, '\n ', updates.join('\n  '), '\n')
    // update policy data
    lastPolicies = await bos.getNodeChannels()
  })
  graphEvents.on('error', () => {
    log('peer events error')
  })

  // what to do on events for peers
  peerEvents.on('connected', update => {
    log(`💚 connected to ${publicKeyToAlias[update.public_key] ?? 'unknown'}`, update.public_key)
  })
  peerEvents.on('disconnected', update => {
    log(`⛔ disconnected from ${publicKeyToAlias[update.public_key] ?? 'unknown'}`, update.public_key)
  })
  peerEvents.on('error', () => {
    log('peer events error')
  })

  // what to do for forwards
  const pastForwardEvents = {}
  forwardEvents.on('forward', f => {
    // have to store forwarding events amounts
    const fid = `${f.in_channel} ${f.in_payment} ${f.out_channel} ${f.out_payment}`
    if (!pastForwardEvents[fid]) pastForwardEvents[fid] = {}
    if (f.mtokens) pastForwardEvents[fid].mtokens = f.mtokens
    if (f.fee_mtokens) pastForwardEvents[fid].fee_mtokens = f.fee_mtokens
    // try to get amount from previous events bc geniuses didn't include that every time
    const mtokens = f.mtokens ?? pastForwardEvents[fid]?.mtokens
    const fee_mtokens = f.fee_mtokens ?? pastForwardEvents[fid]?.fee_mtokens

    const from = idToAlias[f.in_channel] ?? f.in_channel ?? 'n/a'
    const to = idToAlias[f.out_channel] ?? f.out_channel ?? 'n/a'
    const amt = mtokens !== undefined ? `${(+mtokens / 1000).toFixed(3)} sats` : 'n/a'
    const fee = fee_mtokens !== undefined ? `${(+fee_mtokens / 1000).toFixed(3)} sats fee` : 'n/a'
    if (f.is_failed) {
      if (f.external_failure || f.internal_failure) {
        log(`🚨 forwarding failure: ${from} -> ${to} of ${amt} for ${fee}`)
        if (f.external_failure && f.external_failure !== 'NO_DETAIL') log('  🤡 external failure:', f.external_failure)
        if (f.internal_failure && f.internal_failure !== 'NO_DETAIL') log('  💩 internal failure:', f.internal_failure)
      } else {
        // no reason = likely just canceled, not worth showing
        // log(`\x1b[2m⚠ forwarding failure w/o reason: ${from} -> ${to} of ${amt} for ${fee}\x1b[0m`)
      }
      delete pastForwardEvents[fid] // clear up memory
      return null
    }
    if (f.is_confirmed) {
      log(`⚡ forwarding success: ${from} -> ${to} of ${amt} for ${fee}`)
      delete pastForwardEvents[fid] // clear up memory
      return null
    }
    // log(`🕐 forwarding pending: ${from} -> ${to} of ${amt} for ${fee}`)
  })
  forwardEvents.on('error', () => {
    log('forward events error')
  })

  log('listening for events...\n')
}
const log = (...args) => setImmediate(() => console.log(getDate(), args.join(' ')))
const getDate = () => new Date().toISOString().replace('T', ' ').replace('Z', '')
run()
