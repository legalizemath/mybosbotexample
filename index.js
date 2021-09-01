import fs from 'fs'
import bos from './bos.js'

const MINUTES_BETWEEN_STEPS = 10        // time to sleep between trying a bot step again
const MIN_CHAN_SIZE = 1.5e6             // channels smaller than this not necessary to balance
const MIN_OFF_BALANCE = 0.2             // channels less off-balance are not necessary to balance
const MAX_REBALANCE_SATS = 5e5          // limit of sats to balance per attempt
const MIN_REBALANCE_SATS = 1e5          // unbalanced sats below this not necessary to balance
const SAFETY_MARGIN = 1.05              // max factor for changing rates
const MIN_PPM_FOR_REMOTE_HEAVY = 222    // never let fee rate go lower
const MAX_PPM_ABSOLUTE = 2999           // never let ppm go above this for fee rate or rebalancing
const NUDGE = 0.1                       // adjustment to target rebalance ppm
const MINUTES_FOR_REBALANCE = 2         // max minutes to spend per rebalance try
const MAX_BALANCE_REPEATS = 15          // max repeats to balance if successful
const HOURS_BETWEEN_RECONNECTS = 3      // hours between running bos reconnect
const WEIGHT_OPTIONS = {                // what to weight random selection by
  UNBALANCED_SATS: 'unbalancedSats',
  CHANNEL_SIZE: 'totalSats'
}
const WEIGHT = WEIGHT_OPTIONS.UNBALANCED_SATS   // rnd weight choice

const runBotUpdateStep = async () => {
  console.log(`${getDate()} runBotUpdateStep() starts`)

  const peers = await runBotGetPeers()
  fs.writeFileSync('peers.json', JSON.stringify(peers, null, 2))

  const {localChannel, remoteChannel} = await runBotPickRandomPeers({peers})

  for (let r = 1; r <= MAX_BALANCE_REPEATS; r++) {
    console.log(`${getDate()} Balancing run #${r}`)
    const balancing = await runBotRebalancePeers({localChannel, remoteChannel}, r === 1)
    if (balancing.failed) break // stop repeating if balancing failed
    await runBotUpdatePeers([localChannel, remoteChannel])
  }
  console.log(`${getDate()} runBotUpdateStep() done`)
}

const runBotGetPeers = async () => {
  const getMyFees = await bos.getFees()
  const getPeers = await bos.getPeers()
  const peers = getPeers
    .map(p => {
      p.my_fee_rate = +getMyFees[p.public_key]
      doBonusPeerCalcs(p)
      return p
    })
  peers.sort((a, b) => b.unbalancedSatsSigned - a.unbalancedSatsSigned)
  return peers
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

const runBotUpdatePeers = async (oldPeers) => {
  const getMyFees = await bos.getFees()
  const newPeers = await bos.getPeers()
  for (const p of oldPeers) {
    for (const newPeer of newPeers) {
      if (p.public_key === newPeer.public_key) {
        // redo the calc from before w/o changing peer object reference
        p.my_fee_rate = +getMyFees[p.public_key]
        p.inbound_liquidity = newPeer.inbound_liquidity || 0
        p.outbound_liquidity = newPeer.outbound_liquidity || 0
        doBonusPeerCalcs(p)
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
  const maxAmount = Math.min(minUnbalanced, MAX_REBALANCE_SATS)
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
    console.log(`${getDate()} Close enough to balanced: ${pretty(maxAmount)} sats off-balance is below ${pretty(MIN_REBALANCE_SATS)} sats limit`)
    return {failed: true}
  }

  // Always lose money rebalancing remote heavy channel with fee rate lower than remote fee rate
  if (remoteChannel.my_fee_rate * SAFETY_MARGIN * SAFETY_MARGIN <= remoteChannel.inbound_fee_rate) {
    console.log(`${getDate()}
      Balancing aborted (too expensive)
      Fee rate (${remoteChannel.my_fee_rate} ppm) to remote-heavy "${remoteChannel.alias}"
      was not higher than theirs at ${remoteChannel.inbound_fee_rate} ppm
    `)
    const newFeeRate = Math.trunc(remoteChannel.inbound_fee_rate * SAFETY_MARGIN * SAFETY_MARGIN + 1)
    // const resSetFee = await bos.setFees(remoteChannel.public_key, newFeeRate)
    // console.log(`${getDate()} Set higher new ${resSetFee} ppm fee rate to "${remoteChannel.alias}"`)
    return {failed: true}
  }

  // do the rebalance
  const resBalance = await bos.runRebalance({
    // take my sats from local heavy
    fromChannel: localChannel.public_key,
    // and move them to remote heavy
    toChannel: remoteChannel.public_key,
    maxSats: maxAmount,
    maxMinutes: MINUTES_FOR_REBALANCE,
    maxFeeRate
  }, false)

  // display successful rebalance cost
  if (!resBalance.failed && resBalance.fee_rate) {
    console.log(`${getDate()} rebalanced ${pretty(resBalance.rebalanced)} sats at ${resBalance.fee_rate} ppm!`)
  }

  // if rebalance worked on 1st try, record it, for now try lowering fee rate
  if (!resBalance.failed && isFirstRun) {
    const workedRate = resBalance.fee_rate
    const oldFeeRate = remoteChannel.my_fee_rate
    const peerFeeRate = remoteChannel.inbound_fee_rate
    const newFeeRate = Math.trunc(Math.max(
      // absolute smallest ppm for remote heavy channel
      MIN_PPM_FOR_REMOTE_HEAVY,
      // never go lower than peer fee rate for remote heavy channel
      peerFeeRate * SAFETY_MARGIN * SAFETY_MARGIN,
      // adjust slightly towards working ppm
      oldFeeRate * (1 - NUDGE) + workedRate * SAFETY_MARGIN * NUDGE,
      // don't change more than this rate total
      oldFeeRate / SAFETY_MARGIN
    ))

    // console.log(`${getDate()} Reducing fee to remote-heavy "${remoteChannel.alias}" (ppm): was ${oldFeeRate}, worked ${workedRate}, adjusted: ${newFeeRate}`)
    if (newFeeRate < oldFeeRate) {
      // const resSetFee = await bos.setFees(remoteChannel.public_key, newFeeRate)
      // console.log(`${getDate()} Set ${resSetFee} ppm fee to "${remoteChannel.alias}"`)
    }

    // record rebalance cost
    /*
    appendRecord({
      peer: remoteChannel,
      newRebalance: {
        t: Date.now(),
        ppm: resBalance.fee_rate,
        failed: false,
        peer: localChannel.public_key
      }
    })
    */

  }

  // if rebalance possible but needs higher rate
  if (resBalance.failed && isFirstRun && resBalance.msg[1] === 'RebalanceFeeRateTooHigh') {
    const oldFeeRate = remoteChannel.my_fee_rate
    const suggestedFeeRate = +resBalance.msg[2]?.needed_max_fee_rate || oldFeeRate
    const newFeeRate = Math.min(
      // nudge fee rate towards suggested fee rate
      Math.trunc(oldFeeRate * (1 - NUDGE) + suggestedFeeRate * SAFETY_MARGIN * NUDGE) + 1,
      // keep adjustment below max rate overall
      // Math.trunc(oldFeeRate * SAFETY_MARGIN) + 1,
      // keep below max reasonable ppm
      MAX_PPM_ABSOLUTE
    )

    console.log(`${getDate()} Increasing fee to remote-heavy "${remoteChannel.alias}" (ppm): was ${oldFeeRate}, suggested ${suggestedFeeRate}, adjusted: ${newFeeRate}`)
    if (newFeeRate > oldFeeRate) {
      const resSetFee = await bos.setFees(remoteChannel.public_key, newFeeRate)
      console.log(`${getDate()} Set ${resSetFee} ppm fee to "${remoteChannel.alias}"`)
    }

    // record suggested rate
    /*
    appendRecord({
      peer: remoteChannel,
      newRebalance: {
        t: Date.now(),
        ppm: suggestedFeeRate,
        failed: true,
        peer: localChannel.public_key
      }
    })
    */
  }

  return resBalance
}

// check if it's time to bos reconnect & do if so
const runBotReconnect = async () => {
  const lastReconnectLogPath = 'lastReconnectLog.json'
  const now = Date.now()
  let lastReconnect = 0
  try {
    const data = JSON.parse(fs.readFileSync(lastReconnectLogPath))
    lastReconnect = data.lastReconnect
  } catch (e) {
    console.log(`${getDate()} runBotReconnect() found no ${lastReconnectLogPath}`)
  }

  const isTimeForReconnect = now - lastReconnect > 1000 * 60 * 60 * HOURS_BETWEEN_RECONNECTS

  console.log(
    `${getDate()} ${isTimeForReconnect ? 'Time to run' : 'Skipping'} bos reconnect.` +
    ` Last run: ${lastReconnect === 0 ? 'never' : getDate(lastReconnect)}`
    )

  if (isTimeForReconnect) {
    await bos.runReconnect(true)
    fs.writeFileSync(lastReconnectLogPath, JSON.stringify({lastReconnect: now}, null, 2))
    console.log(`${getDate()} Updated ${lastReconnectLogPath}`)
  }
}

const initialize = async () => {
  // one time data backup

  // on-chain channel info
  const getChannels = await bos.callAPI('getChannels')
  fs.writeFileSync('channels.json', JSON.stringify(getChannels, null, 2))

  const getFeeRates = await bos.callAPI('getFeeRates')
  fs.writeFileSync('feeRates.json', JSON.stringify(getFeeRates, null, 2))

  // start bot loop
  runBot()
}

const runBot = async () => {

  // try a rebalance
  await runBotUpdateStep()

  // check if time for bos reconnect
  await runBotReconnect()

  // pause
  console.log(`\n${getDate()} ${MINUTES_BETWEEN_STEPS} minutes pause\n`)
  await new Promise(r => setTimeout(r, Math.trunc(MINUTES_BETWEEN_STEPS * 60 * 1000)))

  // restart
  runBot()
}

initialize()

// ------------- helpers ---------------

const pretty = (n) => String(n).replace(/\B(?=(\d{3})+\b)/g, "_")

// keep peers separate to avoid rewriting entirety of data at once on ssd alias, public_key
const appendRecord = ({peer, newRebalance = {}}, path = './peers') => {
  // filename uses 10 first digits of pubkey hex
  const fullPath = path + '/' + peer.public_key.slice(0, 10) + '.json'

  // make folder if necessary
  if (!fs.existsSync(path)) {
    fs.mkdirSync(path, { recursive: true })
  }

  // read from old file if exists
  let oldData = {}
  try {
    oldData = JSON.parse(fs.readFileSync(fullPath))
  } catch(e) {
    console.log(`${getDate()} no previous ${fullPath} record detected`)
  }

  // combine with new datapoint
  const combinedData = [
    ...(oldData?.rebalance || []),
    newRebalance
  ]

  // calculate median ppm
  const ppmMedian = median(combinedData.map(d => d.ppm))

  // remove old data in future

  // update just this peers file
  fs.writeFileSync(fullPath, JSON.stringify({
    alias: peer.alias,
    public_key: peer.public_key,
    ppmMedian,
    rebalance: combinedData
  }, null, 2))

  console.log(`${getDate()} ${fullPath} "${peer.alias}" updated, ${combinedData.length} records, median fee ${ppmMedian} ppm`)
}

// returns mean, truncated fractions
const median = (numbers) => {
  const sorted = numbers.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
      return Math.trunc((sorted[middle - 1] + sorted[middle]) / 2.0);
  }

  return Math.trunc(sorted[middle]);
}

const getDate = timestamp => (timestamp ? new Date(timestamp) : new Date()).toISOString()

// not used
const changeBaseFee = async (base_fee_mtokens = "400") => {
  // on-chain channel info
  // const getChannels = await bos.callAPI('getChannels')
  // fs.writeFileSync('channels.json', JSON.stringify(getChannels, null, 2))

  // off-chain channel fee info
  const getFeeRates = await bos.callAPI('getFeeRates')
  fs.writeFileSync('feeRates.json', JSON.stringify(getFeeRates, null, 2))

  // update routing fees
  for (const channel of getFeeRates.channels) {
    if (channel.base_fee_mtokens === "400") continue

    console.log('changing', channel)
    // have to specify everything or it will set idiotic default values
    const res = await bos.callAPI('updateRoutingFees', {
      transaction_id: channel.transaction_id, // this channel only
      transaction_vout: channel.transaction_vout, // this channel only
      base_fee_mtokens: base_fee_mtokens, // this is set
      fee_rate: channel.fee_rate // what units is this read in and set in? defaults to 1ppm if not specified...
    })
    await new Promise(r => setTimeout(r, Math.trunc(1 * 1000))) // 1 sec
  }

  // just sets ppm, no base fee adjustment, safer command
  // const setFee = await bos.setFees(peerPubKey, 222)
}
