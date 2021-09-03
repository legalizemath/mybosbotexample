import fs from 'fs'
import bos from './bos.js'

const MINUTES_BETWEEN_STEPS = 10          // time to sleep between trying a bot step again
const MIN_CHAN_SIZE = 1.5e6               // channels smaller than this not necessary to balance
const MIN_OFF_BALANCE = 0.1               // channels less off-balance are not necessary to balance
const MAX_REBALANCE_SATS = 4.2e5          // limit of sats to balance per attempt
const MIN_REBALANCE_SATS = 0.9e5          // unbalanced sats below this not necessary to balance
const SAFETY_MARGIN = 1.10                // max factor for changing rates
const MIN_PPM_FOR_SAFETY = 222            // never let fee rate go lower
const MAX_PPM_ABSOLUTE = 2900             // never let ppm go above this for fee rate or rebalancing
const NUDGE = 0.05                        // adjustment to target rebalance ppm
const MINUTES_FOR_REBALANCE = 2           // max minutes to spend per rebalance try
const MAX_BALANCE_REPEATS = Math.ceil(
  15e6 / 2 / MAX_REBALANCE_SATS
)                                         // max repeats to balance if successful
const HOURS_BETWEEN_RECONNECTS = 2        // hours between running bos reconnect
const MINUTES_BETWEEN_FEE_CHANGES = 60    // how often to update fees
const WEIGHT_OPTIONS = {                  // what to weight random selection by
  UNBALANCED_SATS: 'unbalancedSats',
  CHANNEL_SIZE: 'totalSats',
  MY_FEE_RATE: 'my_fee_rate'
}
const WEIGHT = WEIGHT_OPTIONS.UNBALANCED_SATS   // rnd weight choice
const USE_KEYSENDS_AFTER_BALANCE = true         // rebalance with faster keysends after bos rebalance works
const SNAPSHOTS_PATH = './snapshots'
const BALANCING_LOG_PATH = './peers'
const TIMERS_PATH = 'timers.json'

// required own public key for keysends to self to rebalance
const { MY_PUBLIC_KEY } = JSON.parse(fs.readFileSync('settings.json'))

const runBotUpdateStep = async () => {
  console.log(`${getDate()} runBotUpdateStep() starts`)

  const peers = await runBotGetPeers({saveFile: true})

  const {localChannel, remoteChannel} = await runBotPickRandomPeers({peers})

  if (!localChannel || !remoteChannel) {
    console.log(`${getDate()} no unbalanced pairs to match`)
    return undefined
  }

  for (let r = 1; r <= MAX_BALANCE_REPEATS; r++) {
    console.log(`${getDate()} Balancing run #${r}`)
    const balancing = await runBotRebalancePeers({localChannel, remoteChannel}, r === 1)
    if (balancing.failed) break // stop repeating if balancing failed
    await runBotUpdatePeers([localChannel, remoteChannel])
  }
  console.log(`${getDate()} runBotUpdateStep() done`)
}

const runBotGetPeers = async ({saveFile = false} = {}) => {
  const getMyFees = await bos.getFees()
  const getPeers = await bos.getPeers()

  const peers = getPeers
    .map(p => {
      p.my_fee_rate = +getMyFees[p.public_key] || 0
      doBonusPeerCalcs(p)
      return p
    })
    .sort((a, b) => b.unbalancedSatsSigned - a.unbalancedSatsSigned)

  if (saveFile) {
    fs.writeFileSync(
      `${SNAPSHOTS_PATH}/peers.json`,
      JSON.stringify(peers, (k, v) => v === undefined ? null : v, 2)
    )
  }

  // remove irrelevant for bot stuff
  return peers.filter(p => !p.is_offline) // remove offline peerrs
}

const doBonusPeerCalcs = p => {
  p.inbound_fee_rate = +p.inbound_fee_rate || 0
  p.inbound_liquidity = +p.inbound_liquidity || 0
  p.outbound_liquidity = +p.outbound_liquidity || 0
  p.totalSats = p.inbound_liquidity + p.outbound_liquidity
  p.balance = +(p.outbound_liquidity / p.totalSats).toFixed(3)
  p.unbalancedSatsSigned = Math.trunc(
    p.outbound_liquidity * 0.5 - p.inbound_liquidity * 0.5
  )
  p.unbalancedSats = Math.abs(p.unbalancedSatsSigned)
}

// update each peer in array of oldPeers in-place
const runBotUpdatePeers = async (oldPeers) => {
  // const getMyFees = await bos.getFees()
  // const newPeers = await bos.getPeers()
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

const runBotPickRandomPeers = async ({peers}) => {
  // make a list of remote heavy and local heavy peers via balance check
  const remoteHeavyPeers = peers.filter(p => p.balance < 0.5 - MIN_OFF_BALANCE && p.totalSats >= MIN_CHAN_SIZE && p.unbalancedSats > MIN_REBALANCE_SATS)
  const localHeavyPeers = peers.filter(p => p.balance > 0.5 + MIN_OFF_BALANCE && p.totalSats >= MIN_CHAN_SIZE && p.unbalancedSats > MIN_REBALANCE_SATS)
  if (remoteHeavyPeers.length === 0 || localHeavyPeers.length === 0) return {};

  // Find random local-heavy and remote-heavy pair weighted by sats off-balance
  const remoteSats = remoteHeavyPeers.reduce((sum, p) => p[WEIGHT] + sum, 0)
  const localSats = localHeavyPeers.reduce((sum, p) => p[WEIGHT] + sum, 0)
  let remoteRoll = Math.random() * remoteSats
  let localRoll = Math.random() * localSats
  let remoteIndex = 0, localIndex = 0
  while (remoteRoll > 0) remoteRoll -= remoteHeavyPeers[remoteIndex++][WEIGHT]
  while (localRoll > 0) localRoll -= localHeavyPeers[localIndex++][WEIGHT]
  const remoteChannel = remoteHeavyPeers[remoteIndex - 1]
  const localChannel = localHeavyPeers[localIndex - 1]

  console.log(`${getDate()}
    Unbalanced pair matched randomly weighted by "${WEIGHT}"
    from ${remoteHeavyPeers.length} remote-heavy and ${localHeavyPeers.length} local-heavy peers
  `)
  return {localChannel, remoteChannel}
}

const runBotRebalancePeers = async ({localChannel, remoteChannel}, isFirstRun = true) => {

  const maxFeeRate = Math.max(Math.trunc(remoteChannel.my_fee_rate / SAFETY_MARGIN), 1)
  const minUnbalanced = Math.min(remoteChannel.unbalancedSats, localChannel.unbalancedSats)
  const maxAmount = Math.trunc(Math.min(minUnbalanced, MAX_REBALANCE_SATS))
  console.log(`${getDate()}

    ☂️  me  ${localChannel.my_fee_rate} ppm  ---|-  ${localChannel.inbound_fee_rate} ppm "${localChannel.alias}" ${localChannel.public_key.slice(0, 10)}
    ${(localChannel.outbound_liquidity/1e6).toFixed(2)}M local sats --> (${(localChannel.inbound_liquidity/1e6).toFixed(2)}M) --> ?

    ☂️  me _${remoteChannel.my_fee_rate}_ppm_  -|---  ${remoteChannel.inbound_fee_rate} ppm "${remoteChannel.alias}" ${remoteChannel.public_key.slice(0, 10)}
    (${(remoteChannel.outbound_liquidity/1e6).toFixed(2)}M) <-- ${(remoteChannel.inbound_liquidity/1e6).toFixed(2)}M remote sats <-- ?

    Attempt to rebalance max of ${pretty(maxAmount)} sats at max fee rate of ${maxFeeRate} ppm
    out of ${pretty(minUnbalanced)} sats left to balance for this pair
  `)

  // not enough imbalance to warrant rebalance
  if (maxAmount < MIN_REBALANCE_SATS) {
    console.log(`${getDate()} Close enough to balanced: ${pretty(maxAmount)} sats off-balance is below ${pretty(MIN_REBALANCE_SATS)} sats setting`)
    return {failed: true}
  }

  // Always lose money rebalancing remote heavy channel with fee rate lower than remote fee rate
  if (remoteChannel.my_fee_rate * SAFETY_MARGIN < remoteChannel.inbound_fee_rate) {
    console.log(`${getDate()}
      Attempted balancing aborted (too expensive)
      Fee rate (${remoteChannel.my_fee_rate} ppm) to remote-heavy "${remoteChannel.alias}"
      was smaller than theirs at ${remoteChannel.inbound_fee_rate} ppm
    `)
    // const newFeeRate = Math.trunc(remoteChannel.inbound_fee_rate * SAFETY_MARGIN * SAFETY_MARGIN + 1)
    // const resSetFee = await bos.setFees(remoteChannel.public_key, newFeeRate)
    // console.log(`${getDate()} Set higher new ${resSetFee} ppm fee rate to "${remoteChannel.alias}"`)
    return {failed: true}
  }

  // do the rebalance
  // switch to keysends if that setting is on && not first run
  const resBalance = isFirstRun || !USE_KEYSENDS_AFTER_BALANCE
    ? await bos.rebalance({
      fromChannel: localChannel.public_key,
      toChannel: remoteChannel.public_key,
      maxSats: maxAmount,
      maxMinutes: MINUTES_FOR_REBALANCE,
      maxFeeRate
    })
    : await bos.send({
        destination: MY_PUBLIC_KEY,
        fromChannel: localChannel.public_key,
        toChannel: remoteChannel.public_key,
        sats: maxAmount,
        maxMinutes: 1,
        maxFeeRate
      })

  // display successful rebalance cost
  if (!resBalance.failed) {
    console.log(`${getDate()} rebalanced ${pretty(resBalance.rebalanced)} sats at ${resBalance.fee_rate} ppm! 😁😁😁😁😁`)
  }

  // if rebalance worked on 1st try, record it, for now try lowering fee rate
  if (!resBalance.failed && isFirstRun) {
    const workedRate = resBalance.fee_rate
    const attemptedFeeRate = remoteChannel.my_fee_rate
    // const peerFeeRate = remoteChannel.inbound_fee_rate
    // const newFeeRate = Math.trunc(Math.max(
    //   // absolute smallest ppm for remote heavy channel
    //   MIN_PPM_FOR_SAFETY,
    //   // never go lower than peer fee rate for remote heavy channel
    //   peerFeeRate * SAFETY_MARGIN * SAFETY_MARGIN,
    //   // adjust slightly towards working ppm
    //   attemptedFeeRate * (1 - NUDGE) + workedRate * SAFETY_MARGIN * NUDGE,
    //   // don't change more than this rate total
    //   attemptedFeeRate / SAFETY_MARGIN
    // ))

    console.log(`${getDate()} Fee rate to "${remoteChannel.alias}" is ${attemptedFeeRate} ppm, worked with ${(workedRate * SAFETY_MARGIN).toFixed(0)} ppm`)
    // if (newFeeRate < attemptedFeeRate) {
    //   const resSetFee = await bos.setFees(remoteChannel.public_key, newFeeRate)
    //   console.log(`${getDate()} Set ${resSetFee} ppm fee to "${remoteChannel.alias}"`)
    // }

    // record rebalance cost
    appendRecord({
      peer: remoteChannel,
      newRebalance: {
        t: Date.now(),
        ppm: resBalance.fee_rate,
        failed: false,
        peer: localChannel.public_key,
        peerAlias: localChannel.alias,
        sats: resBalance.rebalanced
      }
    })

  }

  // if rebalance possible but needs higher rate
  if (resBalance.failed && isFirstRun && resBalance.ppmSuggested) {
    const attemptedFeeRate = remoteChannel.my_fee_rate
    const suggestedFeeRate = resBalance.ppmSuggested
    // const newFeeRate = Math.min(
    //   // nudge fee rate towards suggested fee rate
    //   Math.trunc(attemptedFeeRate * (1 - NUDGE) + suggestedFeeRate * SAFETY_MARGIN * NUDGE) + 1,
    //   // keep adjustment below max rate overall
    //   Math.trunc(attemptedFeeRate * SAFETY_MARGIN) + 1,
    //   // keep below max reasonable ppm
    //   MAX_PPM_ABSOLUTE
    // )

    console.log(`${getDate()} Fee rate to "${remoteChannel.alias}" is ${attemptedFeeRate} ppm, suggested ${(suggestedFeeRate * SAFETY_MARGIN).toFixed(0)} ppm`)
    // if (newFeeRate > attemptedFeeRate) {
    //  const resSetFee = await bos.setFees(remoteChannel.public_key, newFeeRate)
    //  console.log(`${getDate()} Set ${resSetFee} ppm fee to "${remoteChannel.alias}"`)
    // }

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
  const isTimeForReconnect = timeSince > 1000 * 60 * 60 * HOURS_BETWEEN_RECONNECTS
  const hoursSince = (timeSince / (1000.0 * 60 * 60)).toFixed(1)
  console.log(
    `${getDate()} ${isTimeForReconnect ? 'Time to run' : 'Skipping'} bos reconnect. (${HOURS_BETWEEN_RECONNECTS}h timer)` +
    ` Last run: ${lastReconnect === 0 ? 'never' : `${hoursSince}h ago at ${getDate(lastReconnect)}`}`
  )
  if (isTimeForReconnect) {
    // run reconnet
    await bos.reconnect(true)
    // update timer
    fs.writeFileSync(TIMERS_PATH, JSON.stringify({
      ...timers,
      lastReconnect: now
    }, null, 2))
    console.log(`${getDate()} Updated ${TIMERS_PATH}`)
  }
}

// timer check
const runUpdateFees = async () => {
  const now = Date.now()
  const timers = JSON.parse(fs.readFileSync(TIMERS_PATH))
  const lastFeeUpdate = timers.lastFeeUpdate || 0
  const timeSince = now - lastFeeUpdate
  const isTimeForFeeUpdate =  timeSince > 1000 * 60 * MINUTES_BETWEEN_FEE_CHANGES
  const minutesSince = (timeSince / (1000.0 * 60)).toFixed(1)
  console.log(
    `${getDate()} ${isTimeForFeeUpdate ? 'Time to run' : 'Skipping'} fee/channel updates. (${MINUTES_BETWEEN_FEE_CHANGES}m timer)` +
    ` Last run: ${lastFeeUpdate === 0 ? 'never' : `${minutesSince}m ago at ${getDate(lastFeeUpdate)}`}`
  )
  if (isTimeForFeeUpdate) {
    // update fees
    await updateFees()
    // update timer
    fs.writeFileSync(TIMERS_PATH, JSON.stringify({
      ...timers,
      lastFeeUpdate: now
    }, null, 2))
    console.log(`${getDate()} Updated ${TIMERS_PATH}`)
  }
}

// logic for updating fees
const updateFees = async () => {
  console.log(`${getDate()} updateFees()`)

  // this gets all the fee info for every channel
  const peers = await runBotGetPeers()

  // go through channels
  // grab historic results if available
  // calculate relevant stats
  // calculate new fee
  // if new fee is different, update that fee
  for (const peer of peers) {

    // leave small channels alone
    if (peer.totalSats < MIN_CHAN_SIZE) continue

    // if it's remote heavy or balanced only
    if (peer.balance < 0.5 + MIN_OFF_BALANCE) {

      const logFile = BALANCING_LOG_PATH + '/' + peer.public_key.slice(0, 10) + '.json'
      const balancingData = !fs.existsSync(logFile) ? [] : JSON.parse(fs.readFileSync(logFile))?.rebalance || []

      const all = median(balancingData.map(b => b.ppm), {obj: true})
      const worked = median(balancingData.filter(b => !b.failed).map(b => b.ppm), {obj: true})

      // start at 0 ppm
      let ppmFair = 0
      // if overall suggestion ppms are available, use it
      ppmFair = all.bottom25 ? all.bottom25 : ppmFair
      // if worked rebalance ppm is available, use it
      ppmFair = worked.top75 ? (1.0 * worked.top75 * worked.n * MAX_BALANCE_REPEATS + all.bottom25 * all.n) / (worked.n * MAX_BALANCE_REPEATS + all.n) : ppmFair
      // make ppm larger than incoming fee rate for rebalancing
      const incomingFeeBeforeSafety = Math.min(peer.inbound_fee_rate - MIN_PPM_FOR_SAFETY, peer.inbound_fee_rate / SAFETY_MARGIN)
      // add safety margin just when raising fee to the incoming fee with channel on the remote side
      const ignoreSafety = peer.balance > 0.5 && incomingFeeBeforeSafety > ppmFair
      // inbound fee rate should be lowest point for our fee rate regardless
      ppmFair = Math.max(ppmFair,  peer.inbound_fee_rate)

      ppmFair = Math.trunc(ppmFair)

      // increase ppm by safety multiplier or by min ppm increase, whichever is greater, otherwise just use current
      const ppmSafe = Math.trunc(Math.max(peer.my_fee_rate, ppmFair * (!ignoreSafety ? SAFETY_MARGIN : 1), ppmFair + (!ignoreSafety ? MIN_PPM_FOR_SAFETY : 0)))
      // cap ppm
      const ppmSane = Math.trunc(Math.min(MAX_PPM_ABSOLUTE, ppmSafe))

      // this target only handles increasing ppm logic
      const isIncreasing = ppmSane > peer.my_fee_rate

      // adjust ppm slowly (by nudge * 100%) from current ppm towards target
      const ppmNew = Math.trunc(peer.my_fee_rate * (1 - NUDGE) + ppmSane * NUDGE) + (isIncreasing ? 1 : 0)

      console.log(`${getDate()} "${peer.alias}" ${peer.public_key.slice(0, 10)} fee rate increase check:
        rebalancingStats all: ${JSON.stringify(all)}
        rebalancingStats worked: ${JSON.stringify(worked)}

        current stats       ${peer.my_fee_rate} ppm [${(peer.outbound_liquidity / 1e6).toFixed(1)}M <---> ${(peer.inbound_liquidity / 1e6).toFixed(1)}M] ${peer.inbound_fee_rate} ppm peer
        fair value          ${ppmFair} ppm
        safe value          ${ppmSane} ppm
        step value          ${isIncreasing ? ppmNew + ' ppm' : 'no increase'}
      `)

      if (isIncreasing) {
        const resSetFee = await bos.setFees(peer.public_key, ppmNew)
        console.log(`${getDate()} Set higher new ${resSetFee} ppm fee rate to "${peer.alias}"\n`)
        continue // done with this peer
        // break // for testing of just 1 peer
      }
    }
  }
}

// keep peers separate to avoid rewriting entirety of data at once on ssd alias, public_key
const appendRecord = ({peer, newRebalance = {}}) => {
  // filename uses 10 first digits of pubkey hex
  const fullPath = BALANCING_LOG_PATH + '/' + peer.public_key.slice(0, 10) + '.json'

  // read from old file if exists
  let oldData = {}
  try {
    oldData = JSON.parse(fs.readFileSync(fullPath))
  } catch(e) {
    console.log(`${getDate()} no previous ${fullPath} record detected`)
  }

  // combine with new datapoint
  const combinedData = [
    newRebalance,
    ...(oldData?.rebalance || [])
  ]

  // calculate median ppm
  const ppmMedian = median(combinedData.map(d => d.ppm), {obj: true})

  // remove old data in future

  // update just this peers file
  fs.writeFileSync(fullPath, JSON.stringify({
    alias: peer.alias,
    public_key: peer.public_key,
    ppmMedian,
    rebalance: combinedData
  }, null, 2))

  console.log(`${getDate()} ${fullPath} "${peer.alias}" updated, ${combinedData.length} records, ppm fees:`, JSON.stringify(ppmMedian))
}

const runBot = async () => {

  // try a rebalance
  await runBotUpdateStep()

  // check if time for updating fees
  await runUpdateFees()

  // check if time for bos reconnect
  await runBotReconnect()

  // pause
  console.log(`\n${getDate()} ${MINUTES_BETWEEN_STEPS} minutes pause\n`)
  await new Promise(r => setTimeout(r, Math.trunc(MINUTES_BETWEEN_STEPS * 60 * 1000)))

  // restart
  runBot()
}

const initialize = async () => {
  console.log(`${getDate()} my node public_key ${MY_PUBLIC_KEY}`)

  // folders for info & balancing snapshots
  if (!fs.existsSync(BALANCING_LOG_PATH)) fs.mkdirSync(BALANCING_LOG_PATH, { recursive: true })
  if (!fs.existsSync(SNAPSHOTS_PATH)) fs.mkdirSync(SNAPSHOTS_PATH, { recursive: true })
  // generate timers file if there's not one
  if (!fs.existsSync(TIMERS_PATH)) {
    fs.writeFileSync(TIMERS_PATH, JSON.stringify({
      lastReconnect: 0,
      lastFeeUpdate: 0
    }, null, 2))
  }

  // on-chain channel info
  const getChannels = await bos.callAPI('getChannels')
  fs.writeFileSync(`${SNAPSHOTS_PATH}/channelopens.json`, JSON.stringify(getChannels, null, 2))
  console.log(`${getDate()} overall channel capacity`, median(getChannels.channels.map(d => d.capacity), {f: pretty}))

  const getFeeRates = await bos.callAPI('getFeeRates')
  fs.writeFileSync(`${SNAPSHOTS_PATH}/feeRates.json`, JSON.stringify(getFeeRates, null, 2))
  console.log(`${getDate()} overall ppm`, median(getFeeRates.channels.map(d => d.fee_rate)))
  console.log(`${getDate()} overall base msats`, median(getFeeRates.channels.map(d => (+d.base_fee_mtokens))))


  // start bot loop
  runBot()
}

// -------------------------- extras ---------------------------

const pretty = n => String(n).replace(/\B(?=(\d{3})+\b)/g, "_")

const getDate = timestamp => (timestamp ? new Date(timestamp) : new Date()).toISOString()

// returns mean, truncated fractions
const median = (numbers, {obj = false, f = v => v} = {}) => {
  const n = numbers.length

  if (!numbers || n === 0) return !obj ? '{}' : {}

  const sorted = numbers.slice().sort((a, b) => a - b)
  const middle = Math.floor(sorted.length * 0.50)
  const middleTop = Math.floor(sorted.length * 0.75)
  const middleBottom = Math.floor(sorted.length * 0.25)

  const result = {
    n,
    avg: f(Math.trunc(sorted.reduce((sum, val) => sum + val, 0) / sorted.length)),
    bottom: f(sorted[0]),
    bottom25: f(sorted.length % 4 === 0
      ? Math.trunc((sorted[middleBottom - 1] + sorted[middleBottom]) / 2.0)
      : Math.trunc(sorted[middleBottom])
    ),
    median: f(sorted.length % 2 === 0
      ? Math.trunc((sorted[middle - 1] + sorted[middle]) / 2.0)
      : Math.trunc(sorted[middle])
    ),
    top75: f(sorted.length % 4 === 0
      ? Math.trunc((sorted[middleTop - 1] + sorted[middleTop]) / 2.0)
      : Math.trunc(sorted[middleTop])
    ),
    top: f(sorted[numbers.length - 1]),
  }

  return !obj ? JSON.stringify(result) : result
}

initialize()
