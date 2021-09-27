import bos from './bos.js' // my wrappers for bos in bos.js file
const { trunc, random, min } = Math

// max fee rate (ppm) and minutes to use for rebalancing
const MAX_REBALANCE_MINUTES = 10
const MIN_SATS_OFF_BALANCE = 200e3

const UNDERPRICE_FEE_RATE_BY = 0.2
const MINIMUM_REBALANCE_FEE_RATE = 10 // unlikely to rebalance anything this low
const MAX_SATS_TO_REBALANCE = 100000

// this function runs the desired steps
const bot = async () => {
  // get peers
  const allPeers = await bos.peers({ active: true, public: true })
  // get my fee rates
  const getMyFees = await bos.getFees()

  // let's add some more properties for each peer
  for (const peer of allPeers) {
    peer.localSats = peer.outbound_liquidity || 0
    peer.remoteSats = peer.inbound_liquidity || 0
    peer.totalSats = peer.localSats + peer.remoteSats
    peer.balance = peer.localSats / peer.totalSats
    peer.satsOffBalance = Math.abs(peer.localSats - peer.remoteSats) * 0.5
  }

  // split peers by remote heavy and local heavy
  const localHeavyPeers = allPeers.filter(peer => peer.balance > 0.5 && peer.satsOffBalance > MIN_SATS_OFF_BALANCE)
  const remoteHeavyPeers = allPeers.filter(peer => peer.balance < 0.5 && peer.satsOffBalance > MIN_SATS_OFF_BALANCE)

  // assemble list of matching peers and how much to rebalance
  const matchups = []

  // if there's at least one of each
  while (localHeavyPeers.length > 0 && remoteHeavyPeers.length > 0) {
    // pick random peer index from both arrays
    const randomLocalIndex = trunc(random() * localHeavyPeers.length)
    const randomRemoteIndex = trunc(random() * remoteHeavyPeers.length)
    // get actual peers
    const localHeavy = localHeavyPeers[randomLocalIndex]
    const remoteHeavy = remoteHeavyPeers[randomRemoteIndex]

    // max amount to rebalance is the smaller sats off-balance between the two
    const maxSatsToRebalance = trunc(min(localHeavy.satsOffBalance, remoteHeavy.satsOffBalance, MAX_SATS_TO_REBALANCE))

    // grab my outgoing fee for remote heavy peer
    const myOutgoingFee = getMyFees[remoteHeavy.public_key]
    const maxRebalanceFee = trunc(myOutgoingFee * (1 - UNDERPRICE_FEE_RATE_BY))

    if (maxRebalanceFee < MINIMUM_REBALANCE_FEE_RATE) {
      // remove this remote heavy channel from consideration
      remoteHeavyPeers.splice(randomRemoteIndex, 1)
      // move onto next random pair
      continue
    }

    // add this peer pair to matchups
    matchups.push({
      localHeavy,
      remoteHeavy,
      maxSatsToRebalance,
      myOutgoingFee,
      maxRebalanceFee
    })

    // remove these peers from peer lists
    localHeavyPeers.splice(randomLocalIndex, 1)
    remoteHeavyPeers.splice(randomRemoteIndex, 1)

    // break // test just 1
  }

  let tasksDone = 0

  // how to launch every task & return results
  const handleRebalance = async matchedPair => {
    const { localHeavy, remoteHeavy, maxSatsToRebalance, myOutgoingFee, maxRebalanceFee } = matchedPair

    console.log(
      `|${localHeavy.balance.toFixed(1)}b|${localHeavy.alias} (${myOutgoingFee}ppm)-->` +
        ` |${remoteHeavy.balance.toFixed(1)}b|${remoteHeavy.alias} rebalance ${maxSatsToRebalance}` +
        ` sats @ ${maxRebalanceFee} ppm`
    )

    const startedAt = Date.now()
    const resBalance = await bos.rebalance(
      {
        fromChannel: localHeavy.public_key,
        toChannel: remoteHeavy.public_key,
        maxSats: maxSatsToRebalance,
        maxMinutes: MAX_REBALANCE_MINUTES,
        maxFeeRate: maxRebalanceFee
      },
      undefined,
      { details: false, progress: false }
    )
    const taskLength = ((Date.now() - startedAt) / 1000 / 60).toFixed(1) + ' minutes'
    console.log(
      `(${++tasksDone}/${matchups.length} rebalances done)` +
        ` ${localHeavy.alias}-->${remoteHeavy.alias} rebalance ` +
        `${resBalance.failed ? 'failed' : 'succeeded'} after ${taskLength}`
    )
    return resBalance
  }

  // assemble list of launched rebalance tasks
  const rebalanceTasks = []

  // launch every task near-simultaneously, small stagger between launch
  for (const matchedPair of matchups) {
    rebalanceTasks.push(handleRebalance(matchedPair))
    await sleep(555)
  }
  console.log(`\nAll ${rebalanceTasks.length} parallel rebalances launched!\n`)

  // wait until every rebalance task is done & returns a value
  const rebalanceResults = await Promise.all(rebalanceTasks)
  console.log(
    'ALL TASKS DONE:',
    rebalanceResults.map(r => JSON.stringify(r))
  )
}

// const result = await bos.rebalance({
//   fromChannel: localHeavy.public_key,
//   toChannel: remoteHeavy.public_key,
//   maxSats: maxSatsToRebalance,
//   maxMinutes: MAX_REBALANCE_MINUTES,
//   maxFeeRate: MAX_REBALANCE_FEE_RATE
// })

// various useful functions:

// waste time for set number of minutes
const sleep = async ms => await new Promise(r => setTimeout(r, trunc(ms)))

bot()
