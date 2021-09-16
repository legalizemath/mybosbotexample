// basic example of a looping bot
// EXAMPLE ONLY, DO NOT USE

import bos from './bos.js' // my wrappers for bos in bos.js file

// max fee rate (ppm) and minutes to use for rebalancing
const MAX_REBALANCE_FEE_RATE = 400
const MAX_REBALANCE_MINUTES = 5
// how often to repeat
const MINUTES_BETWEEN_RUNS = 1
const MIN_SATS_ON_SIDE = 2000000
const MIN_OFF_BALANCE = 0.25
const MIN_REBALANCE = 50000 // bos minimum
const MAX_REBALANCE = 500000 // custom max amount to ever try in 1 attempt

// this function will loop itself forever
const bot = async () => {
  // get peers
  const allPeers = await bos.peers({ active: true, public: true })
  // get fees
  const getMyFees = await bos.getFees()

  // let's add some more properties for each peer
  for (const peer of allPeers) {
    peer.localSats = peer.outbound_liquidity || 0
    peer.remoteSats = peer.inbound_liquidity || 0
    peer.totalSats = peer.localSats + peer.remoteSats
    peer.balance = peer.localSats / peer.totalSats
    peer.satsOffBalance = Math.abs(peer.localSats - peer.remoteSats) * 0.5

    peer.localTargetSats = MIN_OFF_BALANCE * peer.totalSats
    peer.remoteTargetSats = MIN_OFF_BALANCE * peer.totalSats
    peer.localSatsOffTarget = peer.localSats - peer.localTargetSats
    peer.remoteSatsOffTarget = peer.remoteSats - peer.remoteTargetSats

    // add my fees
    peer.my_fee_rate = +getMyFees[peer.public_key] || 0
  }

  // split peers by remote heavy and local heavy
  const localHeavyPeers = allPeers.filter(
    peer =>
      peer.balance > 0.5 + MIN_OFF_BALANCE && peer.localSats > MIN_SATS_ON_SIDE
  )
  const remoteHeavyPeers = allPeers.filter(
    peer =>
      peer.balance < 0.5 - MIN_OFF_BALANCE && peer.remoteSats > MIN_SATS_ON_SIDE
  )

  // if there's at least one of each
  if (localHeavyPeers.length > 0 && remoteHeavyPeers.length > 0) {
    //
    // pick random peer from both
    const randomLocalIndex = Math.trunc(Math.random() * localHeavyPeers.length)
    const randomRemoteIndex = Math.trunc(
      Math.random() * remoteHeavyPeers.length
    )
    const localHeavy = localHeavyPeers[randomLocalIndex]
    const remoteHeavy = remoteHeavyPeers[randomRemoteIndex]

    // max amount to rebalance is the sats
    const maxSatsToRebalance = Math.min(
      Math.max(localHeavy.localSatsOffTarget, MIN_REBALANCE),
      Math.max(remoteHeavy.remoteSatsOffTarget, MIN_REBALANCE),
      MAX_REBALANCE
    )

    // try to rebalance them
    console.log(
      `Trying to rebalance sats from ${localHeavy.alias} to ${remoteHeavy.alias} max amount of` +
      `${maxSatsToRebalance} sats at max fee rate of ${MAX_REBALANCE_FEE_RATE}` +
      `for max attempt length of ${MAX_REBALANCE_MINUTES} minutes`
    )
    
    // remove // to turn stuff back on below this
    // const result = await bos.rebalance(
    //   {
    //     fromChannel: localHeavy.public_key,
    //     toChannel: remoteHeavy.public_key,
    //     maxSats: maxSatsToRebalance,
    //     maxMinutes: MAX_REBALANCE_MINUTES,
    //     maxFeeRate: MAX_REBALANCE_FEE_RATE
    //   },
    //   {},
    //   true
    // )
    // console.log(result)
  }

  // try reconnecting to disconnected peers
  console.log(`attempting reconnect`)
  //   await bos.reconnect(true)

  // wait MINUTES_BETWEEN_RUNS minutes
  console.log('sleep time (minutes):', MINUTES_BETWEEN_RUNS)
  await sleep(MINUTES_BETWEEN_RUNS)

  // start this function from start again
  bot()
}

// waste time for set number of minutes
const sleep = async minutes =>
  await new Promise(r => setTimeout(r, Math.trunc(minutes * 60 * 1000)))

// starts the loop
bot()
