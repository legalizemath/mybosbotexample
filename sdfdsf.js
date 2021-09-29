// NOT SAFE TO RUN
dfgdfgdfgdfgdfg

import fs from 'fs' // to read/write log files
import dns from 'dns' // to check if node is online
import bos from './bos.js' // wrapper for bos

const { min, max, trunc, floor, abs, random, sqrt } = Math

// time to sleep between trying a bot step again
const MINUTES_BETWEEN_STEPS = 5

// minimum sats away from 0.5 balance to consider off-balance
const MIN_SATS_OFF_BALANCE = 420e3
// unbalanced sats below this can stop (bos rebalance exits <50k)
const MIN_REBALANCE_SATS = 51e3
// limit of sats to balance per attempt
// (bos one does probing + size up htlc strategy)
const MAX_REBALANCE_SATS = 212121 * 2
// sats to balance via keysends
const MAX_REBALANCE_SATS_SEND = 212121
// rebalance with faster keysends after bos rebalance works
// (faster but higher risk of stuck sats so I send less)
const USE_KEYSENDS_AFTER_BALANCE = true

// might cause tor issues if too much bandwidth being used maybe?
const MAX_PARALLEL_REBALANCES = 10

// channels smaller than this not necessary to balance or adjust fees for
// usually special cases anyway
// (maybe use proportional fee policy for them instead)
// >2m for now
const MIN_CHAN_SIZE = 5 * (MIN_REBALANCE_SATS + MIN_SATS_OFF_BALANCE)

// multiplier for proportional safety ppm margin
const SAFETY_MARGIN = 1.618 // 1.15
// minimum flat safety ppm margin & min for remote heavy channels
const SAFETY_MARGIN_FLAT = 222
// rebalancing fee rates below this aren't considered for rebalancing
const MIN_FEE_RATE_FOR_REBALANCE = 1

// max size of fee adjustment to target ppm (upward)
const NUDGE_UP = 0.0069
// max size of fee adjustment to target ppm (downward)
const NUDGE_DOWN = NUDGE_UP / 2
// max days since last successful routing out to allow increasing fee
const DAYS_FOR_FEE_INCREASE = 1.2
// min days of no routing activity before allowing reduction in fees
const DAYS_FOR_FEE_REDUCTION = 2.1

// minimum ppm ever possible
const MIN_PPM_ABSOLUTE = 0
// any ppm above this is not considered for fees, rebalancing, or suggestions
const MAX_PPM_ABSOLUTE = 2992

// smallest amount of sats necessary to consider a side not drained
const MIN_SATS_PER_SIDE = 1000e3

// max minutes to spend per rebalance try
const MINUTES_FOR_REBALANCE = 5
// max minutes to spend per keysend try
const MINUTES_FOR_SEND = 3
// time between retrying same good pair
const MIN_MINUTES_BETWEEN_SAME_PAIR = (MINUTES_BETWEEN_STEPS + MINUTES_FOR_REBALANCE) * 2
// max repeats to balance if successful
const MAX_BALANCE_REPEATS = 69

// allow adjusting fees
const ADJUST_FEES = true

// as 0-profit fee rate increases, fee rate where where proportional
// fee takes over flat one is
// (break even fee rate) * SAFETY_MARGIN = SAFETY_MARGIN_FLAT

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

// hours between running bos reconnect
const MINUTES_BETWEEN_RECONNECTS = 42
// how often to update fees
const MINUTES_BETWEEN_FEE_CHANGES = 121

// show everything
const VERBOSE = true

// what to weight random selection by
const WEIGHT_OPTIONS = {
  // 2x more sats from balance is 2x more likely to be selected
  UNBALANCED_SATS: peer => peer.unbalancedSats,
  // 2x more sats from balance is ~1.4x more likely to be selected
  // better for trying more channel combinations still favoring unabalanced
  UNBALANCED_SATS_SQRT: peer => trunc(sqrt(peer.unbalancedSats)),
  UNBALANCED_SATS_SQRTSQRT: peer => trunc(sqrt(sqrt(peer.unbalancedSats))),
  CHANNEL_SIZE: peer => peer.totalSats,
  FLOW_MARGIN: peer => abs(peer.flowMarginWithRules),
  FLOW_MARGIN_SQRT: peer => trunc(sqrt(abs(peer.flowMarginWithRules))),
  FLAT: () => 1
}
const WEIGHT = WEIGHT_OPTIONS.UNBALANCED_SATS_SQRTSQRT

// experimental - fake small flowrate to be ready to expect
const MIN_FLOWRATE_PER_DAY = 10000 // sats/day

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
  await runBotRebalaceOrganizer()
  await sleep(1 * 60 * 1000, { msg: 'Experimental rebalance done' }) // temporary

  // try a rebalance
  await runBotUpdateStep()

  // pause
  await sleep(MINUTES_BETWEEN_STEPS * 60 * 1000)

  // restart
  runBot()
}

// experimental parallel rebalancing function (unsplit, wip)
const runBotRebalaceOrganizer = async () => {
  console.boring(`${getDate()} runBotRebalaceOrganizer()`)
  // match up peers
  // high weight lets channels get to pick good peers first (not always to occasionally search for better matches)

  const peers = await runBotGetPeers()
  // make a list of remote heavy and local heavy peers via balance check
  const remoteHeavyPeers = rndWeightedSort(peers.filter(includeForRemoteHeavyRebalance), WEIGHT)
  const localHeavyPeers = rndWeightedSort(peers.filter(includeForLocalHeavyRebalance), WEIGHT)

  // temporary printout
  console.log(`${getDate()} Peer weight / balance / alias`)
  if (false) {
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

  // assemble list of matching peers and how much to rebalance
  const matchups = []

  // keep going until one side clear
  while (localHeavyPeers.length > 0 && remoteHeavyPeers.length > 0) {
    // get top lucky channels
    const localHeavy = localHeavyPeers[0]
    const remoteHeavy = remoteHeavyPeers[0]

    // max amount to rebalance is the smaller sats off-balance between the two
    const maxSatsToRebalance = trunc(min(localHeavy.unbalancedSats, remoteHeavy.unbalancedSats))

    // grab my outgoing fee for remote heavy peer
    const myOutgoingFee = remoteHeavy.my_fee_rate
    const maxRebalanceFee = subtractSafety(myOutgoingFee)

    // add this peer pair to matchups
    // run keeps track of n times matchup ran
    // done keeps track of done tasks
    // started at keeps track of time taken
    // results keeps 1+ return values from bos function
    matchups.push({
      localHeavy,
      remoteHeavy,
      maxSatsToRebalance,
      myOutgoingFee,
      maxRebalanceFee,
      run: 1,
      done: false,
      startedAt: Date.now(),
      results: []
    })

    // remove these peers from peer lists
    localHeavyPeers.splice(0, 1)
    remoteHeavyPeers.splice(0, 1)

    // stop if limit reached
    if (matchups.length >= MAX_PARALLEL_REBALANCES) break
  }

  if (VERBOSE) {
    console.log(`${getDate()} rebalance matchups:\n`)
    for (const match of matchups) {
      const outOf = ca(match.localHeavy.alias).padStart(30)
      const into = ca(match.remoteHeavy.alias).padEnd(30)
      console.log(`  me --> ${outOf} --> ? --> ${into} --> me`)
    }
    console.log('')
  }

  // to keep track of list of launched rebalancing tasks
  const rebalanceTasks = []
  const STAGGERED_LAUNCH_MS = 1111 // ms to put between each launch for safety
  const RETRY_ON_TIMEOUTS = true // experimental
  // function to launch every rebalance task for a matched pair with
  const handleRebalance = async matchedPair => {
    const { localHeavy, remoteHeavy, maxSatsToRebalance, maxRebalanceFee, run, startedAt } = matchedPair
    const localString = ca(localHeavy.alias).padStart(25)
    const remoteString = ca(remoteHeavy.alias).padEnd(25)
    // task launch message
    console.log(
      `${getDate()} Starting run #${run} ${localString}-->${remoteString}` +
        ` rebalance ${pretty(maxSatsToRebalance).padStart(10)} sats @ ${maxRebalanceFee.padStart(4)} ppm`
    )
    const maxSatsToRebalanceAfterRules = min(maxSatsToRebalance, MAX_REBALANCE_SATS)
    const resBalance = await bos.rebalance(
      {
        fromChannel: localHeavy.public_key,
        toChannel: remoteHeavy.public_key,
        maxSats: maxSatsToRebalanceAfterRules,
        maxMinutes: MINUTES_FOR_REBALANCE,
        maxFeeRate: maxRebalanceFee,
        retryOnTimeout: RETRY_ON_TIMEOUTS
      },
      undefined,
      {} // show nothing, too many things happening
    )
    const taskLength = ((Date.now() - startedAt) / 1000 / 60).toFixed(1) + ' minutes'
    matchedPair.results.push(resBalance)
    if (resBalance.failed) {
      // fail
      matchedPair.done = true
      const tasksDone = matchups.reduce((count, m) => (m.done ? count + 1 : count), 0)
      const reason = resBalance.msg[1] // 2nd item in error array from bos
      const reasonString = resBalance.ppmSuggested
        ? `(Reason: needed ${resBalance.ppmSuggested}ppm) `
        : `(Reason: ${reason}) `
      console.log(
        `${getDate()} run #${run} ${localString}-->${remoteString} ${maxRebalanceFee}ppm ` +
          `rebalance failed ${reasonString}` +
          `(${tasksDone}/${matchups.length} done after ${taskLength})`
      )
      // fails to be logged only when there's a useful suggested fee rate
      if (resBalance.ppmSuggested) {
        appendRecord({
          peer: remoteHeavy,
          newRebalance: {
            t: Date.now(),
            ppm: maxRebalanceFee,
            failed: true,
            peer: localHeavy.public_key,
            peerAlias: localHeavy.alias,
            sats: maxSatsToRebalanceAfterRules
          }
        })
      }
      return matchedPair
    } else {
      // succeess
      matchedPair.maxSatsToRebalance -= resBalance.rebalanced
      matchedPair.run++
      appendRecord({
        peer: remoteHeavy,
        newRebalance: {
          t: Date.now(),
          ppm: resBalance.fee_rate,
          failed: false,
          peer: localHeavy.public_key,
          peerAlias: localHeavy.alias,
          sats: resBalance.rebalanced
        }
      })
      if (matchedPair.maxSatsToRebalance < MIN_REBALANCE_SATS) {
        // successful & done
        matchedPair.done = true
        const tasksDone = matchups.reduce((count, m) => (m.done ? count + 1 : count), 0)
        console.log(
          `${getDate()} run #${run} ${localString}-->${remoteString} ${maxRebalanceFee}ppm max ` +
            `rebalance succeeded for ${pretty(resBalance.rebalanced)} sats @ ${resBalance.fee_rate}ppm 😁😁😁` +
            ` & done! 🍾🥂🏆 (${tasksDone}/${matchups.length} done after ${taskLength})`
        )
        return matchedPair
      } else {
        // successful & keep going
        console.log(
          `${getDate()} run #${run} ${localString}-->${remoteString} ${maxRebalanceFee}ppm max ` +
            `rebalance succeeded for ${pretty(resBalance.rebalanced)} sats @ ${resBalance.fee_rate}ppm 😁😁😁` +
            ` & moving onto run #${run + 1} (${pretty(matchedPair.maxSatsToRebalance)} sats left to balance)`
        )
        return await handleRebalance(matchedPair)
      }
    }
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
            ` ${r.localHeavy.alias}-->${r.remoteHeavy.alias} `
        )
        .join('\n')
  )
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

// organizes rebalancing
const runBotUpdateStep = async () => {
  console.boring(`${getDate()} runBotUpdateStep()`)

  let { localChannel, remoteChannel } = await runBotPickRandomPeers()

  if (!localChannel || !remoteChannel) {
    console.log(`${getDate()} no unbalanced pairs to match`)
    return undefined
  }

  // repeat rebalancing while it works
  for (let r = 1; r <= MAX_BALANCE_REPEATS; r++) {
    console.log(`\n${getDate()} Balancing run #${r}`)

    const balancing = await runBotRebalancePeers({ localChannel, remoteChannel }, r === 1)

    // on fail check to see if any good previous peer is available
    if (balancing.failed && r === 1) {
      localChannel = await findGoodPeer({ localChannel, remoteChannel })
      if (!localChannel) {
        console.log(`${getDate()} no good previous pair up available`)
        break
      }
      console.log(`${getDate()} switching to good peer "${localChannel.alias}" 💛💚💙💜`)
      // r = 0 // restart from run #1
      continue
    }
    // stop repeating if balancing still failed
    if (balancing.failed && r !== 1) break
    // update channels for next run
    await runBotUpdatePeers([localChannel, remoteChannel])
  }
  console.boring(`${getDate()} runBotUpdateStep() done`)
}

// pick random remote heavy and random local heavy channel using weight setting
const runBotPickRandomPeers = async () => {
  console.boring(`${getDate()} runBotPickRandomPeers()`)

  const peers = await runBotGetPeers()

  // make a list of remote heavy and local heavy peers via balance check
  const remoteHeavyPeers = peers.filter(includeForRemoteHeavyRebalance)
  const localHeavyPeers = peers.filter(includeForLocalHeavyRebalance)

  // nothing to pair up
  if (remoteHeavyPeers.length === 0 || localHeavyPeers.length === 0) return {}

  // Find random local-heavy and remote-heavy pair weighted by sats off-balance
  const remoteSats = remoteHeavyPeers.reduce((sum, p) => WEIGHT(p) + sum, 0)
  const localSats = localHeavyPeers.reduce((sum, p) => WEIGHT(p) + sum, 0)
  let remoteRoll = random() * remoteSats
  let localRoll = random() * localSats
  let remoteIndex = 0
  let localIndex = 0
  while (remoteRoll > 0) remoteRoll -= WEIGHT(remoteHeavyPeers[remoteIndex++])
  while (localRoll > 0) localRoll -= WEIGHT(localHeavyPeers[localIndex++])
  const remoteChannel = remoteHeavyPeers[remoteIndex - 1]
  const localChannel = localHeavyPeers[localIndex - 1]

  // experimental printout
  console.log(`${getDate()} Peer weight / balance / alias`)
  if (VERBOSE) {
    localHeavyPeers.sort((a, b) => WEIGHT(b) - WEIGHT(a))
    for (const p of localHeavyPeers) {
      const weight = WEIGHT(p)
      const w = pretty(weight).padStart(13)
      const b = p.balance.toFixed(2)
      if (weight !== undefined) {
        console.log(`Local-heavy: ${w}w ${b}b ${p.alias}`)
      }
    }
    remoteHeavyPeers.sort((a, b) => WEIGHT(b) - WEIGHT(a))
    for (const p of remoteHeavyPeers) {
      const weight = WEIGHT(p)
      const w = pretty(weight).padStart(12)
      const b = p.balance.toFixed(2)
      if (weight !== undefined) {
        console.log(`Remote-heavy: ${w}w ${b}b ${p.alias}`)
      }
    }
  }

  console.log(`${getDate()}
    Unbalanced pair matched randomly weighted by "${WEIGHT.toString()}":
    ${localChannel?.alias} from ${localHeavyPeers.length} local-heavy peers,
    ${remoteChannel?.alias} from ${remoteHeavyPeers.length} remote-heavy peers
  `)
  // ${VERBOSE ? JSON.stringify(remoteHeavyPeers.map(p => p.alias)) : ''}
  // ${VERBOSE ? JSON.stringify(localHeavyPeers.map(p => p.alias)) : ''}

  return { localChannel, remoteChannel }
}

// look into previous rebalances and look for peer
// with low ppm that has room to balance
const findGoodPeer = async ({ localChannel, remoteChannel }) => {
  // start a list of potential candidates
  const localCandidates = []
  const uniquePeers = {}

  // historic rebalancing ppm should be below this level
  const ppmCheck = subtractSafety(remoteChannel.my_fee_rate)

  // get updated active peer info
  const peers = await runBotGetPeers()

  // get historic info if available
  const logFileData = readRecord(remoteChannel.public_key)
  // const logFile = BALANCING_LOG_PATH + '/' + remoteChannel.public_key.slice(0, 10) + '.json'
  // const logFileData = !fs.existsSync(logFile) ? {} : JSON.parse(fs.readFileSync(logFile)) || {}

  // remove balancing attempts below basic useful ppm
  const balancingData = logFileData.rebalance?.filter(b => b.ppm < ppmCheck) || []

  // very recent rebalances list to rule out very recent peers
  const recentBalances = balancingData.filter(b => Date.now() - b.t < MIN_MINUTES_BETWEEN_SAME_PAIR * 1000 * 60)

  if (balancingData.length === 0) return null

  // sort ppm from low to high
  balancingData.sort((a, b) => a.ppm - b.ppm)

  // go through historic events
  // and add potential candidates
  for (const attempt of balancingData) {
    // find full info peer info based on recorded public key
    const candidatePublicKey = attempt.peer
    const peer = peers.find(p => p.public_key === candidatePublicKey)
    // no current peer found w/ this attemp's public key
    if (!peer) continue
    // determine is this is a good local-heavy match
    const goodMatch =
      // has to be different peer from localChannel before
      candidatePublicKey !== localChannel.public_key &&
      // and unbalanced enough in remote direction to rebalance
      peer.unbalancedSatsSigned > MIN_SATS_OFF_BALANCE &&
      // and this candidate can't be too recently used for this
      !recentBalances.find(b => b.public_key === candidatePublicKey) &&
      // and there can be no manual rules to block this as local-heavy peer
      !getRuleFromSettings({ alias: peer.alias })?.no_local_rebalance

    if (goodMatch) {
      localCandidates.push(peer)
      uniquePeers[peer.alias] = uniquePeers[peer.alias] ? uniquePeers[peer.alias] + 1 : 1
    }
  }

  if (localCandidates.length === 0) return null

  console.log(`${getDate()} good peers found: ${JSON.stringify(uniquePeers)}`)

  // pick random peer, ones added at lower ppm or multiple times have more chance
  return localCandidates[trunc(random() * random() * localCandidates.length)]
  // return localCandidates[0] // try lowest fee candidate
}

// gets peers info including using previous slow to generate snapshot data
// can use await generateSnapshots() instead to get fully updated stats for _all_ peers
const runBotGetPeers = async ({ all = false } = {}) => {
  const getMyFees = await bos.getFees()
  const getPeers = all
    ? await bos.peers({
        active: undefined,
        public: undefined
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
  // remove notes
  if (rule) {
    Object.keys(rule).forEach(name => {
      if (name.includes('NOTE')) delete rule[name]
    })
  }
  return rule
}

const runBotRebalancePeers = async ({ localChannel, remoteChannel }, isFirstRun = true) => {
  const maxFeeRate = subtractSafety(remoteChannel.my_fee_rate)
  const minUnbalanced = min(remoteChannel.unbalancedSats, localChannel.unbalancedSats)

  // true means just regular bos rebalance
  const doRebalanceInsteadOfKeysend = isFirstRun || !USE_KEYSENDS_AFTER_BALANCE

  const maxAmount = doRebalanceInsteadOfKeysend
    ? trunc(min(minUnbalanced, MAX_REBALANCE_SATS))
    : trunc(min(minUnbalanced, MAX_REBALANCE_SATS_SEND))

  // not enough imbalance to warrant rebalance
  if (maxAmount < MIN_REBALANCE_SATS) {
    console.log(
      `${getDate()} Close enough to balanced: ${pretty(maxAmount)} sats off-balance is below ${pretty(
        MIN_REBALANCE_SATS
      )} sats setting`
    )
    return { failed: true }
  }

  const rebalanceTime = doRebalanceInsteadOfKeysend ? MINUTES_FOR_REBALANCE : MINUTES_FOR_SEND
  const remoteRebalanceHistory = median(
    readRecord(remoteChannel.public_key)
      .rebalance.filter(r => !r.failed)
      .map(r => r.ppm)
  ).s

  // prettier-ignore
  console.log(`${getDate()} ${rebalanceTime} minutes limit

    ☂️  me  ${localChannel.my_fee_rate} ppm  ---|-  ${localChannel.inbound_fee_rate} ppm "${localChannel.alias}" ${localChannel.public_key.slice(0, 10)}
    ${(localChannel.outbound_liquidity / 1e6).toFixed(2)}M local sats --> (${(localChannel.inbound_liquidity / 1e6).toFixed(2)}M) --> ?

    ☂️  me _${remoteChannel.my_fee_rate}_ppm_  -|---  ${remoteChannel.inbound_fee_rate} ppm "${remoteChannel.alias}" ${remoteChannel.public_key.slice(0, 10)}
    (${(remoteChannel.outbound_liquidity / 1e6).toFixed(2)}M) <-- ${(remoteChannel.inbound_liquidity / 1e6).toFixed(2)}M remote sats <-- ?

    Attempt to rebalance max of ${pretty(maxAmount)} sats at max fee rate of ${maxFeeRate} ppm
    out of ${pretty(minUnbalanced)} sats left to balance for this pair
    Previous rebalances for remote-heavy channel: ${remoteRebalanceHistory}
  `)

  // do the rebalance
  // switch to keysends if that setting is on && not first run
  const resBalance = doRebalanceInsteadOfKeysend
    ? await bos.rebalance({
        fromChannel: localChannel.public_key,
        toChannel: remoteChannel.public_key,
        maxSats: maxAmount,
        maxMinutes: rebalanceTime,
        maxFeeRate
      })
    : await bos.send({
        destination: mynode.my_public_key,
        fromChannel: localChannel.public_key,
        toChannel: remoteChannel.public_key,
        sats: maxAmount,
        maxMinutes: rebalanceTime,
        maxFeeRate
      })

  // display successful rebalance cost
  if (!resBalance.failed) {
    console.log(
      `${getDate()} rebalanced ${pretty(resBalance.rebalanced)} sats at` +
        ` ${resBalance.fee_rate} ppm! (attempted ${maxFeeRate} ppm) 😁😁😁😁😁`
    )
  }

  // if rebalance worked, record it
  if (!resBalance.failed) {
    const workedRate = resBalance.fee_rate
    // record rebalance cost
    appendRecord({
      peer: remoteChannel,
      newRebalance: {
        t: Date.now(),
        ppm: workedRate,
        failed: false,
        peer: localChannel.public_key,
        peerAlias: localChannel.alias,
        sats: resBalance.rebalanced
      }
    })
  }

  // if rebalance possible but needs higher rate
  if (resBalance.failed && resBalance.ppmSuggested) {
    const suggestedFeeRate = resBalance.ppmSuggested
    console.log(
      `${getDate()} Attempted rebalance at ${maxFeeRate} ppm failed` + `, suggested ${suggestedFeeRate.toFixed(0)} ppm`
    )
    // record suggested rate on failed attempts
    appendRecord({
      peer: remoteChannel,
      newRebalance: {
        t: Date.now(),
        ppm: suggestedFeeRate,
        failed: true,
        peer: localChannel.public_key,
        peerAlias: localChannel.alias,
        sats: maxAmount
      }
    })
  } else if (resBalance.failed) {
    console.log(`${getDate()} Attempted rebalance at ${maxFeeRate} ppm failed:`, JSON.stringify(resBalance.msg))
  }

  return resBalance
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
    } bos reconnect. (${MINUTES_BETWEEN_RECONNECTS} minutes timer)` +
      ` Last run: ${lastReconnect === 0 ? 'never' : `${minutesSince}m ago at ${getDate(lastReconnect)}`}`
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
    } fee/channel updates. (${MINUTES_BETWEEN_FEE_CHANGES}m timer)` +
      ` Last run: ${lastFeeUpdate === 0 ? 'never' : `${minutesSince}m ago at ${getDate(lastFeeUpdate)}`}`
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
  console.boring(`${getDate()} updateFees() v3`)

  // generate brand new snapshots
  const allPeers = await generateSnapshots()
  // adjust fees for these channels
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

    const isIncreasing = ADJUST_FEES && flowOutRecentDaysAgo < DAYS_FOR_FEE_INCREASE

    const isDecreasing =
      ADJUST_FEES &&
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

    if (isIncreasing) {
      nIncreased++
      // at least +1
      ppmNew = applyRules(ppmOld * (1 + NUDGE_UP)) + 1

      // prettier-ignore
      const feeIncreaseLine = `${getDate()} ${ca(peer.alias).padEnd(30)} ${ppmOld.toFixed(0).padStart(5)} -> ${ppmNew.toFixed(0).padEnd(6)} ppm (-> ${(ppmNew + ')').padEnd(5)} ${flowString.padStart(15)} ${flowOutDaysString} days  ${peer.balance.toFixed(1)}b  🔼`
      feeChangeSummary += feeIncreaseLine
      console.log(feeIncreaseLine)

      ppmNew = await bos.setFees(peer.public_key, ppmNew)
    } else if (isDecreasing) {
      nDecreased++
      // at least -1 (b/c of trunc)
      ppmNew = applyRules(ppmOld * (1 - NUDGE_DOWN))

      // prettier-ignore
      const feeDecreaseLine = `${getDate()} ${ca(peer.alias).padEnd(30)} ${ppmOld.toFixed(0).padStart(5)} -> ${ppmNew.toFixed(0).padEnd(6)} ppm (-> ${(ppmNew + ')').padEnd(5)} ${flowString.padStart(15)} ${flowOutDaysString} days  ${peer.balance.toFixed(1)}b  🔻`
      feeChangeSummary += feeDecreaseLine
      console.log(feeDecreaseLine)

      ppmNew = await bos.setFees(peer.public_key, ppmNew)
    } else {
      // for no changes
      const warnings = isVeryRemoteHeavy(peer) ? '⛔VRH' : '-'
      // prettier-ignore
      const feeNoChangeLine = `${getDate()} ${ca(peer.alias).padEnd(30)} ${ppmOld.toFixed(0).padStart(5)} -> same   ppm (-> ${(ppmOld + ')').padEnd(5)} ${flowString.padStart(15)} ${flowOutDaysString} days  ${peer.balance.toFixed(1)}b  ${warnings}`
      feeChangeSummary += feeNoChangeLine
      console.log(feeNoChangeLine)
    }

    // update record if last recorded fee rate isn't what is last in last records
    if ((logFileData?.feeChanges || [])[0] !== ppmOld) {
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

  // add in all extra new data for each peer
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
    calculateFlowRateMargin(peer)

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
        base_fee_mtokens: +feeRates[id].base_fee_mtokens,
        capacity: channelOnChainInfo[id].capacity,
        transaction_id: channelOnChainInfo[id].transaction_id,
        transaction_vout: channelOnChainInfo[id].transaction_vout,
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
        local_min_htlc_mtokens: +channelOnChainInfo[id].local_min_htlc_mtokens,
        remote_max_pending_mtokens: +channelOnChainInfo[id].remote_max_pending_mtokens,
        remote_min_htlc_mtokens: +channelOnChainInfo[id].remote_min_htlc_mtokens
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
  // const paidFeesSummary = await bos.getFeesPaid({ days: DAYS_FOR_STATS })

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
    calculateFlowRateMargin(p)
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
  totalSatsOffBalanceSigned > MIN_REBALANCE_SATS
    ? '  (lower on inbound liquidity, get/rent others to open channels to you' +
          ' or loop-out/boltz/muun/WoS LN to on-chain funds)'
    : ''
}
    ${
  totalSatsOffBalanceSigned < MIN_REBALANCE_SATS
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

  let flowRateSummary = `${getDate()} - over ${DAYS_FOR_STATS} days using score of ${score}\n\n    `
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
        ? `routed-in: ${DAYS_FOR_STATS}+ days ago`.padStart(23)
        : `routed-in: ${lastRoutedIn.toFixed(1)} days ago`.padStart(23)
    const lastRoutedOut = (Date.now() - p.routed_out_last_at) / (1000 * 60 * 60 * 24)
    const lastRoutedOutString =
      lastRoutedOut > DAYS_FOR_STATS
        ? `routed-out: ${DAYS_FOR_STATS}+ days ago`
        : `routed-out: ${lastRoutedOut.toFixed(1)} days ago`

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

    // prettier-ignore
    flowRateSummary += `${('#' + (i + 1)).padStart(4)} ${pretty(score(p))}
      ${' '.repeat(15)}me  ${(p.my_fee_rate + 'ppm').padStart(7)} [-${local}--|--${remote}-] ${(p.inbound_fee_rate + 'ppm').padEnd(7)} ${p.alias} (./peers/${p.public_key.slice(0, 10)}.json) ${p.balance.toFixed(2)}b ${p.flowMarginWithRules}w ${p.flowMarginWithRules > 0 ? '<--R_in!' : ''}${p.flowMarginWithRules < 0 ? 'R_out!-->' : ''} ${issuesString}
      \x1b[2m${routeIn.padStart(26)} <---- routing ----> ${routeOut.padEnd(23)} +${routeOutEarned.padEnd(17)} ${routeInPpm.padStart(5)}|${routeOutPpm.padEnd(10)} ${('#' + p.routed_in_count).padStart(5)}|#${p.routed_out_count.toString().padEnd(5)}\x1b[0m
      \x1b[2m${rebIn.padStart(26)} <-- rebalancing --> ${rebOut.padEnd(23)} -${rebOutFees.padEnd(17)} ${rebInPpm.padStart(5)}|${rebOutPpm.padEnd(10)} ${('#' + p.rebalanced_in_count).padStart(5)}|#${p.rebalanced_out_count.toString().padEnd(5)}\x1b[0m
      \x1b[2m${' '.repeat(17)}Rebalances-in (<--) used (ppm): ${rebalanceHistory.s}\x1b[0m
      \x1b[2m${' '.repeat(17)}Rebalances-in (<--) est. (ppm): ${rebalanceSuggestionHistory.s}\x1b[0m
      \x1b[2m${' '.repeat(17)}${lastRoutedInString}, ${lastRoutedOutString}, ${lastPpmChangeString || 'no ppm change data found'}\x1b[0m
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

  const message = `🌷 Statistics for ${DAYS_FOR_STATS} days:

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
    calculateFlowRateMargin(p)
  }
}
// experimental
const calculateFlowRateMargin = p => {
  const B = p.balance
  const fOut = p.routed_out_msats / 1000
  const fIn = p.routed_in_msats / 1000
  const MIN_F = MIN_FLOWRATE_PER_DAY

  p.flowMargin = trunc((fOut / DAYS_FOR_STATS + MIN_F) * (1 - B) - (fIn / DAYS_FOR_STATS + MIN_F) * B)
  p.flowMarginWithRules = isLocalHeavy(p) // B >> 0.5 local
    ? min(p.flowMargin, -1) // maybe R_out
    : isRemoteHeavy(p) // B << 0.5 remote
    ? max(p.flowMargin, 1) // maybe R_in
    : 0

  // adding this metric that counts days to spend each remaining liquidity
  // negative suggests flow in needs more inbound liquidity for reliability (R_out)
  // positive suggests flow out needs more local balance for reliability (R_in)
  // e.g. huge flow out on balanced channel turns metric positive
  // e.g. huge flow in on balanced channel turns metric negative
  // metric is neutral when fOut/fIn = local_sats/remote_sats
  // fOut/fIn = 2 would correspond to ideally 2x more local sats than remote sats or B~0.67
  // with positive signal for 0.5 balance channel suggesting rebalance_in
  // a neutral region can be made by ignoring positive signal when B >= 0.5
  // and ignoring negative metrics when B <= 0.5
  // then the negative signal to rebalance_out will only show up at B > 0.67
  // and positive signal to rebalance_in will only show up at B < 0.5
  // this will allow the channel to become more reliable in direction the flow happens
  // and take advantage of "free rebalancing" from routing beyond 0.5 in less used
  // direction w/o paying to correct it back to 0.5

  // MIN_F = 0 for accurate stat, added to set minimum flow rate to correct for
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

  await sleep(1 * 60 * 1000)

  const peers = await runBotGetPeers({ all: true })

  if (!peers || peers.length === 0) return console.warn('no peers')

  const peersOffline = peers.filter(p => p.is_offline)

  const peersTotal = peers.length
  const message =
    `🍳 Bos reconnect done (every ${MINUTES_BETWEEN_RECONNECTS} minutes):` +
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

  // give it a lot of time
  await sleep(10 * 60 * 1000)

  if (!fs.existsSync(RESET_REQUEST_PATH)) {
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

// const subtractSafety = ppm => trunc(max(min(ppm - SAFETY_MARGIN_FLAT, ppm / SAFETY_MARGIN), 0))
// const addSafety = ppm => trunc(max(ppm + SAFETY_MARGIN_FLAT, ppm * SAFETY_MARGIN))

const addSafety = ppm => trunc(min(ppm * SAFETY_MARGIN + 1, ppm + SAFETY_MARGIN_FLAT))
const subtractSafety = ppm => trunc(max((ppm - 1) / SAFETY_MARGIN, ppm - SAFETY_MARGIN_FLAT, 0))

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

console.boring = args => console.log(`\x1b[2m${args}\x1b[0m`)

const sleep = async (ms, { msg = '', quiet = false } = {}) => {
  if (quiet) return await new Promise(resolve => setTimeout(resolve, trunc(ms)))

  const seconds = ms / 1000
  const minutes = seconds / 60
  const t = minutes >= 1 ? minutes.toFixed(1) + ' minutes' : seconds.toFixed(1) + ' seconds'
  if (msg) msg = '\n  ' + msg
  console.log(`${getDate()}\n${msg}\n    Paused for ${t}, ctrl + c to exit\n`)

  // easy script stop
  if (fs.existsSync('PLEASESTOP.json')) {
    fs.unlinkSync('PLEASESTOP.json')
    console.log(`${getDate()} script terminaltion request via PLEASESTOP.json granted`)
    process.exit(0)
  }

  return await new Promise(resolve => setTimeout(resolve, trunc(ms)))
}
const stylingPatterns = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g

// clean alias from emoji & non standard characters
const ca = alias => alias.replace(/[^\x00-\x7F]/g, '').trim() // .replace(/[\u{0080}-\u{10FFFF}]/gu,'');

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

initialize()
