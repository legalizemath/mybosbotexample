// basic example of a looping bot
// EXAMPLE ONLY, DO NOT USE

import bos from './bos.js' // my wrappers for bos in bos.js file

// max and min adjusting fee to use (ppm)
const MAX_FEE_RATE = 1337
const MIN_FEE_RATE = 1
// max fee rate (ppm) and minutes to use for rebalancing
const MAX_REBALANCE_FEE_RATE = 200
const MAX_REBALANCE_MINUTES = 5
// how often to repeat
const MINUTES_BETWEEN_RUNS = 60

// waste time for set number of minutes
const sleep = async minutes => await new Promise(r => setTimeout(r, Math.trunc(minutes * 60 * 1000)))

// this function will loop itself forever
const bot = async () => {
  // get peers
  const allPeers = await bos.peers({active: true, public: true})

  // let's add some more properties for each peer
  for (const peer of allPeers) {
    peer.localSats = peer.outbound_liquidity || 0
    peer.remoteSats = peer.inbound_liquidity || 0
    peer.totalSats = peer.localSats + peer.remoteSats
    peer.balance = localSats / totalSats
    peer.satsOffBalance = Math.abs(peer.localSats - peer.remoteSats) * 0.5
  }

  // for each peer set fee
  for (const peer of allPeers) {
    const public_key = peer.public_key

    // grab properties calculated earlier
    const balance = peer.balance

    // calculate fee, smallest at balance 1 and largest at balance 0
    const proportionalFee = Math.trunc(MIN_FEE_RATE * balance + MAX_FEE_RATE * (1 - balance))

    // set the fee
    const finalFee = await bos.setFees(public_key, proportionalFee)
    console.log(`${peer.alias} fee rate was set to ${finalFee} ppm`)
  }

  // split peers by remote heavy and local heavy
  const localHeavyPeers = allPeers.filter(peer => peer.balance > 0.75)
  const remoteHeavyPeers = allPeers.filter(peer => peer.balance < 0.25)

  // if there's at least one of each
  if (localHeavyPeers.length > 0 && remoteHeavyPeers.length > 0) {
    // pick random peer from both
    const randomLocalIndex = Math.trunc(Math.random() * localHeavyPeers.length)
    const randomRemoteIndex = Math.trunc(Math.random() * remoteHeavyPeers.length)

    const localHeavy = localHeavyPeers[randomLocalIndex]
    const remoteHeavy = remoteHeavyPeers[randomRemoteIndex]

    // max amount to rebalance is the smaller sats off-balance between the two
    const maxSatsToRebalance = Math.min(localHeavy.satsOffBalance, remoteHeavy.satsOffBalance)

    // try to rebalance them
    console.log(`Trying to rebalance sats from ${localHeavy.alias} to ${remoteHeavy.alias}`)
    const result = await bos.rebalance({
      fromChannel: localHeavy.public_key,
      toChannel: remoteHeavy.public_key,
      maxSats: maxSatsToRebalance,
      maxMinutes: MAX_REBALANCE_MINUTES,
      maxFeeRate: MAX_REBALANCE_FEE_RATE
    })
    console.log(result)
  }

  // wait 60 minutes
  console.log('sleep time (minutes):', MINUTES_BETWEEN_RUNS)
  await sleep(MINUTES_BETWEEN_RUNS)

  // start this function from start again
  bot()
}

// starts the loop
bot()
