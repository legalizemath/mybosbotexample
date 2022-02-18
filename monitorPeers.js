// logs peer disconnects/connects and graph policy updates (fee rates n stuff) in our channels

import bos from './bos.js'
const { lnService } = bos

const run = async () => {
  const lnd = await bos.initializeAuth()
  const { public_key } = await lnService.getIdentity({ lnd })
  const publicKeyToAlias = await bos.getPublicKeyToAliasTable()

  let lastPolicies = await bos.getNodeChannels()

  // subscriptions
  const graphEvents = await lnService.subscribeToGraph({ lnd })
  const peerEvents = await lnService.subscribeToPeers({ lnd })

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

  // what to do on events for peers
  peerEvents.on('connected', update => {
    log(`💚 connected: ${publicKeyToAlias[update.public_key] ?? 'unknown'}`, update.public_key)
  })
  peerEvents.on('disconnected', update => {
    log(`⛔ disconnected: ${publicKeyToAlias[update.public_key] ?? 'unknown'}`, update.public_key)
  })

  log('listening for events...\n')
}
const log = (...args) => console.log(getDate(), args.join(' '))
const getDate = () => new Date().toISOString().replace('T', ' ').replace('Z', '')
run()
