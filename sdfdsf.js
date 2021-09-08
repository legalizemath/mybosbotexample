// NOT SAFE TO RUN
dfgdfgdfgdfgdfg

import fs from 'fs'
import bos from './bos.js'

// time to sleep between trying a bot step again
const MINUTES_BETWEEN_STEPS = 5
// channels smaller than this not necessary to balance
const MIN_CHAN_SIZE = 1.9e6
// channels less off-balance are not necessary to balance
const MIN_OFF_BALANCE = 0.1
// limit of sats to balance per attempt
// (bos one does probing + size up htlc strategy)
const MAX_REBALANCE_SATS = 4.2e5
// unbalanced sats below this not necessary to balance
const MIN_REBALANCE_SATS = 0.5e5

// sats to balance via keysends
const MAX_REBALANCE_SATS_SEND = 2.1e5
// rebalance with faster keysends after bos rebalance works
// (faster but higher risk of stuck sats)
const USE_KEYSENDS_AFTER_BALANCE = true

// multiplier for proportional safety ppm range
const SAFETY_MARGIN = 1.1
// minimum flat safety ppm range & min for remote heavy channels
const MIN_PPM_FOR_SAFETY = 222
// never let ppm go above this for fee rate or rebalancing
const MAX_PPM_ABSOLUTE = 2900
// max size of fee adjustment to target ppm (upward)
const NUDGE_UP = 0.1
// max size of fee adjustment to target ppm (downward)
const NUDGE_DOWN = 0.1
// max minutes to spend per rebalance try
const MINUTES_FOR_REBALANCE = 2
// max minutes to spend per keysend try
const MINUTES_FOR_SEND = Math.ceil(MINUTES_FOR_REBALANCE / 2)
// max repeats to balance if successful
const MAX_BALANCE_REPEATS = 30
// hours between running bos reconnect
const HOURS_BETWEEN_RECONNECTS = 1
// how often to update fees
const MINUTES_BETWEEN_FEE_CHANGES = 60
// allow adjusting fees
const ADJUST_FEES = true
// how many days of no routing before reduction in fees
const DAYS_FOR_FEE_REDUCTION = 3
// how far back to look for routing stats
const DAYS_FOR_STATS = 3
// weight for worked values, can be reduced to 1 and removed later
const WORKED_WEIGHT = 3

// what to weight random selection by
const WEIGHT_OPTIONS = {
  UNBALANCED_SATS: 'unbalancedSats',
  CHANNEL_SIZE: 'totalSats',
  MY_FEE_RATE: 'my_fee_rate',
  FLAT: 'is_active'
}
const WEIGHT = WEIGHT_OPTIONS.UNBALANCED_SATS

const SNAPSHOTS_PATH = './snapshots'
const BALANCING_LOG_PATH = './peers'
const TIMERS_PATH = 'timers.json'

// global node info
const mynode = {
  scriptStarted: Date.now()
}

const runBot = async () => {
  console.boring(`${getDate()} runBot()`)

  // try a rebalance
  await runBotUpdateStep()

  // check if time for updating fees
  await runUpdateFees()

  // check if time for bos reconnect
  await runBotReconnect()

  // pause
  console.log(`\n${getDate()} ${MINUTES_BETWEEN_STEPS} minutes pause\n`)
  await sleep(MINUTES_BETWEEN_STEPS * 60 * 1000)

  // restart
  runBot()
}

const runBotUpdateStep = async () => {
  console.boring(`${getDate()} runBotUpdateStep() starts`)

  const peers = await runBotGetPeers()

  let { localChannel, remoteChannel } = await runBotPickRandomPeers({ peers })

  if (!localChannel || !remoteChannel) {
    console.log(`${getDate()} no unbalanced pairs to match`)
    return undefined
  }

  // repeat rebalancing while it works
  for (let r = 1; r <= MAX_BALANCE_REPEATS; r++) {
    console.log(`${getDate()} Balancing run #${r}`)

    const balancing = await runBotRebalancePeers(
      { localChannel, remoteChannel },
      r === 1
    )

    // on fail check to see if any good previous peer is available
    if (balancing.failed && r === 1) {
      localChannel = await findGoodPeer({ localChannel, remoteChannel })
      if (!localChannel) {
        console.log(`${getDate()} no known alternative peers found`)
        break
      }
      console.log(
        `${getDate()} switching to good peer ${localChannel.alias} 💛💚💙💜`
      )
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

  // ppm should be below this level
  const ppmCheck = trunc(remoteChannel.my_fee_rate / SAFETY_MARGIN)

  // get updated active peer info
  const peers = await runBotGetPeers()

  // get historic info if available
  const logFile =
    BALANCING_LOG_PATH + '/' + remoteChannel.public_key.slice(0, 10) + '.json'
  const logFileData = !fs.existsSync(logFile)
    ? {}
    : JSON.parse(fs.readFileSync(logFile)) || {}
  const balancingData = logFileData.rebalance || []

  if (balancingData.length === 0) return null

  // sort ppm from low to high
  balancingData.sort((a, b) => a.ppm - b.ppm)

  // go through historic events
  // and add potential candidates
  for (const noted of balancingData) {
    if (noted.ppm >= ppmCheck) break // means no more
    // find peer object based on recorded public key
    const public_key = noted.peer

    const peer = peers.find(p => p.public_key === public_key)
    if (!peer) {
      console.error(
        `${getDate()} shouldn't happen: no peer found w/ public key of ${public_key}`
      )
      continue
    }
    const goodMatch =
      // has to be different peer
      public_key !== localChannel.public_key &&
      // and unbalanced enough in remote direction to rebalance
      peer.unbalancedSatsSigned > MAX_REBALANCE_SATS

    if (goodMatch) localCandidates.push(peer)
  }

  if (localCandidates.length === 0) return null

  // pick random peer, ones added at lower ppm or multiple times have more chance
  return localCandidates[trunc(random() * random() * localCandidates.length)]
  // return localCandidates[0] // try lowest fee candidate
}

const runBotGetPeers = async ({ all = false } = {}) => {
  const getMyFees = await bos.getFees()
  const getPeers = all
    ? await bos.peers({ active: undefined, public: undefined })
    : await bos.peers()

  const peers = getPeers
    .map(p => {
      p.my_fee_rate = +getMyFees[p.public_key] || 0
      doBonusPeerCalcs(p)
      return p
    })
    .filter(p => !p.is_offline || all) // remove offline peers if not all to be shown
    .sort((a, b) => b.outbound_liquidity - a.outbound_liquidity)

  return peers
}

// fix and add calculations
const doBonusPeerCalcs = p => {
  p.inbound_fee_rate = +p.inbound_fee_rate || 0
  p.inbound_liquidity = +p.inbound_liquidity || 0
  p.outbound_liquidity = +p.outbound_liquidity || 0
  p.totalSats = p.inbound_liquidity + p.outbound_liquidity
  p.balance = +(p.outbound_liquidity / p.totalSats).toFixed(3)
  p.unbalancedSatsSigned = trunc(
    p.outbound_liquidity * 0.5 - p.inbound_liquidity * 0.5
  )
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

const runBotPickRandomPeers = async ({ peers }) => {
  // make a list of remote heavy and local heavy peers via balance check
  const remoteHeavyPeers = peers.filter(
    p =>
      p.balance < 0.5 - MIN_OFF_BALANCE &&
      p.totalSats >= MIN_CHAN_SIZE &&
      p.unbalancedSats > MIN_REBALANCE_SATS
  )
  const localHeavyPeers = peers.filter(
    p =>
      p.balance > 0.5 + MIN_OFF_BALANCE &&
      p.totalSats >= MIN_CHAN_SIZE &&
      p.unbalancedSats > MIN_REBALANCE_SATS
  )
  if (remoteHeavyPeers.length === 0 || localHeavyPeers.length === 0) return {}

  // Find random local-heavy and remote-heavy pair weighted by sats off-balance
  const remoteSats = remoteHeavyPeers.reduce((sum, p) => +p[WEIGHT] + sum, 0)
  const localSats = localHeavyPeers.reduce((sum, p) => +p[WEIGHT] + sum, 0)
  let remoteRoll = random() * remoteSats
  let localRoll = random() * localSats
  let remoteIndex = 0,
    localIndex = 0
  while (remoteRoll > 0) remoteRoll -= remoteHeavyPeers[remoteIndex++][WEIGHT]
  while (localRoll > 0) localRoll -= localHeavyPeers[localIndex++][WEIGHT]
  const remoteChannel = remoteHeavyPeers[remoteIndex - 1]
  const localChannel = localHeavyPeers[localIndex - 1]

  console.log(`${getDate()}
    Unbalanced pair matched randomly weighted by "${WEIGHT}"
    from ${remoteHeavyPeers.length} remote-heavy and ${
    localHeavyPeers.length
  } local-heavy peers
  `)
  return { localChannel, remoteChannel }
}

const runBotRebalancePeers = async (
  { localChannel, remoteChannel },
  isFirstRun = true
) => {
  const maxFeeRate = max(trunc(remoteChannel.my_fee_rate / SAFETY_MARGIN), 1)
  const minUnbalanced = min(
    remoteChannel.unbalancedSats,
    localChannel.unbalancedSats
  )

  // true means just regular bos rebalance
  const doRebalanceInsteadOfKeysend = isFirstRun || !USE_KEYSENDS_AFTER_BALANCE

  const maxAmount = doRebalanceInsteadOfKeysend
    ? trunc(min(minUnbalanced, MAX_REBALANCE_SATS))
    : trunc(min(minUnbalanced, MAX_REBALANCE_SATS_SEND))

  const rebalanceTime = doRebalanceInsteadOfKeysend
    ? MINUTES_FOR_REBALANCE
    : MINUTES_FOR_SEND

  // prettier-ignore
  console.log(`${getDate()} ${rebalanceTime} minutes limit

    ☂️  me  ${localChannel.my_fee_rate} ppm  ---|-  ${localChannel.inbound_fee_rate} ppm "${localChannel.alias}" ${localChannel.public_key.slice(0, 10)}
    ${(localChannel.outbound_liquidity/1e6).toFixed(2)}M local sats --> (${(localChannel.inbound_liquidity/1e6).toFixed(2)}M) --> ?

    ☂️  me _${remoteChannel.my_fee_rate}_ppm_  -|---  ${remoteChannel.inbound_fee_rate} ppm "${remoteChannel.alias}" ${remoteChannel.public_key.slice(0, 10)}
    (${(remoteChannel.outbound_liquidity/1e6).toFixed(2)}M) <-- ${(remoteChannel.inbound_liquidity/1e6).toFixed(2)}M remote sats <-- ?

    Attempt to rebalance max of ${pretty(maxAmount)} sats at max fee rate of ${maxFeeRate} ppm
    out of ${pretty(minUnbalanced)} sats left to balance for this pair
  `)

  // not enough imbalance to warrant rebalance
  if (maxAmount < MIN_REBALANCE_SATS) {
    console.log(
      `${getDate()} Close enough to balanced: ${pretty(
        maxAmount
      )} sats off-balance is below ${pretty(MIN_REBALANCE_SATS)} sats setting`
    )
    return { failed: true }
  }

  // Always lose money rebalancing remote heavy channel with fee rate lower than remote fee rate
  if (
    remoteChannel.my_fee_rate * SAFETY_MARGIN <
    remoteChannel.inbound_fee_rate
  ) {
    console.log(`${getDate()}
      Attempted balancing aborted (too expensive)
      Fee rate (${remoteChannel.my_fee_rate} ppm) to remote-heavy "${
      remoteChannel.alias
    }"
      was smaller than theirs at ${remoteChannel.inbound_fee_rate} ppm
    `)
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

// timer check
const runBotReconnect = async () => {
  const now = Date.now()
  const timers = JSON.parse(fs.readFileSync(TIMERS_PATH))
  const lastReconnect = timers.lastReconnect || 0
  const timeSince = now - lastReconnect
  const isTimeForReconnect =
    timeSince > 1000 * 60 * 60 * HOURS_BETWEEN_RECONNECTS
  const hoursSince = (timeSince / (1000.0 * 60 * 60)).toFixed(1)
  console.log(
    `${getDate()} ${
      isTimeForReconnect ? 'Time to run' : 'Skipping'
    } bos reconnect. (${HOURS_BETWEEN_RECONNECTS}h timer)` +
      ` Last run: ${
        lastReconnect === 0
          ? 'never'
          : `${hoursSince}h ago at ${getDate(lastReconnect)}`
      }`
  )
  if (isTimeForReconnect) {
    // run reconnet
    await bos.reconnect(true)
    // update timer
    fs.writeFileSync(
      TIMERS_PATH,
      JSON.stringify(
        {
          ...timers,
          lastReconnect: now
        },
        null,
        2
      )
    )
    console.log(`${getDate()} Updated ${TIMERS_PATH}`)
  }
}

// timer check
const runUpdateFees = async () => {
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
      ` Last run: ${
        lastFeeUpdate === 0
          ? 'never'
          : `${minutesSince}m ago at ${getDate(lastFeeUpdate)}`
      }`
  )
  if (isTimeForFeeUpdate) {
    // update fees
    await updateFees()
    // update timer
    fs.writeFileSync(
      TIMERS_PATH,
      JSON.stringify(
        {
          ...timers,
          lastFeeUpdate: now
        },
        null,
        2
      )
    )
    console.log(`${getDate()} Updated ${TIMERS_PATH}`)
  }
}

// logic for updating fees
const updateFees = async () => {
  console.boring(`${getDate()} updateFees()`)

  // generate brand new snapshots
  await generateSnapshots()

  // this gets all snapshot fee info
  const allPeers = JSON.parse(fs.readFileSync(`${SNAPSHOTS_PATH}/peers.json`))
  const peers = allPeers.filter(
    p =>
      !p.is_offline &&
      !p.is_pending &&
      !p.is_private &&
      p.is_active &&
      // leave small channels alone
      p.totalSats > MIN_CHAN_SIZE
  )

  // go through channels
  // grab historic results if available
  // calculate relevant stats
  // calculate new fee
  // if new fee is different, update that fee

  let nIncreased = 0
  let nDecreased = 0

  for (const peer of peers) {
    // check if there are rules about this peer
    const rule = mynode.settings?.rules?.find(r =>
      peer.alias?.includes(r.aliasMatch)
    )

    // rule && console.log(rule, peer.alias)

    // check if this peer has previous bot history file
    const logFile =
      BALANCING_LOG_PATH + '/' + peer.public_key.slice(0, 10) + '.json'
    const logFileData = !fs.existsSync(logFile)
      ? {}
      : JSON.parse(fs.readFileSync(logFile)) || {}
    const balancingData = logFileData.rebalance || []

    const all = median(
      balancingData.filter(isNotEmpty).map(b => b.ppm),
      { obj: true }
    ) // logFileData.ppmAll
    const worked = median(
      balancingData.filter(b => b.failed === false).map(b => b.ppm),
      { obj: true }
    ) // logFileData.ppmWorked

    const now = Date.now()

    // fair ppm based on network value of channel
    // start at 0 ppm
    let ppmFair = 0
    // if overall suggestion ppms are available, use it
    ppmFair = all.bottom25 ? all.bottom25 : ppmFair
    // if worked rebalance ppm is available, use it
    ppmFair = worked.top75
      ? (1.0 * worked.top75 * worked.n * WORKED_WEIGHT + all.bottom25 * all.n) /
        (worked.n * WORKED_WEIGHT + all.n)
      : ppmFair

    // check at what incoming fee will my fee be larger after safety margin is included
    // if my ppm fee is supposed to be smaller, will try to match w/o adding safety margin on top
    // just for cases when balance is on my side and within balance's error margin
    // I shouldn't charge more than peer on a balanced channel with smaller or same target ppm
    // incoming 1000 ppm rate while so far my rate is 200 ppm will just
    // match 1000 ppm on my side instead of adding safety margin to ~1222 ppm
    const incomingFeeBeforeSafety = min(
      peer.inbound_fee_rate - MIN_PPM_FOR_SAFETY,
      peer.inbound_fee_rate / SAFETY_MARGIN
    )
    const ignoreSafetyMargin =
      peer.balance > 0.5 - MIN_OFF_BALANCE && incomingFeeBeforeSafety > ppmFair
    const useSafetyMargin = !ignoreSafetyMargin

    // inbound fee rate should be lowest point for our fee rate unless local heavy
    let ppmSafe = max(ppmFair, peer.inbound_fee_rate)

    // this also ensures at least MIN_PPM_FOR_SAFETY is used for balanced or remote heavy channels
    // safe ppm is also larger than incoming fee rate for rebalancing
    // increase ppm by safety multiplier or by min ppm increase, whichever is greater
    // (removed peer.my_fee_rate)
    ppmSafe = max(
      ppmSafe * (useSafetyMargin ? SAFETY_MARGIN : 1),
      ppmSafe + (useSafetyMargin ? MIN_PPM_FOR_SAFETY : 0)
    )

    // apply rules if present
    let ppmRule = ppmSafe
    ppmRule = rule?.min_ppm !== undefined ? max(rule.min_ppm, ppmRule) : ppmRule
    ppmRule = rule?.max_ppm !== undefined ? min(rule.max_ppm, ppmRule) : ppmRule

    // put a sane max cap on ppm
    const ppmSane = min(MAX_PPM_ABSOLUTE, ppmRule)

    // new setpoint above current?
    const isIncreasing = trunc(ppmSane) > peer.my_fee_rate
    const isDecreasing = trunc(ppmSane) < peer.my_fee_rate
    const daysNoRouting = (now - peer.last_outbound_at) / (1000 * 60 * 60 * 24)
    const daysNoRoutingString =
      peer.last_outbound_at === 0 ? 'n/a' : daysNoRouting.toFixed(2)

    // prettier-ignore
    if (isIncreasing || isDecreasing) {
      console.log(`${getDate()} "${peer.alias}" ${peer.public_key.slice(0, 10)} fee rate check:
        rebalancingStats all:     ${JSON.stringify(all)}
        rebalancingStats worked:  ${JSON.stringify(worked)}
        known rules:              ${JSON.stringify(rule || {})} ${ppmRule !== ppmSafe ? '⛔⛔⛔' : ''}
        days since routing:       ${daysNoRoutingString} (decreases after ${DAYS_FOR_FEE_REDUCTION})

        current stats             ${peer.my_fee_rate} ppm [${(peer.outbound_liquidity / 1e6).toFixed(1)}M <--${peer.balance}--> ${(peer.inbound_liquidity / 1e6).toFixed(1)}M] ${peer.inbound_fee_rate} ppm peer
        fair value                ${ppmFair.toFixed(0)} ppm
        safe value                ${ppmSafe.toFixed(0)} ppm
        rules value               ${ppmRule.toFixed(0)} ppm
        sane value                ${ppmSane.toFixed(0)} ppm ${isIncreasing ? 'increase' : ''}${isDecreasing ? 'decrease' : ''}
      `)
    }

    if (peer.inbound_fee_rate > MAX_PPM_ABSOLUTE) {
      console.log(`${getDate()} "${peer.alias}" ${peer.public_key.slice(0, 10)}
        this peer's fee rate of ${
          peer.inbound_fee_rate
        } ppm is above ${MAX_PPM_ABSOLUTE} ppm ideal limit
      `)
    }

    // even if no adjustments, maybe need to store ppmSane
    // so can use it for rebalancing asap if lower

    // upward adjustments towards ppmSane
    if (ADJUST_FEES && isIncreasing && peer.balance < 0.5 + MIN_OFF_BALANCE) {
      // adjust ppm slowly (by nudge * 100%) from current ppm towards target, +1 if increasing at all
      const ppmStep =
        trunc(peer.my_fee_rate * (1 - NUDGE_UP) + ppmSane * NUDGE_UP) + 1

      nIncreased++

      const resSetFee = await bos.setFees(peer.public_key, ppmStep)
      console.log(
        `${getDate()} Set higher new ${resSetFee} ppm fee rate to "${
          peer.alias
        }" 🔼🔼🔼🔼🔼\n`
      )
      appendRecord({
        peer,
        newRecordData: {
          lastFeeIncrease: now,
          feeChanges: [
            { t: now, ppm: resSetFee },
            ...(logFileData?.feeChanges || [])
          ]
        }
      })

      continue // done w/ this peer
    }

    // downward adjustments towards ppmSane
    // allows only if no routing acctivity
    if (
      ADJUST_FEES &&
      // decreasing possible
      isDecreasing &&
      // inactive enough days
      daysNoRouting > DAYS_FOR_FEE_REDUCTION &&
      // reducing fee rate only
      ppmSane < peer.my_fee_rate &&
      // on balanced or better channels only
      // higher fee helps prevent routing depleted channels anyway
      peer.balance > 0.5 - MIN_OFF_BALANCE
    ) {
      // step to set point
      const ppmStep = max(
        0,
        trunc(peer.my_fee_rate * (1 - NUDGE_DOWN) + ppmSane * NUDGE_DOWN) - 1
      )

      nDecreased++

      const resSetFee = await bos.setFees(peer.public_key, ppmStep)
      console.log(
        `${getDate()} Set lower new ${resSetFee} ppm fee rate to ` +
          `"${peer.alias}" 🔻🔻🔻🔻🔻\n`
      )
      appendRecord({
        peer,
        newRecordData: {
          lastFeeReduction: now,
          feeChanges: [
            { t: now, ppm: resSetFee },
            ...(logFileData?.feeChanges || [])
          ]
        }
      })
    }
  }

  console.log(`${getDate()} fee update summary
    ${allPeers.length} peers
    ${peers.length} considered
    ${nIncreased} increased
    ${nDecreased} decreased
  `)
}

// keep track of peers rebalancing attempts in files
// keep peers separate to avoid rewriting entirety of data at once on ssd
const appendRecord = ({ peer, newRecordData = {}, newRebalance = {} }) => {
  // filename uses 10 first digits of pubkey hex
  const fullPath =
    BALANCING_LOG_PATH + '/' + peer.public_key.slice(0, 10) + '.json'

  // read from old file if exists
  let oldRecord = {}
  try {
    oldRecord = JSON.parse(fs.readFileSync(fullPath))
  } catch (e) {
    console.log(`${getDate()} no previous ${fullPath} record detected`)
  }

  // combine with new datapoint
  const combinedRebalanceData = [
    newRebalance,
    ...(oldRecord?.rebalance?.filter(isNotEmpty).sort((a, b) => b.t - a.t) ||
      [])
  ].filter(isNotEmpty)

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

  console.log(`${getDate()} ${fullPath} "${peer.alias}" updated, ${
    combinedRebalanceData.length
  } records,
    all:      ${JSON.stringify(ppmAll)}
    worked:   ${JSON.stringify(ppmWorked)}
  `)
}

// generate data to save to files for easier external browsing
const generateSnapshots = async () => {
  console.boring(`${getDate()} generateSnapshots()`)

  // on-chain channel info switched to object with keys of channel "id" ("partner_public_key" inside)
  // bos treats peers like every channel is combined but can have multiple channels w/ diff id w/ same peer
  const getChannels = await bos.callAPI('getChannels')
  const idToPublicKey = {}
  const publicKeyToIds = {}
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

  console.log(
    `${getDate()} overall channel capacity`,
    median(
      getChannels.channels.map(d => d.capacity),
      { f: pretty }
    )
  )

  // my LN fee info (w/ base fees) switched to object by channel "id" as keys
  const getFeeRates = await bos.callAPI('getFeeRates')
  const feeRates = getFeeRates.channels.reduce((final, channel) => {
    final[channel.id] = channel
    return final
  }, {})

  console.log(
    `${getDate()} overall ppm`,
    median(getFeeRates.channels.map(d => d.fee_rate))
  )
  console.log(
    `${getDate()} overall base msats`,
    median(getFeeRates.channels.map(d => +d.base_fee_mtokens))
  )

  // forwards lookback
  const getForwards = await bos.forwards({ days: DAYS_FOR_STATS }, false)
  const forwards = getForwards.reduce((final, peer) => {
    // convert ISO string to timestamp
    peer.last_inbound_at = Date.parse(peer.last_inbound_at) || 0
    peer.last_outbound_at = Date.parse(peer.last_outbound_at) || 0
    // assert
    if (final[peer.public_key]) {
      console.warn('\n\n duplicate forwards \n\n')
      process.exit()
    }
    final[peer.public_key] = peer
    return final
  }, {})
  console.log(
    `${getDate()} number of channels routing-out last ${DAYS_FOR_STATS} days: ${
      getForwards.filter(peer => peer.last_outbound_at).length
    }`
  )
  console.log(
    `${getDate()} earned sats total:`,
    getForwards.reduce((sum, peer) => sum + (peer.earned_outbound_fees || 0), 0)
  )
  console.log(
    `${getDate()} stats on fees earned per peer: ${median(
      getForwards.map(peer => peer.earned_outbound_fees || 0),
      { f: pretty }
    )}`
  )

  // specific routing events
  // const getForwardingEvents = await bos.callAPI('getForwards', {token: `{"offset":0,"limit":5}`})
  // console.log(getForwardingEvents)

  // get all peers info
  const peers = await runBotGetPeers({ all: true })
  console.log(`${getDate()} Total peers found from "bos peers":`, peers.length)

  // add in channel id's for each peer
  peers.forEach(peer => {
    // add fee data
    peer.last_inbound_at = forwards[peer.public_key]?.last_inbound_at || 0
    peer.last_outbound_at = forwards[peer.public_key]?.last_outbound_at || 0
    peer.earned_inbound_fees =
      forwards[peer.public_key]?.earned_inbound_fees || 0
    peer.earned_outbound_fees =
      forwards[peer.public_key]?.earned_outbound_fees || 0

    // grab array of separate short channel id's for this peer
    const ids = publicKeyToIds[peer.public_key]

    // convert array of text ids to array of info for each ids channel
    peer.ids = ids.reduce((final, id) => {
      // if any of the our channels are active I'll mark peer as active
      peer.is_active = !!peer.is_active || channelOnChainInfo[id].is_active

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
          (channelOnChainInfo[id].time_online +
            channelOnChainInfo[id].time_offline)
        ).toFixed(5)
        // bugged in bos call getChannels right now, will re-add if fixed
        // local_max_pending_mtokens: +channelOnChainInfo[id].local_max_pending_mtokens,
        // local_min_htlc_mtokens: +channelOnChainInfo[id].local_min_htlc_mtokens,
        // remote_max_pending_mtokens: +channelOnChainInfo[id].remote_max_pending_mtokens,
        // remote_min_htlc_mtokens: +channelOnChainInfo[id].remote_min_htlc_mtokens
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

  // idea for normalized metric "unbalanced %"
  // 2 * sats-away-from-balance / total capacity * 100%
  // completely unbalanced would be like 2*5M/10M = 100%
  // complete balanced would be 0 / 10M = 0%
  const totalSatsOffBalance = peers.reduce(
    (sum, peer) => sum + peer.unbalancedSats,
    0
  )
  const totalCapacity = peers.reduce((sum, peer) => sum + peer.totalSats, 0)
  const unbalancedPercent = (
    ((2.0 * totalSatsOffBalance) / totalCapacity) *
    100
  ).toFixed(0)
  console.log(`${getDate()} total unbalanced percent: ${unbalancedPercent}%`)

  const totalSatsOffBalanceSigned = peers.reduce(
    (sum, peer) => sum + peer.unbalancedSatsSigned,
    0
  )
  console.log(`${getDate()}
    total unbalanced sats: ${pretty(totalSatsOffBalanceSigned)}
    ${
      totalSatsOffBalanceSigned > 0
        ? 'lacking inbound liquidity (get/rent others to open channels to you' +
          ' or loop-out/boltz/muun/WoS LN to on-chain funds'
        : ''
    }
    ${
      totalSatsOffBalanceSigned < 0
        ? 'lacking local sats (open channels to increase local or reduce' +
          'amount of remote via loop-in or opening channel to sinks like LOOP)'
        : ''
    }
  `)

  // write LN state snapshot to files
  fs.writeFileSync(
    `${SNAPSHOTS_PATH}/channelOnChainInfo.json`,
    JSON.stringify(channelOnChainInfo, fixJSON, 2)
  )
  fs.writeFileSync(
    `${SNAPSHOTS_PATH}/publicKeyToIds.json`,
    JSON.stringify(publicKeyToIds, fixJSON, 2)
  )
  fs.writeFileSync(
    `${SNAPSHOTS_PATH}/idToPublicKey.json`,
    JSON.stringify(idToPublicKey, fixJSON, 2)
  )
  fs.writeFileSync(
    `${SNAPSHOTS_PATH}/feeRates.json`,
    JSON.stringify(feeRates, fixJSON, 2)
  )
  fs.writeFileSync(
    `${SNAPSHOTS_PATH}/peers.json`,
    JSON.stringify(peers, fixJSON, 2)
  )

  fs.writeFileSync(
    `${SNAPSHOTS_PATH}/forwards_${DAYS_FOR_STATS}days.json`,
    JSON.stringify(forwards, fixJSON, 2)
  )
}

// starts everything
const initialize = async () => {
  //
  // get your own public key
  const getIdentity = await bos.callAPI('getIdentity')
  if (!getIdentity.public_key || getIdentity.public_key.length < 10)
    throw 'no pubkey'
  mynode.my_public_key = getIdentity.public_key
  console.log(`${getDate()}
  ========================================================

    this node's public key is

      "${mynode.my_public_key}"

    IF THIS IS INCORRECT, ctrl + c

  ========================================================
  `)

  // folders for info & balancing snapshots
  if (!fs.existsSync(BALANCING_LOG_PATH))
    fs.mkdirSync(BALANCING_LOG_PATH, { recursive: true })
  if (!fs.existsSync(SNAPSHOTS_PATH))
    fs.mkdirSync(SNAPSHOTS_PATH, { recursive: true })

  // load settings.json
  if (fs.existsSync('settings.json')) {
    mynode.settings = JSON.parse(fs.readFileSync('settings.json'))
  }

  // generate timers file if there's not one
  if (!fs.existsSync(TIMERS_PATH)) {
    fs.writeFileSync(
      TIMERS_PATH,
      JSON.stringify(
        {
          lastReconnect: 0,
          lastFeeUpdate: 0
        },
        fixJSON,
        2
      )
    )
  }

  // generate snapshots at start for easy access to data
  await generateSnapshots()

  console.log(`${getDate()}\n\n5 seconds to abort\n\n`)
  await sleep(5 * 1000)

  // start bot loop
  runBot()
}

const pretty = n => String(n).replace(/\B(?=(\d{3})+\b)/g, '_')

const getDate = timestamp =>
  (timestamp ? new Date(timestamp) : new Date()).toISOString()

const fixJSON = (k, v) => (v === undefined ? null : v)

const isEmpty = obj =>
  !!obj && Object.keys(obj).length === 0 && obj.constructor === Object
const isNotEmpty = obj => !isEmpty(obj)

console.boring = args => console.log(`\x1b[2m${args}\x1b[0m`)

const { min, max, trunc, floor, abs, random } = Math

const sleep = async ms => await new Promise(r => setTimeout(r, trunc(ms)))

// returns mean, truncated fractions
const median = (numbers = [], { obj = false, f = v => v } = {}) => {
  const sorted = numbers
    .slice()
    .filter(v => !isNaN(v))
    .sort((a, b) => a - b)
  const n = sorted.length
  if (!numbers || numbers.length === 0 || n === 0)
    return !obj ? '{"n":0}' : { n: 0 }
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
    median: f(
      sorted.length % 2 === 0
        ? trunc((sorted[middle - 1] + sorted[middle]) / 2.0)
        : trunc(sorted[middle])
    ),
    top75: f(
      sorted.length % 4 === 0
        ? trunc((sorted[middleTop - 1] + sorted[middleTop]) / 2.0)
        : trunc(sorted[middleTop])
    ),
    top: f(sorted[numbers.length - 1])
  }

  return !obj ? JSON.stringify(result, fixJSON) : result
}

initialize()
