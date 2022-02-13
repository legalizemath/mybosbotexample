// just checks for any non-healthy channels that may be offline, inactive, disabled on either side
// option (ALLOW_RECONNECT) to try reconnecting to them in parallel

import bos from './bos.js'

const ALLOW_RECONNECT = false // actually do reconnections instead of just printing data

const run = async () => {
  // const lnd = await bos.initializeAuth()

  const me = (await bos.callAPI('getIdentity')).public_key
  const peers = await bos.peers({}) // all
  const peersByPublicKey = reindex(peers).byKey('public_key')
  const connectedPeers = (await bos.callAPI('getPeers')).peers
  const connectedPeersByPublicKey = reindex(connectedPeers).byKey('public_key')
  const channelsByPeer = await bos.getNodeChannels({ public_key: me, byPublicKey: true })
  const peerChannels = Object.values(channelsByPeer)
  const channels = (await bos.callAPI('getChannels')).channels

  const pkToAlias = await bos.getPublicKeyToAliasTable()

  // const allPeerKeys = peers.map(p => p.public_key)

  const offline = peers.filter(p => p.is_offline).map(p => p.public_key)
  // const online = peers.filter(p => !p.is_offline)

  // const active = channels.filter(c => c.is_active)
  const inactive = unique(channels?.filter(c => !c.is_active)?.map(c => c.partner_public_key) ?? [])

  const inactiveAndConnected = channels.filter(c => !c.is_active && !!connectedPeersByPublicKey[c.partner_public_key])

  const inDisabledPeers = peerChannels
    .filter(
      p =>
        // !p.some(chan => chan.local.is_disabled) && // we don't have it disabled (so likely they are online)
        p.some(chan => chan.remote.is_disabled) // they have it disabled to us
    )
    .map(peerChannels => peerChannels[0].public_key)

  const outDisabledToPeers = peerChannels
    .filter(p => p.some(chan => chan.local.is_disabled))
    .map(peerChannels => peerChannels[0].public_key)

  const disabledInBothDirections = peerChannels.filter(
    p => p.some(chan => chan.remote?.is_disabled) && p.some(chan => chan.local.is_disabled)
  )

  console.log(`\n${getDateHere().replace('T', ' ').replace('Z', '')}\n`)
  // console.log(pkToAlias)

  const printTheseChannels = unique([...offline, ...inactive, ...inDisabledPeers, ...outDisabledToPeers])

  for (const public_key of printTheseChannels) {
    const isOffline = offline.includes(public_key) // offline.find(p => p.public_key === public_key)
    const isActive = !inactive.includes(public_key)
    const peer = peersByPublicKey[public_key] // peers.find(p => p.public_key === public_key)
    const localSats = peer.outbound_liquidity ?? 0
    const remoteSats = peer.inbound_liquidity ?? 0
    const totalSats = localSats + remoteSats
    const isRationalDisable = remoteSats < 0.1 * totalSats
    const isSmall = totalSats < 3e6
    const lastReconnected = connectedPeersByPublicKey[public_key]?.last_reconnection
      ? hoursAgo(getTime(connectedPeersByPublicKey[public_key].last_reconnection)).toFixed(1) + 'h last rec'
      : '-'
    // console.log(connectedPeersByPublicKey[public_key])
    log(
      ` ${ca(pkToAlias[public_key])}`.padStart(31) +
        ` ${public_key} ` +
        ` ${(localSats / 1e6).toFixed(1)}M |`.padStart(9) +
        ` ${(remoteSats / 1e6).toFixed(1)}M `.padEnd(9) +
        ` ${isRationalDisable ? '>0.9' : '-'} `.padStart(6) +
        ` ${isSmall ? 'small' : '-'} `.padStart(7) +
        ` ${lastReconnected} `.padStart(16) +
        ` ${isOffline ? 'offline' : '-'} `.padStart(9) +
        ` ${!isActive ? 'inactive' : '-'} `.padStart(10) +
        ` ${inDisabledPeers.includes(public_key) ? 'in-off' : '-'} `.padStart(10) +
        ` ${outDisabledToPeers.includes(public_key) ? 'out-off' : '-'} `.padStart(10)
    )
  }

  log(`
    total peers:              ${peers.length}
    offline peers:            ${offline.length}
    not-active channels:      ${inactive.length}
    not-active and online:    ${inactiveAndConnected.length}
    peers disabling to me:    ${inDisabledPeers.length}
    me disabling to peers:    ${outDisabledToPeers.length}
    disabled both ways:       ${disabledInBothDirections.length}
  `)

  if (ALLOW_RECONNECT) {
    for (const public_key of offline) {
      // launch in parallel
      bos.addPeer({ public_key }).then(res => {
        if (res) log(`Reconnected to ${pkToAlias[public_key] ?? public_key.slice(0, 20)}`)
        else log(`Failed to reconnect to ${pkToAlias[public_key] ?? public_key.slice(0, 20)}`)
      })
      // stagger launch by this many seconds
      await sleep(5 * 1000)
    }
  }
}

const reindex = arr => ({
  byKey: key =>
    arr.reduce((obj, item) => {
      obj[item[key]] = item
      return obj
    }, {})
})
// const days = 24 * 60 * 60 * 1000
const hours = 60 * 60 * 1000

const getTime = isoString => Date.parse(isoString)

const getDateHere = () => {
  const dt = new Date()
  dt.setTime(dt.getTime() - dt.getTimezoneOffset() * 60 * 1000)
  return dt.toISOString()
}
// const daysAgo = ts => (Date.now() - ts) / days
const hoursAgo = ts => (Date.now() - ts) / hours

const log = (...args) => setImmediate(() => console.log(`${args.join(' ')}`))

const unique = arr => Array.from(new Set(arr))
const sleep = async ms => await new Promise(resolve => setTimeout(resolve, Math.trunc(ms)))

const ca = alias =>
  String(alias)
    .replace(/[^\x00-\x7F]/g, '')
    .trim()

run()
