// NOT SAFE TO RUN
dfgdfgdfgdfgdfg

import fs from 'fs' // comes with nodejs, to read/write log files
import dns from 'dns' // comes with nodejs, to check if there's internet access
import bos from './bos.js' // my wrapper for bos

const { min, max, trunc, floor, abs, random, sqrt, log2, pow } = Math

// time to sleep between trying a bot step again
const MINUTES_BETWEEN_STEPS = 5

// minimum sats away from 0.5 balance to consider off-balance
const MIN_SATS_OFF_BALANCE = 420e3
// unbalanced sats below this can stop (bos rebalance requires >50k)
const MIN_REBALANCE_SATS = 51e3

// limit of sats to balance per attempt
// larger = faster rebalances, less for channels.db to store
// smaller = can use smaller liquidity/channels for cheaper/easier rebalances
// bos rebalance does probing + size up htlc strategy
// (bos rebalance requires >50k)
const MAX_REBALANCE_SATS = 212121 * 2

// rebalance with faster keysends after bos rebalance works
// (faster but higher risk of stuck sats so I send less)
const USE_KEYSENDS_AFTER_BALANCE = true
// only use keysends (I use for testing)
const ONLY_USE_KEYSENDS = false
// sats to balance via keysends
const MAX_REBALANCE_SATS_KEYSEND = 212121

// suspect might cause tor issues if too much bandwidth being used
// setting to 1 makes it try just 1 rebalance at a time
const MAX_PARALLEL_REBALANCES = 7

// channels smaller than this not necessary to balance or adjust fees for
// usually special cases anyway
// (maybe use proportional fee policy for them instead)
// >2m for now
const MIN_CHAN_SIZE = 2.1e6

// multiplier for proportional safety ppm margin
const SAFETY_MARGIN = 1.618 // 1.21 //
// maximum flat safety ppm margin (proportional below this value)
const SAFETY_MARGIN_FLAT_MAX = 314 // 222 //
// rebalancing fee rates below this aren't considered for rebalancing
const MIN_FEE_RATE_FOR_REBALANCE = 1

// max size of fee adjustment to target ppm (upward)
const NUDGE_UP = 0.0069
// max size of fee adjustment to target ppm (downward)
const NUDGE_DOWN = NUDGE_UP / 2
// max days since last successful routing out to allow increasing fee
const DAYS_FOR_FEE_INCREASE = 1.2
// min days of no routing activity before allowing reduction in fees
const DAYS_FOR_FEE_REDUCTION = 4.2

// minimum ppm ever possible
const MIN_PPM_ABSOLUTE = 0
// any ppm above this is not considered for fees, rebalancing, or suggestions
const MAX_PPM_ABSOLUTE = 2718

// smallest amount of sats necessary to consider a side not drained
const MIN_SATS_PER_SIDE = 1000e3

// max minutes to spend per rebalance try
const MINUTES_FOR_REBALANCE = 5
// max minutes to spend per keysend try
const MINUTES_FOR_KEYSEND = 5

// number of times to retry a rebalance on probe timeout while
// increasing fee for last hop to skip all depleted channels
// Only applies on specifically ProbeTimeout so unsearched routes remain
const RETRIES_ON_TIMEOUTS = 3

// time between retrying same good pair
const MIN_MINUTES_BETWEEN_SAME_PAIR = (MINUTES_BETWEEN_STEPS + MINUTES_FOR_REBALANCE) * 2
// max rebalance repeats while successful
// if realized rebalance rate is > 1/2 max rebalance rate
// this will just stop repeats at minor discounts
const MAX_BALANCE_REPEATS = 5

// ms to put between each rebalance launch for safety
const STAGGERED_LAUNCH_MS = 1111

// allow adjusting fees
const ADJUST_FEES = true

// as 0-profit fee rate increases, fee rate where where proportional
// fee takes over flat one is
// (break even fee rate) * SAFETY_MARGIN = SAFETY_MARGIN_FLAT_MAX

// how much error to use for balance calcs
// const BALANCE_DEV = 0.1

// how far back to look for routing stats, must be longer than any other DAYS setting
const DAYS_FOR_STATS = 7

// weight multiplier for rebalancing rates that were actually used vs suggested
// const WORKED_WEIGHT = 5
// min sample size before using rebalancing ppm rates for anything
// const MIN_SAMPLE_SIZE = 3

// fraction of peers that need to be offline to restart tor service
const PEERS_OFFLINE_MAXIMUM = 0.11 // 11%
const ALLOW_BOS_RECONNECT = true
const ALLOW_TOR_RESET = true
// const COMMAND_TO_RUN_FOR_RESET = ''

// hours between running bos reconnect
const MINUTES_BETWEEN_RECONNECTS = 69
// how often to update fees
const MINUTES_BETWEEN_FEE_CHANGES = 121

// show everything
const VERBOSE = true

// what to weight random selection by
const WEIGHT_OPTIONS = {}
WEIGHT_OPTIONS.FLAT = () => 1
// 2x more sats from balance is 2x more likely to be selected
WEIGHT_OPTIONS.UNBALANCED_SATS = peer => peer.unbalancedSats
// 2x more sats from balance is ~1.4x more likely to be selected
// better for trying more channel combinations still favoring unabalanced
WEIGHT_OPTIONS.UNBALANCED_SATS_SQRT = peer => trunc(sqrt(peer.unbalancedSats))
WEIGHT_OPTIONS.UNBALANCED_SATS_SQRTSQRT = peer => trunc(sqrt(sqrt(peer.unbalancedSats)))
WEIGHT_OPTIONS.CHANNEL_SIZE = peer => peer.totalSats

const WEIGHT = WEIGHT_OPTIONS.UNBALANCED_SATS_SQRTSQRT

// experimental - fake small flowrate to be ready to expect
// const MIN_FLOWRATE_PER_DAY = 10000 // sats/day

const SNAPSHOTS_PATH = './snapshots'
const BALANCING_LOG_PATH = './peers'
const LOG_FILES = './logs'
const TIMERS_PATH = 'timers.json'
const SETTINGS_PATH = 'settings.json'

// global node info
const mynode = {
  scriptStarted: Date.now(),
  my_public_key: ''
}

const runBot = async () => {
  console.boring(`${getDate()} runBot()`)

  // check if time for bos reconnect
  await runBotReconnectCheck()

  // check if time for updating fees
  await runUpdateFeesCheck()

  // experimental
  await runBotRebalanceOrganizer()

  // pause
  await sleep(MINUTES_BETWEEN_STEPS * 60 * 1000)

  // restart
  runBot()
}

// experimental parallel rebalancing function (unsplit, wip)
const runBotRebalanceOrganizer = async () => {
  console.boring(`${getDate()} runBotRebalanceOrganizer()`)
  // match up peers
  // high weight lets channels get to pick good peers first (not always to occasionally search for better matches)

  const peers = await runBotGetPeers()
  // make a list of remote heavy and local heavy peers via balance check
  const remoteHeavyPeers = rndWeightedSort(peers.filter(includeForRemoteHeavyRebalance), WEIGHT)
  const localHeavyPeers = rndWeightedSort(peers.filter(includeForLocalHeavyRebalance), WEIGHT)
  const [nRHP, nLHP] = [remoteHeavyPeers.length, localHeavyPeers.length]

  /*
  if (VERBOSE) {
    console.log(`${getDate()} Peer weight / balance / alias.   Weight function: ${WEIGHT}`)
    for (const p of localHeavyPeers) {
      const weight = WEIGHT(p)
      const w = pretty(weight).padStart(13)
      const b = p.balance.toFixed(2)
      console.log(`Local-heavy: ${w}w ${b}b ${p.alias.padEnd(30)}`)
    }
    console.log('')
    for (const p of remoteHeavyPeers) {
      const weight = WEIGHT(p)
      const w = pretty(weight).padStart(12)
      const b = p.balance.toFixed(2)
      console.log(`Remote-heavy: ${w}w ${b}b ${p.alias.padEnd(30)}`)
    }
  }
  */

  // assemble list of matching peers and how much to rebalance
  const matchups = []

  // keep going until one side clear
  while (localHeavyPeers.length > 0 && remoteHeavyPeers.length > 0) {
    // get top lucky remote channel
    const remoteHeavy = remoteHeavyPeers[0]

    // try to see if there's good match for it for local
    const localHeavyIndexIdeal = findGoodPeerMatch({ remoteChannel: remoteHeavy, peerOptions: localHeavyPeers })
    // console.log({ localHeavyIndexIdeal }) // temporary

    // use localHeavyIndex if it returns an index, otherwise use top local channel
    const localHeavyIndexUsed = localHeavyIndexIdeal > -1 ? localHeavyIndexIdeal : 0
    const localHeavy = localHeavyPeers[localHeavyIndexUsed]

    // max amount to rebalance is the smaller sats off-balance between the two
    const maxSatsToRebalance = trunc(min(localHeavy.unbalancedSats, remoteHeavy.unbalancedSats))

    // grab my outgoing fee for remote heavy peer
    const myOutgoingFee = remoteHeavy.my_fee_rate
    const maxRebalanceRate = subtractSafety(myOutgoingFee)

    // add this peer pair to matchups
    // run keeps track of n times matchup ran
    // done keeps track of done tasks
    // started at keeps track of time taken
    // results keeps 1+ return values from bos function
    matchups.push({
      localHeavy,
      remoteHeavy,
      maxSatsToRebalance,
      maxRebalanceRate,
      run: 1,
      done: false,
      startedAt: Date.now(),
      results: [],
      isGoodPeer: localHeavyIndexIdeal > -1
    })

    // remove these peers from peer lists
    localHeavyPeers.splice(localHeavyIndexUsed, 1)
    remoteHeavyPeers.splice(0, 1)

    // stop if limit reached
    if (matchups.length >= MAX_PARALLEL_REBALANCES) break
  }

  if (VERBOSE) {
    console.log(
      `${getDate()} ${matchups.length} rebalance matchups from ${nRHP} remote-heavy & ${nLHP} local-heavy peers\n`
    )
    for (const match of matchups) {
      const outOf = ca(match.localHeavy.alias).padStart(30)
      const into = ca(match.remoteHeavy.alias).padEnd(30)
      const meAtLH = (match.localHeavy.outbound_liquidity / 1e6).toFixed(1).padStart(4) + 'M'
      const remAtLH = (match.localHeavy.inbound_liquidity / 1e6).toFixed(1).padStart(4) + 'M'
      const meAtRH = (match.remoteHeavy.outbound_liquidity / 1e6).toFixed(1).padStart(4) + 'M'
      const remAtRH = (match.remoteHeavy.inbound_liquidity / 1e6).toFixed(1).padStart(4) + 'M'

      const remFeeAtRH = `(${match.remoteHeavy.inbound_fee_rate})`.padStart(6)
      const myFeeAtRH = `(${match.remoteHeavy.my_fee_rate})`.padEnd(6)

      console.log(
        `  me☂️  ${dim}${meAtLH} [ ||||-> ] ${remAtLH}${undim} ${outOf} ${dim}--> ?` +
          ` -->${undim} ${into} ${dim}${remAtRH} ${remFeeAtRH} [ ||||-> ] ${myFeeAtRH} ${meAtRH}${undim}  me☂️  ` +
          (match.isGoodPeer ? '💚' : '')
      )
    }
    console.log('')
  }

  // to keep track of list of launched rebalancing tasks
  const rebalanceTasks = []
  // function to launch every rebalance task for a matched pair with
  const handleRebalance = async matchedPair => {
    const { localHeavy, remoteHeavy, maxSatsToRebalance, maxRebalanceRate, run, startedAt } = matchedPair
    const localString = ca(localHeavy.alias).padStart(30)
    const remoteString = ca(remoteHeavy.alias).padEnd(30)
    const maxRebalanceRateString = ('<' + maxRebalanceRate + ' ppm').padStart(9)

    // ONLY_USE_KEYSENDS - always does bos send instead of bos rebalance
    // USE_KEYSENDS_AFTER_BALANCE - always does bos send after 1 bos rebalance works
    const useRegularRebalance = !(run > 1 && USE_KEYSENDS_AFTER_BALANCE) && !ONLY_USE_KEYSENDS
    const maxSatsToRebalanceAfterRules = useRegularRebalance
      ? min(maxSatsToRebalance, MAX_REBALANCE_SATS)
      : min(maxSatsToRebalance, MAX_REBALANCE_SATS_KEYSEND)

    // task launch message
    console.log(
      `${getDate()} Starting ${localString} --> ${remoteString}run #${run}` +
        ` rebalance @ ${maxRebalanceRateString}, ${pretty(maxSatsToRebalance).padStart(10)} sats left ` +
        `${dim}(${useRegularRebalance ? 'via bos rebalance' : 'via bos send'})${undim}`
    )

    const resBalance = useRegularRebalance
      ? await bos.rebalance(
          {
            fromChannel: localHeavy.public_key,
            toChannel: remoteHeavy.public_key,
            // bos rebalance probes with small # of sats and then increases
            // amount up to this value until probe fails
            // so then it uses the largest size that worked
            maxSats: maxSatsToRebalanceAfterRules,
            maxMinutes: MINUTES_FOR_REBALANCE,
            maxFeeRate: maxRebalanceRate,
            retryAvoidsOnTimeout: RETRIES_ON_TIMEOUTS
          },
          undefined,
          {} // show nothing, too many things happening
          // { details: true }
        )
      : await bos.send(
          {
            destination: mynode.my_public_key,
            fromChannel: localHeavy.public_key,
            toChannel: remoteHeavy.public_key,
            // keysends use exact sat amounts specified so
            // add 10% randomness to amount to make source of rebalance less obvious
            sats: trunc(maxSatsToRebalanceAfterRules * (1 - 0.1 * random())),
            maxMinutes: MINUTES_FOR_KEYSEND,
            maxFeeRate: maxRebalanceRate,
            isRebalance: true
          },
          {} // show nothing, too many things happening
          // { details: true }
        )

    const taskLength = ((Date.now() - startedAt) / 1000 / 60).toFixed(1) + ' minutes'
    matchedPair.results.push(resBalance)
    if (resBalance.failed) {
      // fail:
      matchedPair.done = true
      const tasksDone = matchups.reduce((count, m) => (m.done ? count + 1 : count), 0)
      const reason = resBalance.msg[1] // 2nd item in error array from bos
      const reasonString = resBalance.ppmSuggested
        ? `(Reason: needed ${String(resBalance.ppmSuggested).padStart(4)} ppm) `
        : `(Reason: ${reason}) `
      console.log(
        `${getDate()} Stopping ${localString} --> ${remoteString}run #${run} ${maxRebalanceRateString} ` +
          `rebalance failed ${reasonString}` +
          `${dim}(${tasksDone}/${matchups.length} done after ${taskLength})${undim}`
      )
      // fails are to be logged only when there's a useful suggested fee rate
      if (resBalance.ppmSuggested) {
        appendRecord({
          peer: remoteHeavy,
          newRebalance: {
            t: Date.now(),
            ppm: maxRebalanceRate,
            failed: true,
            peer: localHeavy.public_key,
            peerAlias: localHeavy.alias,
            sats: maxSatsToRebalanceAfterRules
          }
        })
      }
      // return matchedPair
    } else {
      // just in case both fields are missing for some reason in response lets stop
      if (!resBalance.rebalanced && !resBalance.sent) {
        console.error(`${getDate()} shouldn't happen: missing resBalance.rebalanced & resBalance.sent`)
        return matchedPair
      }
      const rebalanced = resBalance.rebalanced ?? resBalance.sent
      // succeess:
      matchedPair.maxSatsToRebalance -= rebalanced
      matchedPair.run++
      appendRecord({
        peer: remoteHeavy,
        newRebalance: {
          t: Date.now(),
          ppm: resBalance.fee_rate,
          failed: false,
          peer: localHeavy.public_key,
          peerAlias: localHeavy.alias,
          sats: rebalanced
        }
      })
      // more than 1 smily = huge discount
      const discount = floor(maxRebalanceRate / resBalance.fee_rate)
      const yays = '😁'.repeat(min(5, discount))
      if (matchedPair.maxSatsToRebalance < MIN_SATS_OFF_BALANCE) {
        // successful & stopping - rebalanced "enough" as sats off-balance below minimum
        matchedPair.done = true
        const tasksDone = matchups.reduce((count, m) => (m.done ? count + 1 : count), 0)
        console.log(
          `${getDate()} Completed${localString} --> ${remoteString}at #${run} ${maxRebalanceRateString} ` +
            `rebalance succeeded for ${pretty(rebalanced)} sats @ ${resBalance.fee_rate} ppm ${yays}` +
            ` & done! 🍾🥂🏆 ${dim}(${tasksDone}/${matchups.length} done after ${taskLength})${undim}`
        )
        // return matchedPair
      } else if (run >= MAX_BALANCE_REPEATS && discount < 2) {
        // successful & stopping - at max repeats for minor discounts (< than 1/2 of attempted fee rate)
        matchedPair.done = true
        const tasksDone = matchups.reduce((count, m) => (m.done ? count + 1 : count), 0)
        console.log(
          `${getDate()} Completed${localString} --> ${remoteString}at #${run} ${maxRebalanceRateString} ` +
            `rebalance succeeded for ${pretty(rebalanced)} sats @ ${resBalance.fee_rate} ppm ${yays}` +
            ` & reached max number of repeats. ${dim}(${tasksDone}/${matchups.length} done after ${taskLength})${undim}`
        )
        // return matchedPair
      } else {
        // successful & keep doing rebalances
        console.log(
          `${getDate()} Updating ${localString} --> ${remoteString}run #${run} ${maxRebalanceRateString} ` +
            `rebalance succeeded for ${pretty(rebalanced)} sats @ ${resBalance.fee_rate} ppm ${yays}` +
            ` & moving onto run #${run + 1} (${pretty(matchedPair.maxSatsToRebalance)} sats left to balance)`
        )
        return await handleRebalance(matchedPair)
      }
    }
    return matchedPair
  }

  // launch every task near-simultaneously, small stagger between launch
  for (const matchedPair of matchups) {
    // no await before handleRebalance to not wait
    rebalanceTasks.push(handleRebalance(matchedPair))
    await sleep(STAGGERED_LAUNCH_MS, { quiet: true })
  }

  console.log(
    `${getDate()}\n\n    All ${rebalanceTasks.length} parallel rebalances launched! M-M-M-M-M-MONSTER REBALANCING\n`
  )

  // now we wait until every rebalance task is done & returns a value
  const rebalanceResults = await Promise.all(rebalanceTasks)
  rebalanceResults.sort((a, b) => b.run - a.run)
  console.log(
    `${getDate()} ALL TASKS DONE:\n` +
      rebalanceResults
        .map(
          r =>
            `${(r.run - 1).toFixed(0).padStart(3)} rebalancing runs done for` +
            ` ${r.localHeavy.alias} --> ${r.remoteHeavy.alias} `
        )
        .join('\n')
  )
}

// look into previous rebalances and look if any of peerOptions work
// return index of suitable peer in peerOptions or -1 if none found
const findGoodPeerMatch = ({ remoteChannel, peerOptions }) => {
  // start a list of potential candidates
  const localCandidates = []
  const uniquePeers = {}

  // get historic info if available
  const logFileData = readRecord(remoteChannel.public_key)

  // remove balancing attempts below basic useful ppm
  const balancingData = logFileData.rebalance?.filter(b => b.ppm < subtractSafety(remoteChannel.my_fee_rate)) || []

  // no past rebalance info for this remote heavy peer
  if (balancingData.length === 0) return -1

  // list made of just very recent (time wise) rebalances list to rule out very recent repeats
  // some results like timeout & no path between peers wont' show up in records
  const recentBalances = balancingData.filter(b => Date.now() - b.t < MIN_MINUTES_BETWEEN_SAME_PAIR * 1000 * 60)

  // sort ppm from low to high
  // balancingData.sort((a, b) => a.ppm - b.ppm)

  // go through historic events
  // and add potential candidates
  for (const pastAttempt of balancingData) {
    // find full info peer info based on recorded public key
    const pastAttemptPeerPublicKey = pastAttempt.peer
    // in case old data missing public key
    if (!pastAttemptPeerPublicKey) continue
    // match previously used peer pk to current peer options pk
    const peer = peerOptions.find(p => p.public_key === pastAttemptPeerPublicKey)
    // no current peer found w/ this past attempt's public key
    if (!peer) continue
    // check that it hasn't been this channels match in last MIN_MINUTES_BETWEEN_SAME_PAIR
    const passesChecks = !recentBalances.find(b => b.public_key === pastAttemptPeerPublicKey)

    if (passesChecks) {
      // adds this peer public key to the current suitable candidates list
      if (!uniquePeers[pastAttemptPeerPublicKey]) localCandidates.push(pastAttemptPeerPublicKey)
      // notes this peer's attempts
      if (uniquePeers[pastAttemptPeerPublicKey]) uniquePeers[pastAttemptPeerPublicKey].push(pastAttempt)
      else uniquePeers[pastAttemptPeerPublicKey] = [pastAttempt]
    }
  }
  if (localCandidates.length === 0) return -1

  // sort by median ppm for that peer
  localCandidates.sort(
    (a, b) => median(uniquePeers[a].map(r => r.ppm)).o.median - median(uniquePeers[b].map(r => r.ppm)).o.median
  )

  // temporary
  // localCandidates.forEach(cpk => {
  //   console.log(`${cpk} ${median(uniquePeers[cpk].map(r => r.ppm)).o.median} n:${uniquePeers[cpk].length}`)
  // })

  // * 4 will help return undefined about half the time so -1 so still some random peer searching
  const winningCandidatePublicKey = localCandidates[trunc(random() * random() * localCandidates.length * 4)]
  const winningOptionIndex = peerOptions.findIndex(p => p.public_key === winningCandidatePublicKey)

  // pick random peer, ones added at lower ppm or multiple times have more chance
  return winningOptionIndex
}

// gets peers info including using previous slow to generate snapshot data
// can use await generateSnapshots() instead to get fully updated stats for _all_ peers
const runBotGetPeers = async ({ all = false } = {}) => {
  const getMyFees = await bos.getFees()
  const getPeers = all
    ? await bos.peers({
        is_active: undefined,
        is_public: undefined
        // earnings_days: DAYS_FOR_STATS // too little info
      })
    : await bos.peers()

  // add to default peer data
  const peers = getPeers
    .map(p => {
      p.my_fee_rate = +getMyFees[p.public_key] || 0
      doBonusPeerCalcs(p)
      return p
    })
    // remove offline peers if not all to be shown
    .filter(p => !p.is_offline || all)
    // sort by local sats by default
    .sort((a, b) => b.outbound_liquidity - a.outbound_liquidity)

  // add any needed numbers calculated just last time snapshots were created
  addDetailsFromSnapshot(peers)
  // add weight
  peers.forEach(p => {
    p.rndWeight = WEIGHT(p)
  })
  return peers
}

// fix and add calculations
const doBonusPeerCalcs = p => {
  p.inbound_fee_rate = +p.inbound_fee_rate || 0
  p.inbound_liquidity = +p.inbound_liquidity || 0
  p.outbound_liquidity = +p.outbound_liquidity || 0
  p.totalSats = p.inbound_liquidity + p.outbound_liquidity
  p.balance = +(p.outbound_liquidity / p.totalSats).toFixed(3)
  p.unbalancedSatsSigned = trunc(p.outbound_liquidity * 0.5 - p.inbound_liquidity * 0.5)
  p.unbalancedSats = abs(p.unbalancedSatsSigned)
}

/*
// update each peer in array of oldPeers in-place
const runBotUpdatePeers = async oldPeers => {
  const newPeers = await runBotGetPeers()
  for (const p of oldPeers) {
    for (const newPeer of newPeers) {
      if (p.public_key === newPeer.public_key) {
        // redo the calc from before w/o changing peer object reference
        // p.my_fee_rate = +getMyFees[p.public_key]
        p.my_fee_rate = newPeer.my_fee_rate
        p.inbound_liquidity = newPeer.inbound_liquidity
        p.outbound_liquidity = newPeer.outbound_liquidity
        doBonusPeerCalcs(p)
        break
      }
    }
  }
}
*/

// how many sats I need for balance vs how much I'll probably get in _ days
// + check info is reliable via more than 1 recent sample or 1 very recent sample
// + check this isn't an emergency shortage situation
const acceptableFlowToLocal = p =>
  -p.unbalancedSatsSigned < (p.routed_in_msats / DAYS_FOR_STATS / 1000) * DAYS_FOR_FEE_REDUCTION &&
  daysAgo(p.routed_in_last_at) < DAYS_FOR_STATS / 2 &&
  !isVeryRemoteHeavy(p) && // not emergency where waiting is not an option
  !isNetOutflowing(p)
const acceptableFlowToRemote = p =>
  p.unbalancedSatsSigned < (p.routed_out_msats / DAYS_FOR_STATS / 1000) * DAYS_FOR_FEE_REDUCTION &&
  daysAgo(p.routed_out_last_at) < DAYS_FOR_STATS / 2 &&
  !isVeryLocalHeavy(p) && // not emergency where waiting is not an option
  !isNetInflowing(p)

// allow these channels to be used as a remote heavy channel in a rebalance
const includeForRemoteHeavyRebalance = p =>
  // balance on remote side beyond min-off-balance or enough for max rebalance size
  isRemoteHeavy(p) &&
  // large enough channel
  p.totalSats >= MIN_CHAN_SIZE &&
  // enough sats to balance
  p.unbalancedSats > MIN_REBALANCE_SATS &&
  // only if no settings about it or if no setting for no remote-heavy rebalance true
  !getRuleFromSettings({ alias: p.alias })?.no_remote_rebalance &&
  // supposed rebalance fee unrealistically small
  subtractSafety(p.my_fee_rate) > MIN_FEE_RATE_FOR_REBALANCE &&
  // rebalance fee (max) should be larger than incoming fee rate
  // or it's literally impossible since last hop costs more ppm already
  subtractSafety(p.my_fee_rate) > p.inbound_fee_rate &&
  // insufficient existing flow to remote side recently
  !acceptableFlowToLocal(p)

// allow these channels to be used as a local heavy channel in a rebalance
const includeForLocalHeavyRebalance = p =>
  // balance on my side beyond min-off-balance or enough for max rebalance size
  isLocalHeavy(p) &&
  p.totalSats >= MIN_CHAN_SIZE &&
  p.unbalancedSats > MIN_REBALANCE_SATS &&
  // only if no settings about it or if no setting for no local-heavy rebalance true
  !getRuleFromSettings({ alias: p.alias })?.no_local_rebalance &&
  // insufficient existing flow to local side recently
  !acceptableFlowToRemote(p)

// check settings for rules matching as substring of this alias
const getRuleFromSettings = ({ alias }) => {
  // get rule
  const rule = mynode.settings?.rules?.find(r => alias?.toLowerCase().includes(r.aliasMatch.toLowerCase()))
  // remove notes (so can print out rules cleaner)
  if (rule) {
    Object.keys(rule).forEach(name => {
      if (name.includes('NOTE')) delete rule[name]
    })
  }
  return rule
}

// reconnection timer handling
const runBotReconnectCheck = async () => {
  const now = Date.now()
  const timers = JSON.parse(fs.readFileSync(TIMERS_PATH))

  // check if earlier reconnect is necessary

  // get list of all peers and active peers to check if enough are online
  const allPeers = await runBotGetPeers({ all: true })
  const peers = await runBotGetPeers()

  // check if too many peers are offline
  console.boring(`${getDate()} Online peers: ${peers.length} / ${allPeers.length}`)

  if (1 - peers.length / allPeers.length > PEERS_OFFLINE_MAXIMUM) {
    // emergency reconnect - running reconnect early!
    console.log(`${getDate()} too many peers offline. Running early reconnect.`)
    await runBotConnectionCheck()
    // update timer
    fs.writeFileSync(
      TIMERS_PATH,
      JSON.stringify({
        ...timers,
        lastReconnect: now
      })
    )

    console.log(`${getDate()} Updated ${TIMERS_PATH}`)

    return null
  }

  // otherwise check for scheduled one
  const lastReconnect = timers.lastReconnect || 0
  const timeSince = now - lastReconnect
  const isTimeForReconnect = timeSince > 1000 * 60 * MINUTES_BETWEEN_RECONNECTS
  const minutesSince = (timeSince / (1000.0 * 60)).toFixed(1)
  console.log(
    `${getDate()} ${
      isTimeForReconnect ? 'Time to run' : 'Skipping'
    } BoS reconnect. (${MINUTES_BETWEEN_RECONNECTS} minutes timer)` +
      ` Last run: ${lastReconnect === 0 ? 'never' : `${minutesSince} minutes ago at ${getDate(lastReconnect)}`}`
  )
  if (isTimeForReconnect) {
    // check for internet / tor issues
    await runBotConnectionCheck()

    // update timer
    fs.writeFileSync(
      TIMERS_PATH,
      JSON.stringify({
        ...timers,
        lastReconnect: now
      })
    )

    console.log(`${getDate()} Updated ${TIMERS_PATH}`)
  }
}

// fee update timer handling
const runUpdateFeesCheck = async () => {
  const now = Date.now()
  const timers = JSON.parse(fs.readFileSync(TIMERS_PATH))
  const lastFeeUpdate = timers.lastFeeUpdate || 0
  const timeSince = now - lastFeeUpdate
  const isTimeForFeeUpdate = timeSince > 1000 * 60 * MINUTES_BETWEEN_FEE_CHANGES
  const minutesSince = (timeSince / (1000.0 * 60)).toFixed(1)
  console.log(
    `${getDate()} ${
      isTimeForFeeUpdate ? 'Time to run' : 'Skipping'
    } fee/channel gossiped updates. (${MINUTES_BETWEEN_FEE_CHANGES} minutes timer)` +
      ` Last run: ${lastFeeUpdate === 0 ? 'never' : `${minutesSince} minutes ago at ${getDate(lastFeeUpdate)}`}`
  )
  if (isTimeForFeeUpdate) {
    // update fees
    await updateFees()
    // update timer
    fs.writeFileSync(
      TIMERS_PATH,
      JSON.stringify({
        ...timers,
        lastFeeUpdate: now
      })
    )
    console.log(`${getDate()} Updated ${TIMERS_PATH}`)
  }
}

// logic for updating fees (v3)
const updateFees = async () => {
  if (!ADJUST_FEES) return null
  console.boring(`${getDate()} updateFees() v3`)

  // generate brand new snapshots
  const allPeers = await generateSnapshots()

  // just set max htlcs for small channels first
  // those likely still count for failures
  const smallPeers = allPeers.filter(
    p =>
      !p.is_offline &&
      !p.is_pending &&
      !p.is_private &&
      p.is_active &&
      // just small channels
      p.totalSats <= MIN_CHAN_SIZE
  )
  for (const peer of smallPeers) {
    console.boring(
      `${getDate()} "${peer.alias}" small channels < ${pretty(MIN_CHAN_SIZE)} ` +
        'sats capacity limit (skipping fee adjustments)'
    )
    await bos.setPeerPolicy({
      peer_key: peer.public_key,
      by_channel_id: sizeMaxHTLC(peer)
    })
  }

  // adjust fees & max htlcs for normal channels
  const peers = allPeers.filter(
    p =>
      !p.is_offline &&
      !p.is_pending &&
      !p.is_private &&
      p.is_active &&
      // leave small channels alone
      p.totalSats > MIN_CHAN_SIZE
  )

  let nIncreased = 0
  let nDecreased = 0

  let feeChangeSummary = `${getDate()} Fee change summary`

  for (const peer of peers) {
    // current stats
    const now = Date.now()
    const ppmOld = peer.my_fee_rate
    const flowOutRecentDaysAgo = +((now - peer.routed_out_last_at) / (1000 * 60 * 60 * 24)).toFixed(1)
    const logFileData = readRecord(peer.public_key)

    // check if there are rules about this peer
    const rule = getRuleFromSettings({ alias: peer.alias })
    // check for any hard rule violations and instantly correct if found
    let ruleFix = -1
    if (rule?.min_ppm !== undefined && ppmOld < rule.min_ppm) ruleFix = rule.min_ppm
    if (rule?.max_ppm !== undefined && ppmOld > rule.max_ppm) ruleFix = rule.max_ppm
    // apply rule change if any found
    if (ruleFix >= 0) {
      console.log(`${getDate()} ${ca(peer.alias)} : rule required change ${ppmOld} -> ${ruleFix} ppm`)
      const resSetFee = await bos.setFees(peer.public_key, ruleFix)
      appendRecord({
        peer,
        newRecordData: {
          lastFeeIncrease: now, // unique here
          feeChanges: [
            {
              t: now,
              ppm: resSetFee,
              // for ppm vs Fout data
              ppm_old: ppmOld,
              routed_out_msats: peer.routed_out_msats,
              daysNoRouting: flowOutRecentDaysAgo
            },
            ...(logFileData?.feeChanges || [])
          ]
        }
      })
      continue // move onto next peer
    }

    const applyRules = ppmIn => {
      ppmIn = rule?.min_ppm !== undefined ? max(rule.min_ppm, ppmIn) : ppmIn
      ppmIn = rule?.max_ppm !== undefined ? min(rule.max_ppm, ppmIn) : ppmIn
      ppmIn = max(min(MAX_PPM_ABSOLUTE, ppmIn), MIN_PPM_ABSOLUTE)
      return trunc(ppmIn)
    }

    let isIncreasing = flowOutRecentDaysAgo < DAYS_FOR_FEE_INCREASE

    let isDecreasing =
      !isIncreasing &&
      flowOutRecentDaysAgo > DAYS_FOR_FEE_REDUCTION &&
      // safer to just skip VERY-remote-heavy channels to avoid false measurements of 0 flow out
      !isVeryRemoteHeavy(peer)

    const flowString = `${isNetOutflowing(peer) ? 'outflowing' : isNetInflowing(peer) ? ' inflowing' : '   no flow'}`
    const flowOutDaysString =
      flowOutRecentDaysAgo > DAYS_FOR_STATS
        ? `${DAYS_FOR_STATS}+`.padStart(5)
        : flowOutRecentDaysAgo.toFixed(1).padStart(5)

    feeChangeSummary += '\n'

    let ppmNew = ppmOld

    if (isIncreasing) ppmNew = applyRules(ppmOld * (1 + NUDGE_UP)) + 1
    else if (isDecreasing) ppmNew = applyRules(ppmOld * (1 - NUDGE_DOWN))
    // double check with rules
    if (ppmNew === ppmOld) [isIncreasing, isDecreasing] = [false, false]

    // assemble warnings
    const warnings = isVeryRemoteHeavy(peer) ? '⛔-VRH' : '-'

    // get the rest of channel policies figured out
    const localSats = ((peer.outbound_liquidity / 1e6).toFixed(1) + 'M').padStart(5)
    const remoteSats = ((peer.inbound_liquidity / 1e6).toFixed(1) + 'M').padEnd(5)

    if (isIncreasing) {
      nIncreased++

      // prettier-ignore
      const feeIncreaseLine = `${getDate()} ${ca(peer.alias).padEnd(30)} ${ppmOld.toFixed(0).padStart(5)} -> ${ppmNew.toFixed(0).padEnd(6)} ppm (-> ${(ppmNew + ')').padEnd(5)} ${flowString.padStart(15)} ${flowOutDaysString} days  ${localSats}|${remoteSats}  🔼`
      feeChangeSummary += feeIncreaseLine
      console.log(feeIncreaseLine)

      // do it
      // await bos.setFees(peer.public_key, ppmNew)
    } else if (isDecreasing) {
      nDecreased++

      // prettier-ignore
      const feeDecreaseLine = `${getDate()} ${ca(peer.alias).padEnd(30)} ${ppmOld.toFixed(0).padStart(5)} -> ${ppmNew.toFixed(0).padEnd(6)} ppm (-> ${(ppmNew + ')').padEnd(5)} ${flowString.padStart(15)} ${flowOutDaysString} days  ${localSats}|${remoteSats}  🔻`
      feeChangeSummary += feeDecreaseLine
      console.log(feeDecreaseLine)

      // do it
      // await bos.setFees(peer.public_key, ppmNew)
    } else {
      // prettier-ignore
      const feeNoChangeLine = `${getDate()} ${ca(peer.alias).padEnd(30)} ${ppmOld.toFixed(0).padStart(5)} -> same   ppm (-> ${(ppmOld + ')').padEnd(5)} ${flowString.padStart(15)} ${flowOutDaysString} days  ${localSats}|${remoteSats}  ${warnings}`
      feeChangeSummary += feeNoChangeLine
      console.log(feeNoChangeLine)
    }

    // do it
    const errorCodeOnChangeAttempt = await bos.setPeerPolicy({
      peer_key: peer.public_key,
      by_channel_id: sizeMaxHTLC(peer), // max htlc sizes
      fee_rate: ppmNew // fee rate
    })

    if (errorCodeOnChangeAttempt > 0) {
      // if no update, skip appending record & move on
      // most likely cause getInfo command doesn't have this channel info yet
      feeChangeSummary += '👮‍♂️-SKIPPED-BC-UNKNOWN-POLICY'
      continue
    }

    // update record if last recorded fee rate isn't what is last in last records
    if ((logFileData?.feeChanges || [])[0]?.ppm !== ppmOld) {
      appendRecord({
        peer,
        newRecordData: {
          ppmTargets: { ppmNew, daysNoRouting: flowOutRecentDaysAgo },
          feeChanges: [
            {
              t: now,
              ppm: ppmNew,
              // for ppm vs Fout data
              ppm_old: ppmOld,
              routed_out_msats: peer.routed_out_msats,
              daysNoRouting: flowOutRecentDaysAgo
            },
            ...(logFileData?.feeChanges || [])
          ]
        }
      })
    }
  }

  feeChangeSummary += '\n'
  const feeChangeTotals = `
    ${allPeers.length.toFixed(0).padStart(5, ' ')} peers
    ${peers.length.toFixed(0).padStart(5, ' ')} considered
    ${nIncreased.toFixed(0).padStart(5, ' ')} increased
    ${nDecreased.toFixed(0).padStart(5, ' ')} decreased
    ${(peers.length - nIncreased - nDecreased).toFixed(0).padStart(5, ' ')} unchanged
  `
  feeChangeSummary += feeChangeTotals
  console.log(feeChangeTotals)

  // make it available for review
  fs.writeFileSync(`${LOG_FILES}/${getDay()}_feeChanges.txt`, feeChangeSummary)
  fs.writeFileSync('_feeChanges.txt', feeChangeSummary)
}

// keep track of peers rebalancing attempts in files
// keep peers separate to avoid rewriting entirety of data at once on ssd
const appendRecord = ({ peer, newRecordData = {}, newRebalance = {} }, log = false) => {
  // filename uses 10 first digits of pubkey hex
  const fullPath = BALANCING_LOG_PATH + '/' + peer.public_key.slice(0, 10) + '.json'

  // read from old file if exists
  let oldRecord = {}
  try {
    oldRecord = JSON.parse(fs.readFileSync(fullPath))
  } catch (e) {
    log && console.log(`${getDate()} no previous ${fullPath} record detected`)
  }

  // combine with new datapoint
  const combinedRebalanceData = [
    newRebalance,
    // can remove filter and sort later
    ...(oldRecord?.rebalance?.filter(isNotEmpty).sort((a, b) => b.t - a.t) || [])
  ]
    .filter(isNotEmpty)
    // insane estimates are useless
    .filter(r => addSafety(r.ppm) <= MAX_PPM_ABSOLUTE)

  // calculate median ppms
  const ppmAll = median(combinedRebalanceData.map(b => b.ppm)).o
  const ppmWorked = median(combinedRebalanceData.filter(b => b.failed === false).map(b => b.ppm)).o

  // remove old data in future or weight higher recent data

  // update just this peers file
  const newFileData = {
    ...oldRecord,
    ...newRecordData,
    alias: peer.alias,
    public_key: peer.public_key,
    ppmAll,
    ppmWorked,
    rebalance: combinedRebalanceData
  }
  fs.writeFileSync(fullPath, JSON.stringify(newFileData, fixJSON, 2))

  log && console.log(`${getDate()} ${fullPath} "${peer.alias}" updated, ${combinedRebalanceData.length} records`)
}

const readRecord = publicKey => {
  const fullPath = BALANCING_LOG_PATH + '/' + publicKey.slice(0, 10) + '.json'
  let oldRecord = { rebalance: [] }
  try {
    if (fs.existsSync(fullPath)) {
      oldRecord = JSON.parse(fs.readFileSync(fullPath))
      // get rid of bad data and rediculous suggestions
      const balancingData = (oldRecord.rebalance || [])
        .filter(r => addSafety(r.ppm) <= MAX_PPM_ABSOLUTE)
        .filter(isNotEmpty)
      oldRecord = {
        ...oldRecord,
        rebalance: balancingData
      }
    }
  } catch (e) {
    //
  }
  return oldRecord
}

// generate data to save to files for easier external browsing
const generateSnapshots = async () => {
  console.boring(`${getDate()} generateSnapshots()`)

  // on-chain channel info switched to object with keys of channel "id" ("partner_public_key" inside)
  // bos treats peers like every channel is combined but can have multiple channels w/ diff id w/ same peer
  const getChannels = await bos.callAPI('getChannels')
  const idToPublicKey = {} // id -> public_key table
  const publicKeyToIds = {} // public_key -> id table
  const channelOnChainInfo = getChannels.channels.reduce((final, channel) => {
    const id = channel.id
    final[id] = channel

    // in case I need quick look up for id<->pubkey
    const pubkey = channel.partner_public_key
    idToPublicKey[id] = pubkey
    if (publicKeyToIds[pubkey]) publicKeyToIds[pubkey].push(id)
    else publicKeyToIds[pubkey] = [id]

    return final
  }, {})

  // my LN fee info (w/ base fees) switched to object by channel "id" as keys
  const getFeeRates = await bos.callAPI('getFeeRates')
  const feeRates = getFeeRates.channels.reduce((final, channel) => {
    final[channel.id] = channel
    return final
  }, {})

  // get all peers info
  const peers = await runBotGetPeers({ all: true })
  const publicKeyToAlias = {} // public_key -> alias table
  peers.forEach(p => {
    publicKeyToAlias[p.public_key] = p.alias
  })

  // specific routing events

  // gets every routing event indexed by out peer
  const peerForwardsByOuts = await bos.customGetForwardingEvents({
    days: DAYS_FOR_STATS
  })
  // make a by-inlets reference table copy with ins as keys
  const peerForwardsByIns = {}

  // create a reference array of forwards
  const forwardsAll = []

  // summarize results myself from individual forwading events
  const forwardsSum = {}
  for (const outPublicKey in peerForwardsByOuts) {
    if (!forwardsSum[outPublicKey]) forwardsSum[outPublicKey] = {}
    const peerEvents = peerForwardsByOuts[outPublicKey] // take this
    const peerSummary = forwardsSum[outPublicKey] // and summarize here
    peerSummary.public_key = outPublicKey
    peerSummary.alias = publicKeyToAlias[outPublicKey]
    const summary = peerEvents.reduce(
      (final, forward) => {
        if (forward.created_at_ms > final.routed_out_last_at) {
          final.routed_out_last_at = forward.created_at_ms
        }
        final.routed_out_msats += forward.mtokens
        final.routed_out_fees_msats += forward.fee_mtokens
        final.routed_out_count += 1

        // bonus add this forward to complete array
        forwardsAll.push(forward)
        // add this forward reference to -ByIns version
        if (!peerForwardsByIns[forward.incoming_peer]) {
          peerForwardsByIns[forward.incoming_peer] = []
        }
        peerForwardsByIns[forward.incoming_peer].push(forward)

        return final
      },
      {
        routed_out_last_at: 0,
        routed_out_msats: 0,
        routed_out_fees_msats: 0,
        routed_out_count: 0
      }
    )
    peerSummary.routed_out_last_at = summary.routed_out_last_at
    peerSummary.routed_out_msats = summary.routed_out_msats
    peerSummary.routed_out_fees_msats = summary.routed_out_fees_msats
    peerSummary.routed_out_count = summary.routed_out_count
  }
  // same thing for inlets
  for (const inPublicKey in peerForwardsByIns) {
    if (!forwardsSum[inPublicKey]) forwardsSum[inPublicKey] = {}
    const peerEvents = peerForwardsByIns[inPublicKey] // take this
    const peerSummary = forwardsSum[inPublicKey] // and summarize here
    peerSummary.public_key = inPublicKey
    peerSummary.alias = publicKeyToAlias[inPublicKey]
    const summary = peerEvents.reduce(
      (final, forward) => {
        if (forward.created_at_ms > final.routed_in_last_at) {
          final.routed_in_last_at = forward.created_at_ms
        }
        final.routed_in_msats += forward.mtokens
        final.routed_in_fees_msats += forward.fee_mtokens
        final.routed_in_count += 1
        return final
      },
      {
        routed_in_last_at: 0,
        routed_in_msats: 0,
        routed_in_fees_msats: 0,
        routed_in_count: 0
      }
    )
    peerSummary.routed_in_last_at = summary.routed_in_last_at
    peerSummary.routed_in_msats = summary.routed_in_msats
    peerSummary.routed_in_fees_msats = summary.routed_in_fees_msats
    peerSummary.routed_in_count = summary.routed_in_count
  }
  // now forwardsSum has rebalance inflow and outflow info by each channel as key

  // payments and received payments
  // get all payments from db
  const getPaymentEvents = await bos.customGetPaymentEvents({
    days: DAYS_FOR_STATS
  })
  // payments can be deleted so scan log file backups
  const res = fs.readdirSync(LOG_FILES) || []
  const paymentLogFiles = res.filter(f => f.match(/_paymentHistory/))
  const isRecent = t => Date.now() - t < DAYS_FOR_STATS * 24 * 60 * 60 * 1000
  VERBOSE && console.boring(`${getDate()} ${getPaymentEvents.length} payment records found in db`)
  for (const fileName of paymentLogFiles) {
    const timestamp = fileName.split('_')[0]
    console.boring(`${fileName} - is Recent? ${isRecent(timestamp)}`)
    if (!isRecent(timestamp)) continue // log file older than oldest needed record
    const payments = JSON.parse(fs.readFileSync(`${LOG_FILES}/${fileName}`))
    getPaymentEvents.push(...payments.filter(p => isRecent(p.created_at_ms)))
    VERBOSE && console.boring(`${getDate()} ${getPaymentEvents.length} payment records after log file`)
  }

  // get all received funds
  const getReceivedEvents = await bos.customGetReceivedEvents({
    days: DAYS_FOR_STATS,
    idKeys: true
  })
  // get just payments to myself
  const rebalances = getPaymentEvents.filter(p => p.destination === mynode.my_public_key)
  // get payments to others
  const paidToOthersLN = getPaymentEvents.filter(p => p.destination !== mynode.my_public_key)
  // get list of received payments and remove those from payments to self
  const receivedFromOthersLN = Object.assign({}, getReceivedEvents) // shallow clone
  rebalances.forEach(r => {
    delete receivedFromOthersLN[r.id]
  })

  // summarize rebalances for each peer
  const rebalancesByPeer = rebalances.reduce((final, r) => {
    const outPeerPublicKey = r.hops[0]
    const inPeerPublicKey = r.hops[r.hops.length - 1]
    const makeNewRebalanceSummary = pk => ({
      alias: publicKeyToAlias[pk],
      public_key: pk,
      rebalanced_out_last_at: 0,
      rebalanced_out_msats: 0,
      rebalanced_out_fees_msats: 0,
      rebalanced_out_count: 0,
      rebalanced_in_last_at: 0,
      rebalanced_in_msats: 0,
      rebalanced_in_fees_msats: 0,
      rebalanced_in_count: 0
    })

    if (!final[outPeerPublicKey]) {
      final[outPeerPublicKey] = makeNewRebalanceSummary(outPeerPublicKey)
    }

    if (!final[inPeerPublicKey]) {
      final[inPeerPublicKey] = makeNewRebalanceSummary(inPeerPublicKey)
    }

    // out
    final[outPeerPublicKey].rebalanced_out_last_at = max(
      final[outPeerPublicKey].rebalanced_out_last_at,
      r.created_at_ms
    )
    final[outPeerPublicKey].rebalanced_out_msats += r.mtokens
    final[outPeerPublicKey].rebalanced_out_fees_msats += r.fee_mtokens
    final[outPeerPublicKey].rebalanced_out_count += 1
    // in
    final[inPeerPublicKey].rebalanced_in_last_at = max(final[inPeerPublicKey].rebalanced_in_last_at, r.created_at_ms)
    final[inPeerPublicKey].rebalanced_in_msats += r.mtokens
    final[inPeerPublicKey].rebalanced_in_fees_msats += r.fee_mtokens
    final[inPeerPublicKey].rebalanced_in_count += 1

    return final
  }, {})

  // get networking data for each peer
  const networkingDataResult = await bos.callAPI('getpeers')
  const networkingData = networkingDataResult.peers.reduce((final, p) => {
    final[p.public_key] = p
    return final
  }, {})

  // ==================== add in all extra new data for each peer ==================
  peers.forEach(peer => {
    // fee_earnings is from bos peer call with days specified, not necessary hmm

    // place holders for rebelancing data
    peer.rebalanced_out_last_at = rebalancesByPeer[peer.public_key]?.rebalanced_out_last_at || 0
    peer.rebalanced_out_msats = rebalancesByPeer[peer.public_key]?.rebalanced_out_msats || 0
    peer.rebalanced_out_fees_msats = rebalancesByPeer[peer.public_key]?.rebalanced_out_fees_msats || 0
    peer.rebalanced_out_count = rebalancesByPeer[peer.public_key]?.rebalanced_out_count || 0

    peer.rebalanced_in_last_at = rebalancesByPeer[peer.public_key]?.rebalanced_in_last_at || 0
    peer.rebalanced_in_msats = rebalancesByPeer[peer.public_key]?.rebalanced_in_msats || 0
    peer.rebalanced_in_fees_msats = rebalancesByPeer[peer.public_key]?.rebalanced_in_fees_msats || 0
    peer.rebalanced_in_count = rebalancesByPeer[peer.public_key]?.rebalanced_in_count || 0

    // add fee data
    peer.routed_out_last_at = forwardsSum[peer.public_key]?.routed_out_last_at || 0
    peer.routed_out_msats = forwardsSum[peer.public_key]?.routed_out_msats || 0
    peer.routed_out_fees_msats = forwardsSum[peer.public_key]?.routed_out_fees_msats || 0
    peer.routed_out_count = forwardsSum[peer.public_key]?.routed_out_count || 0

    peer.routed_in_last_at = forwardsSum[peer.public_key]?.routed_in_last_at || 0
    peer.routed_in_msats = forwardsSum[peer.public_key]?.routed_in_msats || 0
    peer.routed_in_fees_msats = forwardsSum[peer.public_key]?.routed_in_fees_msats || 0
    peer.routed_in_count = forwardsSum[peer.public_key]?.routed_in_count || 0

    peer.socket = networkingData[peer.public_key]?.socket // rest of uri
    peer.bytes_sent = networkingData[peer.public_key]?.bytes_sent
    peer.bytes_received = networkingData[peer.public_key]?.bytes_received
    peer.is_inbound = networkingData[peer.public_key]?.is_inbound // who opened
    peer.ping_time = networkingData[peer.public_key]?.ping_time
    peer.reconnection_rate = networkingData[peer.public_key]?.reconnection_rate
    peer.last_reconnection = networkingData[peer.public_key]?.last_reconnection
    // array of supported features 'bit type'
    peer.features = networkingData[peer.public_key]?.features?.map(f => `${f.bit} ${f.type}`)

    // experimental
    // calculateFlowRateMargin(peer)

    // initialize capacity (sum below from each individual channel to this peer)
    // more constant measure of total sats indifferent from inflight htlcs & reserves
    peer.capacity = 0

    // grab array of separate short channel id's for this peer
    const ids = publicKeyToIds[peer.public_key]

    // convert array of text ids to array of info for each ids channel
    peer.ids = ids.reduce((final, id) => {
      // if any of the our channels are active I'll mark peer as active
      peer.is_active = !!peer.is_active || channelOnChainInfo[id].is_active
      peer.unsettled_balance = (peer.unsettled_balance || 0) + channelOnChainInfo[id].unsettled_balance
      // add up capacities which can be different from total sats if in flight sats
      peer.capacity += channelOnChainInfo[id].capacity

      // add this info for each of peer's channels separately
      final.push({
        // pick what to put into peers file here for each channel id
        id,
        transaction_id: channelOnChainInfo[id].transaction_id,
        transaction_vout: channelOnChainInfo[id].transaction_vout,

        base_fee_mtokens: +feeRates[id].base_fee_mtokens,
        capacity: channelOnChainInfo[id].capacity,
        sent: channelOnChainInfo[id].sent,
        received: channelOnChainInfo[id].received,
        onlineTimeFraction: +(
          channelOnChainInfo[id].time_online /
          (channelOnChainInfo[id].time_online + channelOnChainInfo[id].time_offline)
        ).toFixed(5),
        is_active: channelOnChainInfo[id].is_active,
        unsettled_balance: channelOnChainInfo[id].unsettled_balance,

        // bugged in bos call getChannels right now? max gives "huge numbers" or min gives "0"
        local_max_pending_mtokens: +channelOnChainInfo[id].local_max_pending_mtokens,
        remote_max_pending_mtokens: +channelOnChainInfo[id].remote_max_pending_mtokens,
        local_min_htlc_mtokens: +channelOnChainInfo[id].local_min_htlc_mtokens,
        remote_min_htlc_mtokens: +channelOnChainInfo[id].remote_min_htlc_mtokens,

        local_reserve: channelOnChainInfo[id].local_reserve,
        remote_reserve: channelOnChainInfo[id].remote_reserve,

        local_csv: channelOnChainInfo[id].local_csv,
        remote_csv: channelOnChainInfo[id].remote_csv,

        local_max_htlcs: channelOnChainInfo[id].local_max_htlcs,
        remote_max_htlcs: channelOnChainInfo[id].remote_max_htlcs,

        local_balance: channelOnChainInfo[id].local_balance,
        remote_balance: channelOnChainInfo[id].remote_balance,
        is_opening: channelOnChainInfo[id].is_opening,
        is_closing: channelOnChainInfo[id].is_closing,
        is_partner_initiated: channelOnChainInfo[id].is_partner_initiated,
        is_anchor: channelOnChainInfo[id].is_anchor,
        commit_transaction_fee: channelOnChainInfo[id].commit_transaction_fee,
        commit_transaction_weight: channelOnChainInfo[id].commit_transaction_weight
      })

      return final
    }, [])
  })

  const totalLocalSatsOffBalance = peers.reduce(
    (sum, peer) => (peer.unbalancedSatsSigned > 0 ? sum + peer.unbalancedSatsSigned : sum),
    0
  )
  const totalRemoteSatsOffBalance = peers.reduce(
    (sum, peer) => (peer.unbalancedSatsSigned < 0 ? sum + peer.unbalancedSatsSigned : sum),
    0
  )
  const totalLocalSats = peers.reduce((sum, peer) => sum + peer.outbound_liquidity, 0)
  const totalRemoteSats = peers.reduce((sum, peer) => sum + peer.inbound_liquidity, 0)
  const totalUnsettledSats = peers.reduce((sum, peer) => sum + peer.unsettled_balance, 0)

  // idea for normalized metric "unbalanced %"
  // 2 * sats-away-from-balance / total capacity * 100%
  // completely unbalanced would be like 2*5M/10M = 100%
  // complete balanced would be 0 / 10M = 0%
  const totalSatsOffBalance = peers.reduce((sum, peer) => sum + peer.unbalancedSats, 0)
  const totalCapacity = peers.reduce((sum, peer) => sum + peer.totalSats, 0)
  const unbalancedPercent = (((2.0 * totalSatsOffBalance) / totalCapacity) * 100).toFixed(0)

  const totalSatsOffBalanceSigned = peers.reduce((sum, peer) => sum + peer.unbalancedSatsSigned, 0)

  const baseFeesStats = median(getFeeRates.channels.map(d => +d.base_fee_mtokens)).s
  const ppmFeesStats = median(getFeeRates.channels.map(d => d.fee_rate)).s
  const channelCapacityStats = median(
    getChannels.channels.map(d => d.capacity),
    { f: pretty }
  ).s

  const totalEarnedFromForwards = peers.reduce((t, p) => t + p.routed_out_fees_msats, 0) / 1000

  const statsEarnedPerPeer = median(
    peers.filter(p => p.routed_out_last_at).map(p => p.routed_out_fees_msats / 1000),
    { f: pretty }
  ).s

  const totalPeersRoutingIn = peers.filter(p => p.routed_in_last_at).length
  const totalPeersRoutingOut = peers.filter(p => p.routed_out_last_at).length

  const chainFeesSummary = await bos.getChainFeesChart({ days: DAYS_FOR_STATS })

  const balances = await bos.getDetailedBalance()

  // get totals from payments and received
  const totalReceivedFromOthersLN =
    Object.values(receivedFromOthersLN).reduce((t, r) => t + r.received_mtokens, 0) / 1000
  const totalSentToOthersLN = paidToOthersLN.reduce((t, p) => t + p.mtokens, 0) / 1000
  const totalRebalances = rebalances.reduce((t, p) => t + p.mtokens, 0) / 1000

  const totalRebalancedFees = rebalances.reduce((t, p) => t + p.fee_mtokens, 0) / 1000
  const totalSentToOthersFees = paidToOthersLN.reduce((t, p) => t + p.fee_mtokens, 0) / 1000

  // stats with individual forwards resolution by size in msats ranges
  const rangeTops = [1e5, 1e7, 1e9, 1e11]
  const forwardStatsInitial = rangeTops.reduce(
    (ac, a) => ({ ...ac, [String(a)]: { mtokens: 0, count: 0, fee_mtokens: 0 } }),
    {}
  )
  const forwardStats = forwardsAll.reduce((final, it) => {
    for (const top of rangeTops) {
      if (it.mtokens < top) {
        final[String(top)].count = final[String(top)].count + 1
        final[String(top)].mtokens = final[String(top)].mtokens + it.mtokens
        final[String(top)].fee_mtokens = final[String(top)].fee_mtokens + it.fee_mtokens
        break // done with this forward
      }
    }
    return final
  }, forwardStatsInitial)

  const totalForwardsCount = forwardsAll.length
  const totalRouted = forwardsAll.reduce((t, f) => t + f.mtokens / 1000, 0)

  const totalChainFees = chainFeesSummary.data.reduce((t, v) => t + v, 0)

  const totalFeesPaid = totalRebalancedFees

  const totalProfit = totalEarnedFromForwards - totalChainFees - totalFeesPaid

  peers.forEach(p => {
    // add this experimental flow rate calc (temp)
    // calculateFlowRateMargin(p)
    // calculate weight for each peer
    p.rndWeight = WEIGHT(p)
  })

  // prettier-ignore
  const nodeSummary = `${getDate()}

  NODE SUMMARY:

    total peers:                      ${peers.length}

    off-chain local available:        ${pretty(totalLocalSats)} sats
    off-chain remote available:       ${pretty(totalRemoteSats)} sats
    off-chain total:                  ${pretty(balances.offchain_balance * 1e8)} sats
    off-chain unsettled:              ${pretty(totalUnsettledSats)} sats
    off-chain pending                 ${pretty(balances.offchain_pending * 1e8)} sats

    on-chain closing:                 ${pretty(balances.closing_balance * 1e8)} sats
    on-chain total:                   ${pretty(balances.onchain_balance * 1e8)} sats
  -------------------------------------------------------------
    my base fee stats:                ${baseFeesStats} msats
    my proportional fee stats:        ${ppmFeesStats} ppm
    my channel capacity stats:        ${channelCapacityStats} sats
  -------------------------------------------------------------
    (Per last ${DAYS_FOR_STATS} days)

    total earned:                     ${pretty(totalEarnedFromForwards)} sats
    total on-chain fees:              ${pretty(totalChainFees)} sats
    total ln fees paid:               ${pretty(totalFeesPaid)} sats

    NET PROFIT:                       ${pretty(totalProfit)} sats

    total forwarded:                  ${pretty(totalRouted)} sats (n: ${totalForwardsCount})

    forwards stats by size:

          0 - 100 sats                ${(pretty(forwardStats[String(1e5)].mtokens / 1000) + ' sats routed').padEnd(26)} (n: ${pretty(forwardStats[String(1e5)].count)})
                                      ${(pretty(forwardStats[String(1e5)].fee_mtokens / 1000) + ' sats earned').padEnd(26)} (${pretty(forwardStats[String(1e5)].fee_mtokens / forwardStats[String(1e5)].mtokens * 1e6)} ppm)

        100 - 10k sats                ${(pretty(forwardStats[String(1e7)].mtokens / 1000) + ' sats routed').padEnd(26)} (n: ${pretty(forwardStats[String(1e7)].count)})
                                      ${(pretty(forwardStats[String(1e7)].fee_mtokens / 1000) + ' sats earned').padEnd(26)} (${pretty(forwardStats[String(1e7)].fee_mtokens / forwardStats[String(1e7)].mtokens * 1e6)} ppm)

        10k - 1M sats                 ${(pretty(forwardStats[String(1e9)].mtokens / 1000) + ' sats routed').padEnd(26)} (n: ${pretty(forwardStats[String(1e9)].count)})
                                      ${(pretty(forwardStats[String(1e9)].fee_mtokens / 1000) + ' sats earned').padEnd(26)} (${pretty(forwardStats[String(1e9)].fee_mtokens / forwardStats[String(1e9)].mtokens * 1e6)} ppm)

         1M - 100M sats               ${(pretty(forwardStats[String(1e11)].mtokens / 1000) + ' sats routed').padEnd(26)} (n: ${pretty(forwardStats[String(1e11)].count)})
                                      ${(pretty(forwardStats[String(1e11)].fee_mtokens / 1000) + ' sats earned').padEnd(26)} (${pretty(forwardStats[String(1e11)].fee_mtokens / forwardStats[String(1e11)].mtokens * 1e6)} ppm)

    peers used for routing-out:       ${totalPeersRoutingOut} / ${peers.length}
    peers used for routing-in:        ${totalPeersRoutingIn} / ${peers.length}
    earned per peer stats:            ${statsEarnedPerPeer} sats

    LN received from others:          ${pretty(totalReceivedFromOthersLN)} sats (n: ${Object.keys(receivedFromOthersLN).length})
    LN payments to others:            ${pretty(totalSentToOthersLN)} sats, fees: ${pretty(totalSentToOthersFees)} sats (n: ${paidToOthersLN.length})
    LN total rebalanced:              ${pretty(totalRebalances)} sats, fees: ${pretty(totalRebalancedFees)} (n: ${rebalances.length})

    % routed/local                    ${(totalRouted / totalLocalSats * 100).toFixed(0)} %
    avg earned/routed:                ${(totalEarnedFromForwards / totalRouted * 1e6).toFixed(0)} ppm
    avg net-profit/routed:            ${(totalProfit / totalRouted * 1e6).toFixed(0)} ppm
    avg earned/local:                 ${(totalEarnedFromForwards / totalLocalSats * 1e6).toFixed(0)} ppm
    avg net-profit/local:             ${(totalProfit / totalLocalSats * 1e6).toFixed(0)} ppm
    est. annual ROI:                  ${(totalProfit / DAYS_FOR_STATS * 365.25 / totalLocalSats * 100).toFixed(3)} %
    est. annual profit:               ${pretty(totalProfit / DAYS_FOR_STATS * 365.25)} sats
  -------------------------------------------------------------
    total unbalanced local:           ${pretty(totalLocalSatsOffBalance)} sats
    total unbalanced remote:          ${pretty(abs(totalRemoteSatsOffBalance))} sats
    total unbalanced:                 ${pretty(totalSatsOffBalance)} sats
    total unbalanced sats percent:    ${unbalancedPercent}%
    net unbalanced:                   ${pretty(totalSatsOffBalanceSigned)} sats
    ${
  totalSatsOffBalanceSigned > MIN_SATS_OFF_BALANCE
    ? '  (lower on inbound liquidity, get/rent others to open channels to you' +
          ' or loop-out/boltz/muun/WoS LN to on-chain funds)'
    : ''
}
    ${
  totalSatsOffBalanceSigned < MIN_SATS_OFF_BALANCE
    ? '  (lower on local sats, so open channels to increase local or reduce' +
          ' amount of remote via loop-in or opening channel to sinks like LOOP)'
    : ''
}
  `
  console.log(nodeSummary)

  // by channel flow rate summary

  // sort by most to least flow total, normalized by capacity
  // higher rating uses capacity better and recommended for size up
  // lower rating uses capacity worse or not at all and recommended for changes
  // const score = p => (p.routed_out_msats + p.routed_in_msats) / p.capacity // uses available capacity best
  // const score = p => ((p.routed_out_fees_msats + p.routed_in_fees_msats) / p.capacity) * 1e6 // best returns for available capacity
  const score = p => p.routed_out_fees_msats + p.routed_in_fees_msats // best returns overall

  peers.sort((a, b) => score(b) - score(a))

  let flowRateSummary = `${getDate()} - over ${DAYS_FOR_STATS} days, sorted in desc. order by score = ${score}\n\n    `
  for (const [i, p] of peers.entries()) {
    const local = ((p.outbound_liquidity / 1e6).toFixed(1) + 'M').padStart(5, '-')
    const remote = ((p.inbound_liquidity / 1e6).toFixed(1) + 'M').padEnd(5, '-')
    const rebIn = pretty(p.rebalanced_in_msats / DAYS_FOR_STATS / 1000) + ' sats/day'
    const rebOut = pretty(p.rebalanced_out_msats / DAYS_FOR_STATS / 1000) + ' sats/day'
    const rebOutFees = pretty(p.rebalanced_out_fees_msats / DAYS_FOR_STATS / 1000) + ' sats/day'
    const rebOutPpm = ((p.rebalanced_out_fees_msats / p.rebalanced_out_msats) * 1e6 || 0).toFixed(0) + ')'

    const rebInPpm = '(' + ((p.rebalanced_in_fees_msats / p.rebalanced_in_msats) * 1e6 || 0).toFixed(0)

    const routeIn = pretty(p.routed_in_msats / DAYS_FOR_STATS / 1000) + ' sats/day'
    const routeOut = pretty(p.routed_out_msats / DAYS_FOR_STATS / 1000) + ' sats/day'
    const routeOutEarned = pretty(p.routed_out_fees_msats / DAYS_FOR_STATS / 1000) + ' sats/day'
    const routeOutPpm = ((p.routed_out_fees_msats / p.routed_out_msats) * 1e6 || 0).toFixed(0) + ')'

    const routeInPpm = '(' + ((p.routed_in_fees_msats / p.routed_in_msats) * 1e6 || 0).toFixed(0)

    const record = readRecord(p.public_key)
    const rebalanceHistory = median(record.rebalance.filter(r => !r.failed).map(r => r.ppm))
    const rebalanceSuggestionHistory = median(record.rebalance.map(r => r.ppm))
    const lastPpmChange = (record.feeChanges || [])[0]
    const lastPpmChangeMinutes = lastPpmChange && ((Date.now() - (lastPpmChange.t || 0)) / (1000 * 60)).toFixed(0)
    const lastPpmChangeString =
      lastPpmChange && lastPpmChange.ppm_old
        ? `last ∆ppm: ${lastPpmChange.ppm_old}->${lastPpmChange.ppm}ppm @ ${lastPpmChangeMinutes} minutes ago`
        : ''

    const lastRoutedIn = (Date.now() - p.routed_in_last_at) / (1000 * 60 * 60 * 24)
    const lastRoutedInString =
      lastRoutedIn > DAYS_FOR_STATS
        ? `routed-in (<--) ${DAYS_FOR_STATS}+ days ago`
        : `routed-in (<--) ${lastRoutedIn.toFixed(1)} days ago`
    const lastRoutedOut = (Date.now() - p.routed_out_last_at) / (1000 * 60 * 60 * 24)
    const lastRoutedOutString =
      lastRoutedOut > DAYS_FOR_STATS
        ? `routed-out (-->) ${DAYS_FOR_STATS}+ days ago`
        : `routed-out (-->) ${lastRoutedOut.toFixed(1)} days ago`

    const issues = []

    if (p.rebalanced_out_msats > 0 && p.rebalanced_in_msats > 0) issues.push('2-WAY-REBALANCE')
    // warning if fee is lower than needed for rebalancing on remote heavy channel with no flow in
    if (
      p.outbound_liquidity < 1e6 &&
      p.capacity > MIN_CHAN_SIZE &&
      p.routed_in_msats === 0 &&
      rebalanceSuggestionHistory.o.median &&
      addSafety(rebalanceSuggestionHistory.o.bottom25) > p.my_fee_rate
    ) {
      issues.push('FEE-STUCK-LOW')
    }

    const issuesString = issues.length > 0 ? '🚨 ' + issues.join(', ') : ''
    const lifetimeSent = p.ids.reduce((sum, c) => c.sent + sum, 0)
    const lifeTimeReceived = p.ids.reduce((sum, c) => c.received + sum, 0)
    const capacityTotal = p.ids.reduce((sum, c) => c.capacity + sum, 0)
    const capacityUsed = ((lifetimeSent + lifeTimeReceived) / capacityTotal).toFixed(1)

    // prettier-ignore
    flowRateSummary += `${('#' + (i + 1)).padStart(4)} ${pretty(score(p))}
      ${' '.repeat(15)}me  ${(p.my_fee_rate + 'ppm').padStart(7)} [-${local}--|--${remote}-] ${(p.inbound_fee_rate + 'ppm').padEnd(7)} ${p.alias} (./peers/${p.public_key.slice(0, 10)}.json) ${p.balance.toFixed(1)}b ${isNetOutflowing(p) ? 'F_net-->' : ''}${isNetInflowing(p) ? '<--F_net' : ''} ${issuesString}
      ${dim}${routeIn.padStart(26)} <---- routing ----> ${routeOut.padEnd(23)} +${routeOutEarned.padEnd(17)} ${routeInPpm.padStart(5)}|${routeOutPpm.padEnd(10)} ${('#' + p.routed_in_count).padStart(5)}|#${p.routed_out_count.toString().padEnd(5)}${undim}
      ${dim}${rebIn.padStart(26)} <-- rebalancing --> ${rebOut.padEnd(23)} -${rebOutFees.padEnd(17)} ${rebInPpm.padStart(5)}|${rebOutPpm.padEnd(10)} ${('#' + p.rebalanced_in_count).padStart(5)}|#${p.rebalanced_out_count.toString().padEnd(5)}${undim}
      ${dim}${' '.repeat(17)}rebalances-in (<--) used (ppm): ${rebalanceHistory.s}${undim}
      ${dim}${' '.repeat(17)}rebalances-in (<--) est. (ppm): ${rebalanceSuggestionHistory.s}${undim}
      ${dim}${' '.repeat(17)}${lastRoutedInString}, ${lastRoutedOutString}, ${lastPpmChangeString || 'no ppm change data found'}${undim}
      ${dim}${' '.repeat(17)}lifetime ${capacityUsed}x capacity used${undim} = ${pretty(lifetimeSent)} sats sent (-->) + ${pretty(lifeTimeReceived)} sats received (<--)
    `
  }
  // too much screen space, easier to look up from file
  // console.log(flowRateSummary)

  // write LN state snapshot to files
  fs.writeFileSync(`${SNAPSHOTS_PATH}/channelOnChainInfo.json`, JSON.stringify(channelOnChainInfo, fixJSON, 2))
  fs.writeFileSync(`${SNAPSHOTS_PATH}/publicKeyToIds.json`, JSON.stringify(publicKeyToIds, fixJSON, 2))
  fs.writeFileSync(`${SNAPSHOTS_PATH}/idToPublicKey.json`, JSON.stringify(idToPublicKey, fixJSON, 2))
  fs.writeFileSync(`${SNAPSHOTS_PATH}/publicKeyToAlias.json`, JSON.stringify(publicKeyToAlias, fixJSON, 2))
  fs.writeFileSync(`${SNAPSHOTS_PATH}/feeRates.json`, JSON.stringify(feeRates, fixJSON, 2))
  fs.writeFileSync(`${SNAPSHOTS_PATH}/forwardsSum.json`, JSON.stringify(forwardsSum, fixJSON, 2))
  // rebalances sums by peer
  fs.writeFileSync(`${SNAPSHOTS_PATH}/rebalancesSum.json`, JSON.stringify(rebalancesByPeer, fixJSON, 2))
  // highly detailed peer info
  fs.writeFileSync(`${LOG_FILES}/${getDay()}_peers.json`, JSON.stringify(peers, fixJSON, 2))
  fs.writeFileSync(`${SNAPSHOTS_PATH}/peers.json`, JSON.stringify(peers, fixJSON, 2))
  fs.writeFileSync('_peers.json', JSON.stringify(peers, fixJSON, 2)) // got tired of opening folder

  // public key to peers.json index lookup table
  fs.writeFileSync(
    `${SNAPSHOTS_PATH}/peersIndex.json`,
    JSON.stringify(
      peers.reduce((f, p, i) => {
        f[p.public_key] = i
        return f
      }, {}),
      fixJSON,
      2
    )
  )

  // flow rates summary
  fs.writeFileSync(`${LOG_FILES}/${getDay()}_flowSummary.txt`, flowRateSummary.replace(stylingPatterns, ''))
  fs.writeFileSync('_flowSummary.txt', flowRateSummary.replace(stylingPatterns, ''))
  // node summary
  fs.writeFileSync(`${LOG_FILES}/${getDay()}_nodeSummary.txt`, nodeSummary)
  fs.writeFileSync('_nodeSummary.txt', nodeSummary)

  // too much data to write constantly
  // fs.writeFileSync(
  //   `${SNAPSHOTS_PATH}/forwardsByIns.json`,
  //   JSON.stringify(peerForwardsByIns, fixJSON, 2)
  // )
  fs.writeFileSync(`${SNAPSHOTS_PATH}/forwardsByOuts.json`, JSON.stringify(peerForwardsByOuts, fixJSON, 2))
  // rebalance list array
  // fs.writeFileSync(
  //   `${SNAPSHOTS_PATH}/rebalances.json`,
  //   JSON.stringify(rebalances, fixJSON, 2)
  // )

  const message = `🌱 Statistics for ${DAYS_FOR_STATS} days:

earned: ${pretty(totalEarnedFromForwards)}
spent: ${pretty(totalFeesPaid + totalChainFees)}
net: ${pretty(totalProfit)}
routing rewards: ${
    median(
      forwardsAll.map(f => f.fee_mtokens / 1000.0),
      { pr: 1 }
    ).s
  }
`
  const { token, chat_id } = mynode.settings?.telegram || {}
  if (token && chat_id) bos.sayWithTelegramBot({ token, chat_id, message })

  return peers
}

// experimental (read slow to calculate peers.json for flowrate info)
const addDetailsFromSnapshot = peers => {
  const path = `${SNAPSHOTS_PATH}/peers.json`
  const pathIndex = `${SNAPSHOTS_PATH}/peersIndex.json`
  const flowrates = fs.existsSync(path) && JSON.parse(fs.readFileSync(path))
  const index = fs.existsSync(pathIndex) && JSON.parse(fs.readFileSync(pathIndex))
  if (!index || !flowrates) return null

  for (const p of peers) {
    const i = index[p.public_key]
    if (i === undefined) {
      p.routed_out_msats = 0
      p.routed_in_msats = 0
    } else {
      p.routed_out_msats = p.routed_out_msats || flowrates[i].routed_out_msats || 0
      p.routed_in_msats = p.routed_in_msats || flowrates[i].routed_in_msats || 0
    }
    // calculateFlowRateMargin(p)
  }
}

// 1. check internet connection, when ok move on
// 2. do bos reconnect
// 3. get updated complete peer info
// 4. peers offline high = reset tor & rerun entire check after delay
const runBotConnectionCheck = async ({ quiet = false } = {}) => {
  console.boring(`${getDate()} runBotConnectionCheck()`)

  // check for basic internet connection
  const isInternetConnected = await dns.promises
    .lookup('google.com')
    .then(() => true)
    .catch(() => false)
  console.log(`${getDate()} Connected to clearnet internet? ${isInternetConnected}`)

  // keep trying until internet connects
  if (!isInternetConnected) {
    await sleep(2 * 60 * 1000)
    return await runBotConnectionCheck()
  }

  // run bos reconnect
  if (ALLOW_BOS_RECONNECT) await bos.reconnect(true)

  await sleep(1 * 60 * 1000, { msg: 'Small delay before checking online peers again' })

  const peers = await runBotGetPeers({ all: true })

  if (!peers || peers.length === 0) return console.warn('no peers')

  const peersOffline = peers.filter(p => p.is_offline)

  const peersTotal = peers.length
  const message =
    `🍳 BoS reconnect done (every ${MINUTES_BETWEEN_RECONNECTS} minutes):` +
    ` there are ${peersOffline.length} / ${peersTotal}` +
    ` peers offline, ${((peersOffline.length / peersTotal) * 100).toFixed(0)}%.` +
    ` Offline: ${peersOffline.map(p => p.alias).join(', ') || 'n/a'}`

  // update user about offline peers just in case
  console.log(`${getDate()} ${message}`)
  const { token, chat_id } = mynode.settings?.telegram || {}
  if (!quiet && token && chat_id) bos.sayWithTelegramBot({ token, chat_id, message })

  // skip if set to not reset tor or unused
  if (!ALLOW_TOR_RESET) return 0
  // all good
  if (peersOffline.length / peersTotal <= PEERS_OFFLINE_MAXIMUM) return 0

  console.log(`${getDate()} Restarting tor...`)

  // process.exit(1) // temp

  // tor restarting shell command here
  // create request file for script with sudo permission at current timestamp
  // when it sees higher timestamp it will execute the action and erase the request file
  // and write result to resetDone.json file
  const RESET_REQUEST_PATH = 'resetRequest.json'
  const RESET_ACTION_PATH = 'resetDone.json'
  const requestTime = Date.now()
  fs.writeFileSync(RESET_REQUEST_PATH, JSON.stringify({ id: requestTime }))

  // give it a LOT of time (could be lots of things updating)
  await sleep(20 * 60 * 1000)

  if (fs.existsSync(RESET_REQUEST_PATH)) {
    console.log(`${getDate()} tor reset failed, request file still there. resetHandler not running?`)
    process.exit(1)
  }
  const res = JSON.parse(fs.readFileSync(RESET_ACTION_PATH))
  if (res.id !== requestTime) {
    console.log(`${getDate()} tor reset failed, request read but no updated action file found`)
    process.exit(1)
  }

  console.log(`${getDate()} tor seems to been reset, rechecking everything again`)
  // process.exit(0)

  // recheck offline peers again
  return runBotConnectionCheck()
}

// starts everything
const initialize = async () => {
  //
  // get your own public key
  const getIdentity = await bos.callAPI('getIdentity')
  if (!getIdentity.public_key || getIdentity.public_key.length < 10) {
    throw new Error('unknown public key')
  }
  mynode.my_public_key = getIdentity.public_key

  const feeUpdatesPerDay = floor((60 * 24) / MINUTES_BETWEEN_FEE_CHANGES)

  // const updateNudge = (now, nudge, target) => now * (1 - nudge) + target * nudge
  // const maxUpFeeChangePerDay = [...Array(feeUpdatesPerDay)].reduce(f => updateNudge(f, NUDGE_UP, 100), 0)
  // const maxDownFeeChangePerDay = [...Array(feeUpdatesPerDay)].reduce(f => updateNudge(f, NUDGE_DOWN, 100), 0)

  const maxUpFeeChangePerDay = ((1 + NUDGE_UP) ** feeUpdatesPerDay - 1) * 100
  const maxDownFeeChangePerDay = (1 - (1 - NUDGE_DOWN) ** feeUpdatesPerDay) * 100

  console.log(`${getDate()}
  ========================================================

    this node's public key:

      "${mynode.my_public_key}"

    max fee rate change per day is

      up:   ${maxUpFeeChangePerDay.toFixed(1)} %
        (if routed-out last ${DAYS_FOR_FEE_INCREASE} days)

      down: ${maxDownFeeChangePerDay.toFixed(1)} %
        (if no routing-out for ${DAYS_FOR_FEE_REDUCTION} days)


    IF THIS IS INCORRECT, ctrl + c

  ========================================================
  `)

  // make folders for all the files I use
  if (!fs.existsSync(BALANCING_LOG_PATH)) {
    fs.mkdirSync(BALANCING_LOG_PATH, { recursive: true })
  }
  if (!fs.existsSync(SNAPSHOTS_PATH)) {
    fs.mkdirSync(SNAPSHOTS_PATH, { recursive: true })
  }
  if (!fs.existsSync(LOG_FILES)) {
    fs.mkdirSync(LOG_FILES, { recursive: true })
  }

  // load settings file
  if (fs.existsSync(SETTINGS_PATH)) {
    mynode.settings = JSON.parse(fs.readFileSync(SETTINGS_PATH))
  }

  // generate timers file if there's not one
  if (!fs.existsSync(TIMERS_PATH)) {
    fs.writeFileSync(
      TIMERS_PATH,
      JSON.stringify({
        lastReconnect: 0,
        lastFeeUpdate: 0
      })
    )
  }

  // generate snapshots at start for easy access to data
  await generateSnapshots()

  await sleep(5 * 1000)

  // start bot loop
  runBot()
}

// const subtractSafety = ppm => trunc(max(min(ppm - SAFETY_MARGIN_FLAT_MAX, ppm / SAFETY_MARGIN), 0))
// const addSafety = ppm => trunc(max(ppm + SAFETY_MARGIN_FLAT_MAX, ppm * SAFETY_MARGIN))

const addSafety = ppm => trunc(min(ppm * SAFETY_MARGIN + 1, ppm + SAFETY_MARGIN_FLAT_MAX))
const subtractSafety = ppm => trunc(max((ppm - 1) / SAFETY_MARGIN, ppm - SAFETY_MARGIN_FLAT_MAX, 0))

const isRemoteHeavy = p => p.unbalancedSatsSigned < -MIN_SATS_OFF_BALANCE

const isLocalHeavy = p => p.unbalancedSatsSigned > MIN_SATS_OFF_BALANCE

const isNetOutflowing = p => p.routed_out_msats - p.routed_in_msats > 0

const isNetInflowing = p => p.routed_out_msats - p.routed_in_msats < 0

// very remote heavy = very few sats on local side, the less the remote-heavier
const isVeryRemoteHeavy = p => p.outbound_liquidity < MIN_SATS_PER_SIDE
// very local heavy = very few sats on remote side, the less the local-heavier
const isVeryLocalHeavy = p => p.inbound_liquidity < MIN_SATS_PER_SIDE

const daysAgo = ts => (Date.now() - ts) / (1000 * 60 * 60 * 24)

const pretty = n => String(trunc(n || 0)).replace(/\B(?=(\d{3})+\b)/g, '_')

const getDate = timestamp => (timestamp ? new Date(timestamp) : new Date()).toISOString()
const getDay = () => new Date().toISOString().slice(0, 10)

const fixJSON = (k, v) => (v === undefined ? null : v)

const isEmpty = obj => !!obj && Object.keys(obj).length === 0 && obj.constructor === Object
const isNotEmpty = obj => !isEmpty(obj)

console.boring = (...args) => console.log(`${dim}${args}${undim}`)

// rounds down to nearest power of 10
// const floor10 = v => pow(10, floor(log10(v)))
// rounds down to nearest power of 2
const floor2 = v => pow(2, floor(log2(v)))

const sizeMaxHTLC = peer =>
  peer.ids?.reduce((final, channel) => {
    const { local_balance } = channel
    // shouldn't happen
    if (local_balance === undefined) return final

    // round down to nearest 2^X for max htlc to minimize failures and hide exact balances
    const safeHTLC = max(1, floor2(local_balance)) * 1000
    final[channel.id] = { max_htlc_mtokens: safeHTLC }

    console.boring(`  ${channel.id} max htlc safe size to be set to ${pretty(safeHTLC / 1000)} sats`)

    return final
  }, {})

// if quiet nothing is printed and exit request isn't checked
const sleep = async (ms, { msg = '', quiet = false } = {}) => {
  if (quiet) return await new Promise(resolve => setTimeout(resolve, trunc(ms)))

  const seconds = ms / 1000
  const minutes = seconds / 60
  const t = minutes >= 1 ? minutes.toFixed(1) + ' minutes' : seconds.toFixed(1) + ' seconds'
  if (msg) msg = '\n  ' + msg
  console.log(`${getDate()}\n${msg}\n    Paused for ${t}, ctrl + c to exit\n`)

  // easy way to stop script remotely is to create PLEASESTOP.json in script folder
  // and it will terminate script and remove json file during safe spot sleep is used at
  if (fs.existsSync('PLEASESTOP.json')) {
    fs.unlinkSync('PLEASESTOP.json')
    console.log(`${getDate()} script termination request via PLEASESTOP.json granted`)
    process.exit(0)
  }

  return await new Promise(resolve => setTimeout(resolve, trunc(ms)))
}
const stylingPatterns = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g

// clean alias from emoji & non standard characters
const ca = alias => alias.replace(/[^\x00-\x7F]/g, '').trim() // .replace(/[\u{0080}-\u{10FFFF}]/gu,'');

// console log colors
const dim = '\x1b[2m'
const undim = '\x1b[0m'

// returns mean, truncated fractions
const median = (numbers = [], { f = v => v, pr = 0 } = {}) => {
  const sorted = numbers
    .slice()
    .filter(v => !isNaN(v))
    .sort((a, b) => a - b)
  const n = sorted.length
  if (!numbers || numbers.length === 0 || n === 0) {
    // return !obj ? '(n: 0)' : { n: 0 }
    return { s: '(n: 0)', o: { n: 0 } }
  }
  const middle = floor(sorted.length * 0.5)
  const middleTop = floor(sorted.length * 0.75)
  const middleBottom = floor(sorted.length * 0.25)

  const tr = fl => +fl.toFixed(pr)

  const result = {
    n,
    avg: f(tr(sorted.reduce((sum, val) => sum + val, 0) / sorted.length)),
    bottom: f(tr(sorted[0])),
    bottom25: f(
      sorted.length % 4 === 0 ? tr((sorted[middleBottom - 1] + sorted[middleBottom]) / 2.0) : tr(sorted[middleBottom])
    ),
    median: f(sorted.length % 2 === 0 ? tr((sorted[middle - 1] + sorted[middle]) / 2.0) : tr(sorted[middle])),
    top75: f(sorted.length % 4 === 0 ? tr((sorted[middleTop - 1] + sorted[middleTop]) / 2.0) : tr(sorted[middleTop])),
    top: f(tr(sorted[numbers.length - 1]))
  }

  const { bottom, bottom25, median, avg, top75, top } = result

  // const stringOutput = JSON.stringify(result, fixJSON)
  const stringOutput =
    `(n: ${n}) min: ${bottom}, 1/4th: ${bottom25}, ` + `median: ${median}, avg: ${avg}, 3/4th: ${top75}, max: ${top}`

  // return !obj ? stringOutput : result
  return { s: stringOutput, o: result }
}

// returns sorted array using weighted randomness function for order
const rndWeightedSort = (arr, w = () => 1) => {
  // shallow copy
  const newArr = arr.slice()
  // use rnd with weight to get weighted randomness
  for (const p of newArr) p.rndWeightUsed = w(p) * random()
  // sort array using that activated weight
  newArr.sort((a, b) => b.rndWeightUsed - a.rndWeightUsed)
  return newArr
}

initialize()
