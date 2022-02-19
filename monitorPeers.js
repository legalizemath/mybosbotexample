// logs peer disconnects/connects and graph policy updates (fee rates n stuff) in our channels
// also logs forwarding successes and failures w/ reason if provided

import fs from 'fs'
import bos from './bos.js'
const { lnService } = bos

// --- settings ---

const LOG_FILE_PATH = 'events.log'

// this filters what htlc fail events will be shown
const WHEN_LOG_FAILED_HTLCS = forward =>
  // must have reason or no point displaying
  (forward.external_failure || forward.internal_failure) &&
  // no probes
  forward.internal_failure !== 'UNKNOWN_INVOICE'

// shows forwards that confirm
const LOG_SUCCESSFUL_FORWARDS = false

// sometimes just timestamp is updated, this ignores those gossip updates
const IGNORE_GOSSIP_UPDATES_WITHOUT_SETTING_CHANGES = true

// --- end of settings  ---

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
    // https://github.com/alexbosworth/ln-service#subscribetograph
    const updates = []
    const changes = {}
    for (const prop of [
      'base_fee_mtokens',
      'cltv_delta',
      'fee_rate',
      'is_disabled',
      'max_htlc_mtokens',
      'min_htlc_mtokens',
      'updated_at'
    ]) {
      if (before?.[prop] !== update[prop]) {
        updates.push(`${prop}: ${pretty(before?.[prop])} -> ${pretty(update[prop])}`)
        changes[prop] = true
      }
    }
    if (IGNORE_GOSSIP_UPDATES_WITHOUT_SETTING_CHANGES && updates.length <= 1) return null // just updated timestamp changed

    // check if peer is online if disable status changed
    const peer = changes.is_disabled ? (await bos.peers({}))?.find(p => p.public_key === remote_key) : null
    const offlineStatus = !peer ? '' : peer.is_offline ? '(offline)' : '(online)'

    log(
      `📣 ${whoUpdated} update for peer`,
      publicKeyToAlias[remote_key],
      remote_key,
      offlineStatus,
      '\n   ',
      updates.join('\n    ')
    )

    // update policy data
    lastPolicies = await bos.getNodeChannels()
  })
  graphEvents.on('error', () => {
    log('peer events error')
    process.exit(1)
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
    process.exit(1)
  })

  // what to do for forwards
  const pastForwardEvents = {}
  forwardEvents.on('forward', f => {
    // have to store forwarding events amounts under unique id
    // if just starting to listen, likely will be missing past payment information
    const fid = `${f.in_channel} ${f.in_payment} ${f.out_channel} ${f.out_payment}`
    if (!pastForwardEvents[fid]) pastForwardEvents[fid] = {}
    if (f.mtokens) pastForwardEvents[fid].mtokens = f.mtokens
    if (f.fee_mtokens) pastForwardEvents[fid].fee_mtokens = f.fee_mtokens

    // try to get amount from previous events bc geniuses didn't include that every time
    const mtokens = f.mtokens ?? pastForwardEvents[fid]?.mtokens
    const fee_mtokens = f.fee_mtokens ?? pastForwardEvents[fid]?.fee_mtokens

    const from = idToAlias[f.in_channel] ?? f.in_channel ?? 'n/a'
    const to = idToAlias[f.out_channel] ?? f.out_channel ?? 'n/a'
    const amt = mtokens !== undefined ? `${pretty(+mtokens / 1000, 3)} sats` : 'n/a'
    const fee = fee_mtokens !== undefined ? `${pretty(+fee_mtokens / 1000, 3)} sats fee` : 'n/a'

    // done: failures
    if (f.is_failed) {
      // this checks rule on which forwards to show
      if (WHEN_LOG_FAILED_HTLCS(f)) {
        const msg = [`🚨 forwarding failure: ${from} -> ${to} of ${amt} for ${fee}`]

        if (f.internal_failure && f.internal_failure !== 'NO_DETAIL') {
          msg.push(`    💩 internal failure: ${f.internal_failure}`)
        }
        if (f.external_failure && f.external_failure !== 'NO_DETAIL') {
          msg.push(`    🤡 external failure: ${f.external_failure}`)
        }

        log(msg.join('\n'))
      }
      delete pastForwardEvents[fid] // clear up memory
      return null
    }

    // done: success
    if (f.is_confirmed) {
      if (LOG_SUCCESSFUL_FORWARDS) {
        log(`⚡ forwarding success: ${from} -> ${to} of ${amt} for ${fee}`)
      }

      delete pastForwardEvents[fid] // clear up memory
      return null
    }

    // uresolved forwards with defined path
    // if (f.in_channel && f.out_channel) {
    //   log(`🕐 forwarding pending: ${from} -> ${to} of ${amt} for ${fee}`)
    // }

    // just in case too many fids in memory clean it all up above some limit
    if (Object.keys(pastForwardEvents).length >= 555) {
      Object.keys(pastForwardEvents).forEach(key => delete pastForwardEvents[key])
      log('forward id number limit hit, cleaning up RAM')
    }
  })
  forwardEvents.on('error', () => {
    log('forward events error')
    process.exit(1)
  })

  log('listening for events...')
}
const log = (...args) =>
  setImmediate(() => {
    const msg = [getDate(), ...args, '\n'].join(' ')
    console.log(msg)
    fs.appendFileSync(LOG_FILE_PATH, msg + '\n')
  })
const getDate = () => new Date().toISOString().replace('T', ' ').replace('Z', '')
const pretty = (n, L = 0) => {
  if (isNaN(n)) return n
  return String((+n || 0).toFixed(L)).replace(/\B(?=(\d{3})+\b)/g, '_')
}

run()
