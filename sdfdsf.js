// NOT SAFE TO RUN
dfgdfgdfgdfgdfg

import fs from 'fs' // to read/write log files
import dns from 'dns' // to check if node is online
import bos from './bos.js' // wrapper for bos

const { min, max, trunc, floor, abs, random, sqrt } = Math

// time to sleep between trying a bot step again
const MINUTES_BETWEEN_STEPS = 4

// minimum sats away from 0.5 balance to consider off-balance
const MIN_SATS_OFF_BALANCE = 420e3
// limit of sats to balance per attempt
// (bos one does probing + size up htlc strategy)
const MAX_REBALANCE_SATS = MIN_SATS_OFF_BALANCE
// unbalanced sats below this can stop (bos rebalance exits <50k)
const MIN_REBALANCE_SATS = 51e3

// sats to balance via keysends
const MAX_REBALANCE_SATS_SEND = 212121
// rebalance with faster keysends after bos rebalance works
// (faster but higher risk of stuck sats so I send less)
const USE_KEYSENDS_AFTER_BALANCE = true

// channels smaller than this not necessary to balance or adjust fees for
// usually special cases anyway
// (maybe use proportional fee policy for them instead)
// >2m for now
const MIN_CHAN_SIZE = 5 * (MIN_REBALANCE_SATS + MIN_SATS_OFF_BALANCE)

// multiplier for proportional safety ppm margin
const SAFETY_MARGIN = 1.15
// minimum flat safety ppm margin & min for remote heavy channels
const SAFETY_MARGIN_FLAT = 222
// as 0-profit fee rate increases, fee rate where where proportional
// fee takes over flat one is
// (break even fee rate) * SAFETY_MARGIN = SAFETY_MARGIN_FLAT

// smallest amount of sats to keep on each side ideally
// const MIN_SATS_PER_SIDE = 1000e3

// minimum ppm ever possible
const MIN_PPM_ABSOLUTE = 0

// how much error to use for balance calcs
// const BALANCE_DEV = 0.1

// any ppm above this is not considered for fees, rebalancing, or suggestions
const MAX_PPM_ABSOLUTE = 2992
// rebalancing fee rates below this aren't considered for rebalancing
const MIN_FEE_RATE_FOR_REBALANCE = 10

// max size of fee adjustment to target ppm (upward)
const NUDGE_UP = 0.021
// max size of fee adjustment to target ppm (downward)
const NUDGE_DOWN = 0.021
// max minutes to spend per rebalance try
const MINUTES_FOR_REBALANCE = 3
// max minutes to spend per keysend try
const MINUTES_FOR_SEND = 3 // ceil(MINUTES_FOR_REBALANCE / 2)
// time between retrying same good pair
const MIN_MINUTES_BETWEEN_SAME_PAIR = (MINUTES_BETWEEN_STEPS + MINUTES_FOR_REBALANCE) * 2
// max repeats to balance if successful
const MAX_BALANCE_REPEATS = 69
// hours between running bos reconnect
const MINUTES_BETWEEN_RECONNECTS = 69
// how often to update fees
const MINUTES_BETWEEN_FEE_CHANGES = 121
// allow adjusting fees
const ADJUST_FEES = true

// max days since last successful routing out to allow increasing fee
const DAYS_FOR_FEE_INCREASE = 1.2
// min days of no routing activity before allowing reduction in fees
const DAYS_FOR_FEE_REDUCTION = 2.1 + DAYS_FOR_FEE_INCREASE

// how far back to look for routing stats (> DAYS_FOR_FEE_REDUCTION)
const DAYS_FOR_STATS = 7

// weight for worked values, can be reduced to 1 and removed later
// now that I count every worked rebalance should become large number anyway
// stays here until I get enough data points
const WORKED_WEIGHT = 10
// min sample size before using rebalancing ppm rates for anything
const MIN_SAMPLE_SIZE = 20

// fraction of peers that need to be offline to restart tor service
const PEERS_OFFLINE_TO_RESET_TOR = 0.33

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
  FLOW_MARGIN: peer => abs(peer.flowMarginWeight),
  FLOW_MARGIN_SQRT: peer => trunc(sqrt(abs(peer.flowMarginWeight))),
  FLAT: () => 1
}
const WEIGHT = WEIGHT_OPTIONS.FLOW_MARGIN_SQRT

// experimental - fake small flowrate to be ready to expect
const MIN_FLOWRATE_PER_DAY = 10000 // sats/day

const SNAPSHOTS_PATH = './snapshots'
const BALANCING_LOG_PATH = './peers'
const SUMMARIES = './logs'
const TIMERS_PATH = 'timers.json'
const SETTINGS_PATH = 'settings.json'

// global node info
const mynode = {
  scriptStarted: Date.now(),
  my_public_key: ''
}

const runBot = async () => {
  console.boring(`${getDate()} runBot()`)

  // try a rebalance
  await runBotUpdateStep()

  // check if time for updating fees
  await runUpdateFeesCheck()

  // check if time for bos reconnect
  await runBotReconnectCheck()

  // pause
  await sleep(MINUTES_BETWEEN_STEPS * 60 * 1000)

  // restart
  runBot()
}

const runBotUpdateStep = async () => {
  console.boring(`${getDate()} runBotUpdateStep() starts`)

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
  const logFile = BALANCING_LOG_PATH + '/' + remoteChannel.public_key.slice(0, 10) + '.json'
  const logFileData = !fs.existsSync(logFile) ? {} : JSON.parse(fs.readFileSync(logFile)) || {}

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
      peer.unbalancedSatsSigned > MAX_REBALANCE_SATS &&
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

const runBotGetPeers = async ({ all = false } = {}) => {
  const getMyFees = await bos.getFees()
  const getPeers = all
    ? await bos.peers({
        active: undefined,
        public: undefined
        // earnings_days: DAYS_FOR_STATS // too little info
      })
    : await bos.peers()

  const peers = getPeers
    .map(p => {
      p.my_fee_rate = +getMyFees[p.public_key] || 0
      doBonusPeerCalcs(p)
      return p
    })
    .filter(p => !p.is_offline || all) // remove offline peers if not all to be shown
    .sort((a, b) => b.outbound_liquidity - a.outbound_liquidity)

  // add some slow to change stats from most recent snapshot if available
  addDetailsFromSnapshot(peers)
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

const runBotPickRandomPeers = async () => {
  // get all useful peers
  const peers = await runBotGetPeers()

  // make a list of remote heavy and local heavy peers via balance check
  const remoteHeavyPeers = peers.filter(
    p =>
      // balance on remote side beyond min-off-balance or enough for max rebalance size
      isRemoteHeavy(p) &&
      // large enough channel
      p.totalSats >= MIN_CHAN_SIZE &&
      // enough sats to balance
      p.unbalancedSats > MIN_REBALANCE_SATS &&
      // only if no settings about it or if no setting for no remote-heavy rebalance true
      !getRuleFromSettings({ alias: p.alias })?.no_remote_rebalance &&
      // fee too small to rebalance
      subtractSafety(p.my_fee_rate) > MIN_FEE_RATE_FOR_REBALANCE
  )
  const localHeavyPeers = peers.filter(
    p =>
      // balance on my side beyond min-off-balance or enough for max rebalance size
      isLocalHeavy(p) &&
      p.totalSats >= MIN_CHAN_SIZE &&
      p.unbalancedSats > MIN_REBALANCE_SATS &&
      // only if no settings about it or if no setting for no local-heavy rebalance true
      !getRuleFromSettings({ alias: p.alias })?.no_local_rebalance
  )

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

  // experimental printout testing
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
  const maxFeeRate = max(subtractSafety(remoteChannel.my_fee_rate), 1)
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

  // prettier-ignore
  console.log(`${getDate()} ${rebalanceTime} minutes limit

    ☂️  me  ${localChannel.my_fee_rate} ppm  ---|-  ${localChannel.inbound_fee_rate} ppm "${localChannel.alias}" ${localChannel.public_key.slice(0, 10)}
    ${(localChannel.outbound_liquidity / 1e6).toFixed(2)}M local sats --> (${(localChannel.inbound_liquidity / 1e6).toFixed(2)}M) --> ?

    ☂️  me _${remoteChannel.my_fee_rate}_ppm_  -|---  ${remoteChannel.inbound_fee_rate} ppm "${remoteChannel.alias}" ${remoteChannel.public_key.slice(0, 10)}
    (${(remoteChannel.outbound_liquidity / 1e6).toFixed(2)}M) <-- ${(remoteChannel.inbound_liquidity / 1e6).toFixed(2)}M remote sats <-- ?

    Attempt to rebalance max of ${pretty(maxAmount)} sats at max fee rate of ${maxFeeRate} ppm
    out of ${pretty(minUnbalanced)} sats left to balance for this pair
  `)

  // Always lose money rebalancing remote heavy channel with fee rate lower than remote fee rate
  if (maxFeeRate < remoteChannel.inbound_fee_rate) {
    const minimumAcceptable = addSafety(remoteChannel.inbound_fee_rate)
    console.log(`${getDate()}
      Attempted balancing aborted at max of ${maxFeeRate}
        Remote-heavy "${remoteChannel.alias}" channel peer has higher
        incoming fee rate of ${remoteChannel.inbound_fee_rate} ppm.
        My fee rate should be at least ${minimumAcceptable.toFixed(0)} to justify it.
    `)
    appendRecord({
      peer: remoteChannel,
      newRebalance: {
        t: Date.now(),
        ppm: minimumAcceptable,
        failed: true,
        peer: localChannel.public_key,
        peerAlias: localChannel.alias,
        sats: maxAmount,
        belowPeer: true // unique flag for this
      }
    })
    return { failed: true }
  }

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
    const attemptedFeeRate = maxFeeRate
    const suggestedFeeRate = resBalance.ppmSuggested

    console.log(
      `${getDate()} Attempted rebalance at ${attemptedFeeRate} ppm failed` +
        `, suggested ${suggestedFeeRate.toFixed(0)} ppm`
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
  }

  return resBalance
}

// reconnection timer handling
const runBotReconnectCheck = async () => {
  const now = Date.now()
  const timers = JSON.parse(fs.readFileSync(TIMERS_PATH))
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

// logic for updating fees (v2)
const updateFees = async () => {
  console.boring(`${getDate()} updateFees() v2`)

  // generate brand new snapshots
  const allPeers = await generateSnapshots()

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
    // check if there are rules about this peer
    const rule = getRuleFromSettings({ alias: peer.alias })

    // get historic rebalancing rate
    const logFileData = readRecord(peer.public_key)
    const balancingData = logFileData.rebalance
    const usedBalancingData = balancingData.filter(b => b.failed === false)
    const all = median(
      balancingData.map(b => b.ppm),
      { obj: true }
    )
    const worked = median(
      usedBalancingData.map(b => b.ppm),
      { obj: true }
    )

    // lets simplify this

    // rebalancing fee rate
    let ppmFair = 0

    // rebalancing cost estimate just makes sense for outflowing channels.
    // higher fees that come out of this probably not ideal for stuck neutral channels
    if (isNetOutflowing(peer)) {
      // without rebalancing data peer fee is only clue
      // only makes sense for remote heavy channel
      ppmFair = isRemoteHeavy(peer) ? peer.inbound_fee_rate : ppmFair
      // rebalancing estimates/suggestions include that so ok replacement
      if (all.bottom25 && all.n >= MIN_SAMPLE_SIZE) ppmFair = all.bottom25
      // actually used rates better & more important
      if (worked.top75 && all.n >= MIN_SAMPLE_SIZE) {
        ppmFair = (worked.top75 * worked.n * WORKED_WEIGHT + all.bottom25 * all.n) / (worked.n * WORKED_WEIGHT + all.n)
      }
    }

    // add safety margin
    const ppmSafe = addSafety(ppmFair)

    // add rules
    const applyRules = ppmIn => {
      ppmIn = rule?.min_ppm !== undefined ? max(rule.min_ppm, ppmIn) : ppmIn
      ppmIn = rule?.max_ppm !== undefined ? min(rule.max_ppm, ppmIn) : ppmIn
      ppmIn = max(min(MAX_PPM_ABSOLUTE, ppmIn), MIN_PPM_ABSOLUTE)
      return ppmIn
    }
    const ppmRule = applyRules(ppmSafe)

    // get rid of this
    const ppmSane = trunc(ppmRule)

    // const flowOut = peer.routed_out_msats
    const now = Date.now()
    const flowOutRecentDaysAgo = +((now - peer.routed_out_last_at) / (1000 * 60 * 60 * 24)).toFixed(1)
    const ppmOld = peer.my_fee_rate

    const isIncreasing =
      ADJUST_FEES &&
      // sustainable flow fee rate higher
      ppmSane > ppmOld &&
      // by increasing only when routing out so we don't waste time on unused fee range
      flowOutRecentDaysAgo < DAYS_FOR_FEE_INCREASE

    const isDecreasing =
      ADJUST_FEES &&
      // sustainable flow fee rate lower for outflowing peers (careful with these as profit makers)
      // and decrease whenever possible for inflowing peers (obviously not stuck remote heavy)
      ((!isIncreasing && !isNetOutflowing(peer)) || (ppmSane < ppmOld && isNetOutflowing(peer))) &&
      // by decreasing only when no routing we don't underprice too severely
      flowOutRecentDaysAgo > DAYS_FOR_FEE_REDUCTION

    const flowString = `${isNetOutflowing(peer) ? 'outflowing' : isNetInflowing(peer) ? ' inflowing' : '   no flow'}`
    feeChangeSummary += '\n'

    if (isIncreasing) {
      nIncreased++
      const ppmStep = trunc(ppmOld * (1 - NUDGE_UP) + ppmSane * NUDGE_UP) + 1

      // prettier-ignore
      console.log(feeChangeSummary +=
        `${getDate()} ${peer.alias.padEnd(30)} ${ppmOld.toFixed(0).padStart(5)} -> ${ppmStep.toFixed(0).padEnd(6)} ppm (-> ${(ppmSane + ')').padEnd(5)} 🔼🔼🔼 ${flowString.padStart(15)} ${flowOutRecentDaysAgo}d`
      )

      const resSetFee = await bos.setFees(peer.public_key, ppmStep)

      appendRecord({
        peer,
        newRecordData: {
          lastFeeIncrease: now, // unique here
          ppmTargets: {
            ppmSafe,
            ppmSane,
            ppmFair,
            ppmRule,
            ppmStep,
            daysNoRouting: flowOutRecentDaysAgo
          },
          feeChanges: [
            {
              t: now,
              ppm: resSetFee,
              // for ppm vs Fout data
              ppm_old: ppmOld,
              routed_out_msats: peer.routed_out_msats
            },
            ...(logFileData?.feeChanges || [])
          ]
        }
      })

      continue // next peer
    }

    if (isDecreasing) {
      nDecreased++

      const ppmSetPoint = isNetOutflowing(peer)
        ? ppmSane // decrease to set point
        : applyRules(subtractSafety(ppmOld)) // just gradually decrease

      const ppmStep = trunc(ppmOld * (1 - NUDGE_DOWN) + ppmSetPoint * NUDGE_DOWN)

      // prettier-ignore
      console.log(feeChangeSummary +=
        `${getDate()} ${peer.alias.padEnd(30)} ${ppmOld.toFixed(0).padStart(5)} -> ${ppmStep.toFixed(0).padEnd(6)} ppm (-> ${(ppmSane + ')').padEnd(5)} 🔻🔻🔻 ${flowString.padStart(15)} ${flowOutRecentDaysAgo}d`
      )

      const resSetFee = await bos.setFees(peer.public_key, ppmStep)

      appendRecord({
        peer,
        newRecordData: {
          lastFeeDecrease: now, // unique here
          ppmTargets: {
            ppmSafe,
            ppmSane,
            ppmFair,
            ppmRule,
            ppmStep,
            daysNoRouting: flowOutRecentDaysAgo
          },
          feeChanges: [
            {
              t: now,
              ppm: resSetFee,
              // for ppm vs Fout data
              ppm_old: ppmOld,
              routed_out_msats: peer.routed_out_msats
            },
            ...(logFileData?.feeChanges || [])
          ]
        }
      })

      continue // next peer
    }

    // for no changes
    // prettier-ignore
    console.log(feeChangeSummary +=
      `${getDate()} ${peer.alias.padEnd(30)} ${ppmOld.toFixed(0).padStart(5)} -> no changes (-> ${(ppmSane + ')').padEnd(5)}     ${flowString.padStart(18)} ${flowOutRecentDaysAgo}d`
    )

    appendRecord({
      peer,
      newRecordData: {
        lastFeeChangeSkipped: now, // unique here
        ppmTargets: {
          ppmSafe,
          ppmSane,
          ppmFair,
          ppmRule,
          daysNoRouting: flowOutRecentDaysAgo
        }
      }
    })

    // unchanging
  }
  feeChangeSummary += '\n\n'
  console.log(
    (feeChangeSummary += `
    ${allPeers.length.toFixed(0).padStart(5, ' ')} peers
    ${peers.length.toFixed(0).padStart(5, ' ')} considered
    ${nIncreased.toFixed(0).padStart(5, ' ')} increased
    ${nDecreased.toFixed(0).padStart(5, ' ')} decreased
  `)
  )
  // make it available for review
  fs.writeFileSync(`${SUMMARIES}/${getDay()}_feeChanges.txt`, feeChangeSummary)
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
    ...(oldRecord?.rebalance?.filter(isNotEmpty).sort((a, b) => b.t - a.t) || [])
  ]
    .filter(isNotEmpty)
    // insane estimates are useless
    .filter(r => addSafety(r.ppm) <= MAX_PPM_ABSOLUTE)

  // calculate median ppms
  const ppmAll = median(
    combinedRebalanceData.map(b => b.ppm),
    { obj: true }
  )
  const ppmWorked = median(
    combinedRebalanceData.filter(b => b.failed === false).map(b => b.ppm),
    { obj: true }
  )

  // remove old data in future or weight higher recent data

  // update just this peers file
  fs.writeFileSync(
    fullPath,
    JSON.stringify(
      {
        ...oldRecord,
        ...newRecordData,
        alias: peer.alias,
        public_key: peer.public_key,
        ppmAll,
        ppmWorked,
        rebalance: combinedRebalanceData
      },
      fixJSON,
      2
    )
  )

  log &&
    console.log(`${getDate()} ${fullPath} "${peer.alias}" updated, ${combinedRebalanceData.length} records,
    all:      ${JSON.stringify(ppmAll)}
    worked:   ${JSON.stringify(ppmWorked)}
  `)
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

  // forwards lookback (this function didn't return enough info)
  // const getForwards = await bos.forwards({ days: DAYS_FOR_STATS })
  // const forwards = getForwards.reduce((final, peer) => {
  //   // convert ISO string to timestamp
  //   peer.routed_in_last_at = Date.parse(peer.routed_in_last_at) || 0
  //   peer.routed_out_last_at = Date.parse(peer.routed_out_last_at) || 0
  //   final[peer.public_key] = peer
  //   return final
  // }, {})

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
  // get all payments
  const getPaymentEvents = await bos.customGetPaymentEvents({
    days: DAYS_FOR_STATS
  })
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

    // experimental
    calculateFlowRateMargin(peer)

    // initialize capacity
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
      // if (channelOnChainInfo[id].local_max_pending_mtokens !== channelOnChainInfo[id].remote_max_pending_mtokens) {
      //   console.log(`
      //     Mismatch for alias: "${peer.alias}" peer:${peer.public_key} id:${id}
      //     local_max_pending_mtokens: ${pretty(channelOnChainInfo[id].local_max_pending_mtokens)}
      //     remote_max_pending_mtokens: ${pretty(channelOnChainInfo[id].remote_max_pending_mtokens)}
      //   `)
      // }
      // if (channelOnChainInfo[id].local_min_htlc_mtokens !== channelOnChainInfo[id].remote_min_htlc_mtokens) {
      //   console.log(`
      //     Mismatch for alias: "${peer.alias}" peer:${peer.public_key} id:${id}
      //     local_min_htlc_mtokens: ${pretty(channelOnChainInfo[id].local_min_htlc_mtokens)}
      //     remote_min_htlc_mtokens: ${pretty(channelOnChainInfo[id].remote_min_htlc_mtokens)}
      //   `)
      // }
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

  const baseFeesStats = median(getFeeRates.channels.map(d => +d.base_fee_mtokens))
  const ppmFeesStats = median(getFeeRates.channels.map(d => d.fee_rate))
  const channelCapacityStats = median(
    getChannels.channels.map(d => d.capacity),
    { f: pretty }
  )

  const totalEarnedFromForwards = peers.reduce((t, p) => t + p.routed_out_fees_msats, 0) / 1000

  const statsEarnedPerPeer = median(
    peers.filter(p => p.routed_out_last_at).map(p => p.routed_out_fees_msats / 1000),
    { f: pretty }
  )
  // const totalEarnedFromForwards = getForwards.reduce(
  //   (sum, peer) => sum + (peer.earned_outbound_fees || 0),
  //   0
  // )
  // const statsEarnedPerPeer = median(
  //   getForwards
  //     .filter(peer => peer.routed_out_last_at)
  //     .map(peer => peer.earned_outbound_fees || 0),
  //   { f: pretty }
  // )

  const totalPeersRoutingIn = peers.filter(p => p.routed_in_last_at).length
  const totalPeersRoutingOut = peers.filter(p => p.routed_out_last_at).length

  // const totalPeersRoutingIn = getForwards.filter(
  //   peer => peer.routed_in_last_at
  // ).length

  // const totalPeersRoutingOut = getForwards.filter(
  //   peer => peer.routed_out_last_at
  // ).length

  // const earnedSummary = await bos.getFeesChart({ days: DAYS_FOR_STATS })
  const countsSummary = await bos.getFeesChart({
    days: DAYS_FOR_STATS,
    is_count: true
  })
  const tokensSummary = await bos.getFeesChart({
    days: DAYS_FOR_STATS,
    is_forwarded: true
  })
  const chainFeesSummary = await bos.getChainFeesChart({ days: DAYS_FOR_STATS })
  const paidFeesSummary = await bos.getFeesPaid({ days: DAYS_FOR_STATS })

  const totalForwardsCount = countsSummary.data.reduce((t, v) => t + v, 0)
  const totalRouted = tokensSummary.data.reduce((t, v) => t + v, 0)
  const totalChainFees = chainFeesSummary.data.reduce((t, v) => t + v, 0)
  const totalFeesPaid = paidFeesSummary.data.reduce((t, v) => t + v, 0)

  const totalProfit = totalEarnedFromForwards - totalChainFees - totalFeesPaid

  const balances = await bos.getDetailedBalance()

  // get totals from payments and received
  const totalReceivedFromOthersLN =
    Object.values(receivedFromOthersLN).reduce((t, r) => t + r.received_mtokens, 0) / 1000
  const totalSentToOthersLN = paidToOthersLN.reduce((t, p) => t + p.mtokens, 0) / 1000
  const totalRebalances = rebalances.reduce((t, p) => t + p.mtokens, 0) / 1000

  const totalRebalancedFees = rebalances.reduce((t, p) => t + p.fee_mtokens, 0) / 1000
  const totalSentToOthersFees = paidToOthersLN.reduce((t, p) => t + p.fee_mtokens, 0) / 1000

  // stats with individual forwards resolution by size in msats ranges
  const forwardStats = forwardsAll.reduce((final, it) => {
    for (const top of [1e5, 1e7, 1e9, 1e11]) {
      if (!final[String(top)]) {
        final[String(top)] = { mtokens: 0, count: 0, fee_mtokens: 0 }
      }
      if (it.mtokens < top) {
        final[String(top)].count = final[String(top)].count + 1
        final[String(top)].mtokens = final[String(top)].mtokens + it.mtokens
        final[String(top)].fee_mtokens = final[String(top)].fee_mtokens + it.fee_mtokens
        break // done with this forward
      }
    }
    return final
  }, {})

  // prettier-ignore
  const summary = `${getDate()}

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

          0 - 100 sats                ${pretty(forwardStats[String(1e5)].mtokens / 1000)} sats routed
                                      ${pretty(forwardStats[String(1e5)].fee_mtokens / 1000)} sats earned
                                      ${pretty(forwardStats[String(1e5)].count)} count

        100 - 10k sats                ${pretty(forwardStats[String(1e7)].mtokens / 1000)} sats routed
                                      ${pretty(forwardStats[String(1e7)].fee_mtokens / 1000)} sats earned
                                      ${pretty(forwardStats[String(1e7)].count)} count

        10k - 1M sats                 ${pretty(forwardStats[String(1e9)].mtokens / 1000)} sats routed
                                      ${pretty(forwardStats[String(1e9)].fee_mtokens / 1000)} sats earned
                                      ${pretty(forwardStats[String(1e9)].count)} count

         1M - 100M sats               ${pretty(forwardStats[String(1e11)].mtokens / 1000)} sats routed
                                      ${pretty(forwardStats[String(1e11)].fee_mtokens / 1000)} sats earned
                                      ${pretty(forwardStats[String(1e11)].count)} count

    peers used for routing-out:       ${totalPeersRoutingOut}
    peers used for routing-in:        ${totalPeersRoutingIn}
    earned per peer stats:            ${statsEarnedPerPeer} sats

    LN received from others:          ${pretty(totalReceivedFromOthersLN)} sats (n: ${Object.keys(receivedFromOthersLN).length})
    LN payments to others:            ${pretty(totalSentToOthersLN)} sats, fees: ${pretty(totalSentToOthersFees)} sats (n: ${paidToOthersLN.length})
    LN total rebalanced:              ${pretty(totalRebalances)} sats, fees: ${pretty(totalRebalancedFees)} (n: ${rebalances.length})

    % sats routed                     ${(totalRouted / totalLocalSats * 100).toFixed(0)}%
    avg forwarded ppm:                ${(totalEarnedFromForwards / totalRouted * 1e6).toFixed(0)} ppm
    avg profit ppm:                   ${(totalProfit / totalLocalSats * 1e6).toFixed(0)} ppm
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
  console.log(summary)

  // by channel summary
  let flowRateSummary = `${getDate()} - over ${DAYS_FOR_STATS} days\n`
  for (const p of peers) {
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
    // const ppmTargets = Object.entries(record.ppmTargets || {})
    //   .reduce((f, e) => `${f} ${e[0]}: ${+e[1].toFixed(2)} /`, '')
    //   .slice(0, -1)
    const rebalanceHistory = median((record.rebalance || []).filter(r => !r.failed).map(r => r.ppm))

    const lastRoutedIn = (Date.now() - p.routed_in_last_at) / (1000 * 60 * 60 * 24)
    const lastRoutedInString =
      lastRoutedIn > DAYS_FOR_STATS
        ? `last routed in more than ${DAYS_FOR_STATS} days ago`.padStart(35)
        : `last routed in ${lastRoutedIn.toFixed(1)} days ago`.padStart(35)
    const lastRoutedOut = (Date.now() - p.routed_out_last_at) / (1000 * 60 * 60 * 24)
    const lastRoutedOutString =
      lastRoutedOut > DAYS_FOR_STATS
        ? `last routed out more than ${DAYS_FOR_STATS} days ago`
        : `last routed out ${lastRoutedOut.toFixed(1)} days ago`

    // prettier-ignore
    flowRateSummary += `
      ${' '.repeat(15)}me  ${(p.my_fee_rate + 'ppm').padStart(7)} [-${local}--|--${remote}-] ${(p.inbound_fee_rate + 'ppm').padEnd(7)} ${p.alias} (./peers/${p.public_key.slice(0, 10)}.json) ${p.balance.toFixed(2)}b ${p.flowMarginWeight}w ${p.flowMarginWeight > 0 ? '<--R_in!' : ''}${p.flowMarginWeight < 0 ? 'R_out!-->' : ''}
      \x1b[2m${routeIn.padStart(26)} <---- routing ----> ${routeOut.padEnd(23)} +${routeOutEarned.padEnd(17)} ${routeInPpm.padStart(5)}|${routeOutPpm.padEnd(10)} ${('#' + p.routed_in_count).padStart(5)}|#${p.routed_out_count.toString().padEnd(5)}\x1b[0m
      \x1b[2m${rebIn.padStart(26)} <-- rebalancing --> ${rebOut.padEnd(23)} -${rebOutFees.padEnd(17)} ${rebInPpm.padStart(5)}|${rebOutPpm.padEnd(10)} ${('#' + p.rebalanced_in_count).padStart(5)}|#${p.rebalanced_out_count.toString().padEnd(5)}\x1b[0m
      \x1b[2m${' '.repeat(17)}<-- Rebalaces-in cost rate (ppm): ${rebalanceHistory}\x1b[0m
      \x1b[2m${' '.repeat(17)}${lastRoutedInString} / ${lastRoutedOutString}\x1b[0m
    `
  }
  console.log(flowRateSummary)

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
  fs.writeFileSync(`${SNAPSHOTS_PATH}/peers.json`, JSON.stringify(peers, fixJSON, 2))
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
  fs.writeFileSync(`${SUMMARIES}/${getDay()}_flowSummary.txt`, flowRateSummary.replace(stylingPatterns, ''))
  // node summary
  fs.writeFileSync(`${SUMMARIES}/${getDay()}_nodeSummary.txt`, summary)

  // too much data to write constantly
  // fs.writeFileSync(
  //   `${SNAPSHOTS_PATH}/forwardsByIns.json`,
  //   JSON.stringify(peerForwardsByIns, fixJSON, 2)
  // )
  // fs.writeFileSync(
  //   `${SNAPSHOTS_PATH}/forwardsByOuts.json`,
  //   JSON.stringify(peerForwardsByOuts, fixJSON, 2)
  // )
  // rebalance list array
  // fs.writeFileSync(
  //   `${SNAPSHOTS_PATH}/rebalances.json`,
  //   JSON.stringify(rebalances, fixJSON, 2)
  // )
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
    if (i === undefined) continue
    p.routed_out_msats = p.routed_out_msats || flowrates[i].routed_out_msats
    p.routed_in_msats = p.routed_in_msats || flowrates[i].routed_in_msats

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
  p.flowMarginWeight = isLocalHeavy(p) // B >> 0.5 local
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
  // and take advantage of "free rebalancing" from routing beyond 0.5 in less unsed
  // direction w/o paying to correct it back to 0.5

  // MIN_F = 0 for accurate stat, added to set minimum flow rate to correct for
}

// 1. check internet connection, when ok move on
// 2. do bos reconnect
// 3. get updated complete peer info
// 4. peers offline high = reset tor & rerun entire check after delay
const runBotConnectionCheck = async ({ quiet = false } = {}) => {
  // check for basic internet connection
  const isInternetConnected = await dns.promises
    .lookup('google.com')
    .then(() => true)
    .catch(() => false)
  console.log(`${getDate()} Connected to clearnet internet? ${isInternetConnected}`)

  // keep trying until internet connects
  if (!isInternetConnected) {
    await sleep(2 * 60 * 1000) // every minute
    return await runBotConnectionCheck()
  }

  // run bos reconnect
  await bos.reconnect(true)

  await sleep(1 * 60 * 1000)

  const peers = await runBotGetPeers({ all: true })

  if (!peers || peers.length === 0) return console.warn('no peers')

  const peersOffline = peers.filter(p => p.is_offline)

  const peersTotal = peers.length
  const message =
    `🍳 There are ${peersOffline.length} / ${peersTotal}` +
    ` peers offline, ${((peersOffline.length / peersTotal) * 100).toFixed(0)}%` +
    ` (bos reconnect every ${MINUTES_BETWEEN_RECONNECTS} minutes).` +
    ` Offline: ${peersOffline.map(p => p.alias).join(', ') || 'n/a'}`

  // update user about offline peers just in case
  console.log(`${getDate()} ${message}`)
  const { token, chat_id } = mynode.settings?.telegram || {}
  if (!quiet && token && chat_id) {
    bos.sayWithTelegramBot({ token, chat_id, message })
  }

  if (peersOffline.length / peersTotal <= PEERS_OFFLINE_TO_RESET_TOR) return 0 // all good

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
  if (!fs.existsSync(RESET_ACTION_PATH)) {
    console.log(`${getDate()} tor reset failed, no action file found`)
    process.exit(1)
  }
  const res = JSON.parse(fs.readFileSync(RESET_ACTION_PATH))
  if (res.id !== requestTime) {
    console.log(`${getDate()} tor reset failed, no updated action file found, just old version`)
    process.exit(1)
  }

  // temporary measure
  process.exit(1)

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

  const updateNudge = (now, nudge, target) => now * (1 - nudge) + target * nudge

  const maxUpFeeChangePerDay = [...Array(feeUpdatesPerDay)].reduce(f => updateNudge(f, NUDGE_UP, 100), 0)
  const maxDownFeeChangePerDay = [...Array(feeUpdatesPerDay)].reduce(f => updateNudge(f, NUDGE_DOWN, 100), 0)

  console.log(`${getDate()}
  ========================================================

    this node's public key:

      "${mynode.my_public_key}"

    max fee rate change per day is

      up:   ${maxUpFeeChangePerDay.toFixed(1)} % towards set point
        (if routed-out last ${DAYS_FOR_FEE_INCREASE} days)

      down: ${maxDownFeeChangePerDay.toFixed(1)} % towards set point
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
  if (!fs.existsSync(SUMMARIES)) {
    fs.mkdirSync(SUMMARIES, { recursive: true })
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

  // check if internet is connected
  await runBotConnectionCheck({ quiet: true })

  // start bot loop
  runBot()
}

const subtractSafety = ppm => trunc(max(min(ppm - SAFETY_MARGIN_FLAT, ppm / SAFETY_MARGIN), 0))

const addSafety = ppm => trunc(max(ppm + SAFETY_MARGIN_FLAT, ppm * SAFETY_MARGIN)) + 1

const isRemoteHeavy = p => p.unbalancedSatsSigned < -MIN_SATS_OFF_BALANCE

const isLocalHeavy = p => p.unbalancedSatsSigned > MIN_SATS_OFF_BALANCE

const isNetOutflowing = p => p.routed_out_msats - p.routed_in_msats > 0

const isNetInflowing = p => p.routed_out_msats - p.routed_in_msats < 0

// const isVeryLocalHeavy = p =>
//   1.0 - p.balance < BALANCE_DEV || p.outbound_liquidity < MIN_SATS_PER_SIDE

// const isVeryRemoteHeavy = p =>
//   p.balance < BALANCE_DEV || p.inbound_liquidity < MIN_SATS_PER_SIDE

// const isBalanced = p =>

const pretty = n => String(trunc(n)).replace(/\B(?=(\d{3})+\b)/g, '_')

const getDate = timestamp => (timestamp ? new Date(timestamp) : new Date()).toISOString()
const getDay = () => new Date().toISOString().slice(0, 10)

const fixJSON = (k, v) => (v === undefined ? null : v)

const isEmpty = obj => !!obj && Object.keys(obj).length === 0 && obj.constructor === Object
const isNotEmpty = obj => !isEmpty(obj)

console.boring = args => console.log(`\x1b[2m${args}\x1b[0m`)

const sleep = async ms => {
  const seconds = ms / 1000
  const minutes = seconds / 60
  const t = minutes >= 1 ? minutes.toFixed(1) + ' minutes' : seconds.toFixed(1) + ' seconds'
  console.log(`${getDate()}\n\n    Paused for ${t}, ctrl + c to exit\n\n`)
  return await new Promise(resolve => setTimeout(resolve, trunc(ms)))
}
const stylingPatterns =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g

// returns mean, truncated fractions
const median = (numbers = [], { obj = false, f = v => v } = {}) => {
  const sorted = numbers
    .slice()
    .filter(v => !isNaN(v))
    .sort((a, b) => a - b)
  const n = sorted.length
  if (!numbers || numbers.length === 0 || n === 0) {
    return !obj ? 'n: 0' : { n: 0 }
  }
  const middle = floor(sorted.length * 0.5)
  const middleTop = floor(sorted.length * 0.75)
  const middleBottom = floor(sorted.length * 0.25)

  const result = {
    n,
    avg: f(trunc(sorted.reduce((sum, val) => sum + val, 0) / sorted.length)),
    bottom: f(sorted[0]),
    bottom25: f(
      sorted.length % 4 === 0
        ? trunc((sorted[middleBottom - 1] + sorted[middleBottom]) / 2.0)
        : trunc(sorted[middleBottom])
    ),
    median: f(sorted.length % 2 === 0 ? trunc((sorted[middle - 1] + sorted[middle]) / 2.0) : trunc(sorted[middle])),
    top75: f(
      sorted.length % 4 === 0 ? trunc((sorted[middleTop - 1] + sorted[middleTop]) / 2.0) : trunc(sorted[middleTop])
    ),
    top: f(sorted[numbers.length - 1])
  }

  const { bottom, bottom25, median, avg, top75, top } = result

  // const stringOutput = JSON.stringify(result, fixJSON)
  const stringOutput =
    `(n: ${n}) min: ${bottom}, 1/4th: ${bottom25}, ` + `median: ${median}, avg: ${avg}, 3/4th: ${top75}, max: ${top}`

  return !obj ? stringOutput : result
}

initialize()
