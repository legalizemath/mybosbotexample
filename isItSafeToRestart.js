// check if any forwards are coming up on timeouts
// so you're not offline when they do

import bos from './bos.js'

const run = async () => {
  const peers = await bos.peers({}) // undefined for all filters
  const height = (await bos.call('getHeight'))?.current_block_height
  if (!peers) {
    console.log('lnd unreachable')
    return null
  }

  const forwardingPeers = peers.filter(p => p.is_forwarding)
  const currentForwards = []
  for (const peer of forwardingPeers) {
    const forwards = peer.is_forwarding.pending_payments
    forwards.forEach(f => {
      f.peer_public_key = peer.public_key
      f.peer_is_offline = peer.is_offline
      f.peer_alias = peer.alias
    })
    currentForwards.push(...forwards)
  }
  currentForwards.forEach(f => {
    f.blocks_to_timeout = f.timeout - height
    f.minutes_est_to_timeout = f.blocks_to_timeout * 10
  })
  currentForwards.sort((a, b) => a.blocks_to_timeout - b.blocks_to_timeout)
  const riskyForwards = currentForwards.filter(f => f.blocks_to_timeout < 6)

  // console.log(currentForwards)
  console.log(`current height is ${height}`)
  console.log(`there are ${currentForwards.length} pending forwards`)
  console.log(`of which ${currentForwards.filter(f => f.peer_is_offline).length} are with offline peers`)
  console.log(`${riskyForwards.length} are < 6 blocks away from timing out (~60 minutes)`)
  if (riskyForwards.length) {
    console.log('They are:', riskyForwards)
  }
}
run()
