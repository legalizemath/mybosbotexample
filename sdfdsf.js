// for providing examples only, don't run without understanding
sdfsdfs_NOT_SAFE_TO_RUN_dsfsdfsdf

import fs from 'fs' // comes with nodejs, to read/write log files
import dns from 'dns' // comes with nodejs, to check if there's internet access
// import os from 'os' // comes with nodejs, system stuff like memory checks

// my scripts
import bos from './bos.js' // my wrapper for bos, needs to be in same folder
import htlcLimiter from './htlcLimiter.js' // can limit number of htlcs per channel
import getBattery from './getBattery.js' // measure battery

const { min, max, trunc, floor, abs, random, log2, pow, ceil, exp, PI } = Math // useful Math
const copy = item => JSON.parse(JSON.stringify(item)) // copy values to new item, useful

// let it adjust fees and max htlc sizes and updating peer records (just simulates visually otherwise)
const ADJUST_POLICIES = true
// let it run bos.reconnect() at all (tries to wake up some disabled channels by disconnecting them)
const ALLOW_BOS_RECONNECT = true
// try simple reconnecting to inactive or offline peers (safer to run frequently)
const ALLOW_SIMPLE_RECONNECT = true
// let it rebalance (just simulates visually otherwise)
const ALLOW_REBALANCING = true
// let it request resetting node from another process to fix connections (by creating a file for resetHandler.js to see)
const ALLOW_NODE_RESET = true
// let it actively limit number of htlcs per channel
const ALLOW_HTLC_LIMITER = true
// if battery below 50%, request node shutdown (by creating a file for resetHandler.js to see)
const ALLOW_NODE_SHUTDOWN_ON_LOW_BATTERY = true
// backup payments in jsons & then remove from database for speed
const ALLOW_DB_CLEANUP = true
// restart node every day (requires ALLOW_NODE_RESET and resetHandler running)
const ALLOW_DAILY_RESET = true
// shut down on system memory leak found (WIP), shell command: free | grep Mem | awk '{print $3/$2 * 100.0}
// const ALLOW_SHUTDOWN_ON_LOW_RAM = false

// time to sleep between trying a bot cycle of above operations
const MINUTES_BETWEEN_STEPS = 21

// print out acceptance/rejection of htlc requests
const SHOW_HTLC_REQUESTS = false

// memory handling
const SHOW_RAM_USAGE = true
// shut down node if free memory on system falls below this treshhold for any reason
// const LOW_RAM_TRESHHOLD_MB = 100

// within what UTC hour to reset node (0-23h) if ALLOW_DAILY_RESET
const UTC_HOUR_FOR_RESTART = 6

// how often to move payments from db to backup logs
const DAYS_BETWEEN_DB_CLEANING = 3

// rebalance with faster keysends after bos rebalance works
// (faster but higher risk of stuck sats so I send less)
const USE_KEYSENDS_AFTER_BALANCE = true
// only use keysends (makes above irrelevant)
const ONLY_USE_KEYSENDS = false

// show rebalancing printouts (very wordy routing info)
const SHOW_REBALANCE_LOG = false

// suspect might cause tor issues if too much bandwidth being used
// setting to 1 makes it try just 1 rebalance at a time
const MAX_PARALLEL_REBALANCES = 5

// how far back to look for routing stats, must be longer than any other DAYS setting
const DAYS_FOR_STATS = 7

// hours between running bos reconnect (does some disable-based reconnections)
const MINUTES_BETWEEN_RECONNECTS = 21.69 * 60 // offset from 24 hours to shift around when
// hours between running basic offline/inactive reconnect
const MINUTES_BETWEEN_SIMPLE_RECONNECTS = 69

// minimum sats away from 0.5 balance to consider off-balance
const MIN_SATS_OFF_BALANCE = 420e3
// unbalanced sats below this can stop (bos rebalance requires >50k)
const MIN_REBALANCE_SATS = 69e3
// smallest amount of sats necessary to consider a side not drained
const MIN_SATS_PER_SIDE = 1e6
// local sats below this means channel is drained
const SATS_PER_SIDE_DRAINED_LIMIT = MIN_SATS_PER_SIDE * 0.25

// wait at least _ minutes for node to finish restarting before checking again
// has to include recompacting time if used!!!
const MIN_WAIT_MINUTES_FOR_NODE_RESTART = 21
// array of public key strings to avoid in paths (avoids from settings.json added to it)
const AVOID_LIST = []

// limit of sats to balance per attempt
// larger = faster rebalances, less for channels.db to store
// smaller = can use smaller liquidity/channels for cheaper/easier rebalances
// bos rebalance does probing + size up htlc strategy
// (bos rebalance requires >50k)
const MAX_REBALANCE_SATS = 212121 * 2
// sats to balance via keysends
const MAX_REBALANCE_SATS_KEYSEND = 212121 * 2
// fuzzy the amount being rebalanced to blend in better
const fuzzyAmount = (amount, fraction = 0.21) => trunc(amount * (1 - fraction * random()))

// would average in earned/routed out fee rate measured in DAYS_FOR_STATS
// to determine what fee rate to use for rebalance
const INCLUDE_EARNED_FEE_RATE_FOR_REBALANCE = true

// channels smaller than this not necessary to balance or adjust fees for
// usually special cases anyway
// (maybe use proportional fee policy for them instead)
// >2m for now
const MIN_CHAN_SIZE = MIN_SATS_OFF_BALANCE * 2 + MIN_SATS_PER_SIDE * 2 // 2.1e6

// multiplier for proportional safety ppm margin
const SAFETY_MARGIN = 1.12345 // 1.618 //
// maximum flat safety ppm margin (proportional below this value)
const SAFETY_MARGIN_FLAT_MAX = 222 // 272 //

// how often to update fees and max htlc sizes (keep high to minimize network gossip)
// also time span of flow to look back at for deciding if and by how much to increase each fee rate
const MINUTES_BETWEEN_FEE_CHANGES = 212
// max size of fee adjustment upward
const NUDGE_UP = 0.069
// max size of fee adjustment downward
const NUDGE_DOWN = 0.0021
// how much ppm has to change by to warrant risking htlc fails by updating fee
const FEE_CHANGE_TOLERANCE = 0.01

// min days of no routing activity before allowing reduction in fees
const DAYS_FOR_FEE_REDUCTION = 0.25

// minimum ppm ever possible for a fee policy setting
const MIN_PPM_ABSOLUTE = 0
// max ppm ever possible for fee policy setting
const MAX_PPM_ABSOLUTE = 4999

// rebalancing fee rates below this aren't considered for rebalancing
const MIN_FEE_RATE_FOR_REBALANCE = 21
// max fee rate for rebalancing even if channel earns more
const MAX_FEE_RATE_FOR_REBALANCE = 1500
// fee rate to stop forwards out of drained channel
const ROUTING_STOPPING_FEE_RATE = 1337

// max minutes to spend per rebalance try
const MINUTES_FOR_REBALANCE = 6
// max minutes to spend per keysend try
const MINUTES_FOR_KEYSEND = 5

// number of times to retry a rebalance on probe timeout while
// increasing fee for last hop to skip all depleted channels
// Only applies on specifically ProbeTimeout so unsearched routes remain
const RETRIES_ON_TIMEOUTS_REBALANCE = 2
const RETRIES_ON_TIMEOUTS_SEND = 1

// time between retrying same good pair
const MIN_MINUTES_BETWEEN_SAME_PAIR = (MINUTES_BETWEEN_STEPS + MINUTES_FOR_REBALANCE) * 2
// max rebalance repeats while successful
// if realized rebalance rate is > 1/2 max rebalance rate
// this will just limit repeats when there's no major discounts
const MAX_REBALANCE_REPEATS = 10 // without major discount
const MAX_REBALANCE_REPEATS_ANY = 21 // with even discounts

// ms to put between each rebalance launch for safety
const STAGGERED_LAUNCH_MS = 1111

// as 0-profit fee rate increases, fee rate where where proportional
// fee takes over flat one is
// (break even fee rate) * SAFETY_MARGIN = SAFETY_MARGIN_FLAT_MAX

// how much error to use for balance calcs
// const BALANCE_DEV = 0.1

// weight multiplier for rebalancing rates that were actually used vs suggested
// const WORKED_WEIGHT = 5
// min sample size before using rebalancing ppm rates for anything
// const MIN_SAMPLE_SIZE = 3

// fraction of peers that need to be offline to restart tor service
const PEERS_OFFLINE_PERCENT_MAXIMUM = 11
const INCLUDE_RECONNECTED_IN_OFFLINE = false

// show everything
const VERBOSE = true
const DEBUG = true

// what to weight random selection by
const WEIGHT_OPTIONS = {}
// WEIGHT_OPTIONS.FLAT = () => 1 // no preferences, totally random
// 2x more sats from balance is 2x more likely to be selected
// WEIGHT_OPTIONS.UNBALANCED_SATS = peer => peer.unbalancedSats
// 2x more sats from balance is ~1.4x more likely to be selected
// better for trying more channel combinations still favoring unabalanced
// WEIGHT_OPTIONS.UNBALANCED_SATS_SQRT = peer => trunc(sqrt(peer.unbalancedSats))
// WEIGHT_OPTIONS.UNBALANCED_SATS_SQRTSQRT = peer => trunc(sqrt(sqrt(peer.unbalancedSats)))
// WEIGHT_OPTIONS.CHANNEL_SIZE = peer => peer.totalSats

// ensure highest priority if below MIN_SATS_PER_SIDE on any side and decay to 0 when balanced
// prettier-ignore
WEIGHT_OPTIONS.MIN_LIQUIDITY = peer =>
  1 - exp(-2 * pow(PI, 2) * pow((peer.outbound_liquidity - 0.5 * peer.capacity) / (peer.capacity - 2 * MIN_SATS_PER_SIDE), 2))
const WEIGHT = WEIGHT_OPTIONS.MIN_LIQUIDITY // default weight

// just to prioritize more profitable channels including fee rate in random sorting
// give highest priority to higher fee rates on scale 0 - 1
WEIGHT_OPTIONS.FEE_RATE = peer => 1 - exp((-2 * PI * peer.fee_rate) / MAX_FEE_RATE_FOR_REBALANCE)
// combine fee rate and liquidity functions just for remote sorting
const WEIGHT_REMOTE = peer => 0.5 * WEIGHT_OPTIONS.MIN_LIQUIDITY(peer) + 0.5 * WEIGHT_OPTIONS.FEE_RATE(peer)
// const WEIGHT_REMOTE = peer => WEIGHT_OPTIONS.MIN_LIQUIDITY(peer) * WEIGHT_OPTIONS.FEE_RATE(peer)

// experimental - fake small flowrate to be ready to expect
// const MIN_FLOWRATE_PER_DAY = 10000 // sats/day

const SNAPSHOTS_PATH = './snapshots'
const PEERS_LOG_PATH = './peers'
const LOG_FILES = './logs'
const TIMERS_PATH = 'timers.json'
const SETTINGS_PATH = 'settings.json'
const LAST_SEEN_PATH = `${LOG_FILES}/lastSeen.json`

const DEFAULT_TIMERS = {
  lastReconnect: 0,
  lastSimpleReconnect: 0,
  lastFeeUpdate: 0,
  lastCleaningUpdate: 0,
  lastDailyReset: 0,
  lastNodeReset: 0
}

// global node info
const mynode = {
  scriptStarted: Date.now(),
  public_key: '',
  restartFailures: 0,
  offlineLimitPercentage: PEERS_OFFLINE_PERCENT_MAXIMUM,
  peers: [],
  htlcLimiter: {},
  timers: copy(DEFAULT_TIMERS)
}

const runBot = async () => {
  logDim('runBot()')

  // clean up memory if gc exposed with --expose-gc
  global?.gc?.()
  printMemoryUsage('(at start of runBot cycle)')

  // check battery
  await checkBattery()
  await sleep(5 * seconds)

  // check if need to restart node
  await runNodeRestartCheck()
  await sleep(5 * seconds)

  // check if time for bos reconnect
  await runBotReconnectCheck()
  await sleep(5 * seconds)

  // check if time for updating fees
  await runUpdateFeesCheck()
  await sleep(5 * seconds)

  // runCleaningCheck
  await runCleaningCheck()
  await sleep(5 * seconds)

  // simple reconnect
  await runSimpleReconnect()
  await sleep(5 * 1000)

  // do rebalancing
  await runBotRebalanceOrganizer()
  // await sleep(5 * 1000)

  // long pause
  await sleep(MINUTES_BETWEEN_STEPS * minutes)

  // restart
  runBot()
}

// my own reconnect method that doesn't disconnect channels based on just disables
// so can run frequently without risking instability
const runSimpleReconnect = async () => {
  if (!ALLOW_SIMPLE_RECONNECT) return null
  const minutesSinceLast = minutesAgo(mynode.timers.lastSimpleReconnect || 0)
  if (minutesSinceLast > MINUTES_BETWEEN_SIMPLE_RECONNECTS) {
    logDim('runSimpleReconnect(): time to run')
    updateBotTimers({ lastSimpleReconnect: Date.now() })
  } else {
    const timeUntil = (MINUTES_BETWEEN_SIMPLE_RECONNECTS - minutesSinceLast).toFixed(0)
    logDim(`runSimpleReconnect(): not time to run yet. (Scheduled in ${timeUntil}+ minutes)`)
    return null
  }

  // key to alias table
  const pkToAlias = await bos.getPublicKeyToAliasTable()

  // get offline peers pubkeys
  const peers = await bos.peers({})
  const peersTotal = peers?.length
  const offline = peers?.filter(p => p.is_offline).map(p => p.public_key) || []

  // get inactive peers pubkeys
  const channels = (await bos.callAPI('getChannels'))?.channels || []
  const inactive = unique(channels.filter(c => !c.is_active).map(c => c.partner_public_key))

  // combine offline and inactive list
  const listToReconnect = unique([...offline, ...inactive])
  const finalReconnected = []
  const finalOffline = []

  // reconnnect each one
  const reconnectionTasks = []
  for (const public_key of listToReconnect) {
    const reconnection = bos.addPeer({ public_key }).then(res => {
      if (res) {
        finalReconnected.push(public_key)
        logDim(`Reconnected to ${pkToAlias[public_key] || public_key.slice(0, 20)}`)
      } else {
        finalOffline.push(public_key)
        logDim(`Failed to reconnect to ${pkToAlias[public_key] || public_key.slice(0, 20)}`)
      }
    })
    reconnectionTasks.push(reconnection)
    // launch in parallel but space apart starting reconnects by few seconds
    const STAGGERED_RECONNECTS_MS = 7 * seconds
    await sleep(STAGGERED_RECONNECTS_MS, { quiet: true })
  }

  // wait until all the reconnection tasks are complete
  await Promise.all(reconnectionTasks)

  // make a nice summary of results
  const lastSeen = fs.existsSync(LAST_SEEN_PATH) ? JSON.parse(fs.readFileSync(LAST_SEEN_PATH)) : {}
  const peersDisabledToMe = peers.filter(p => p.is_inbound_disabled).map(p => p.public_key)

  // sort by offline time
  finalOffline.sort((a, b) => (lastSeen[a] || 0) - (lastSeen[b] || 0))
  const offlinePeerInfoList = []
  for (const public_key of finalOffline) {
    const alias = ca(pkToAlias[public_key]) || public_key.slice(0, 20)
    const { countPeers, countDisabled } = await getPeersDisabledTowards({ public_key })
    const percent = countPeers ? ((countDisabled / countPeers) * 100).toFixed(0) + '%' : ''
    const daysOffline = lastSeen[public_key] ? daysAgo(lastSeen[public_key]).toFixed(1) + 'd' : ''
    const isReallyOffline = daysOffline > 1 || (countPeers && countDisabled / countPeers > 0.33)
    const icon = isReallyOffline ? '🚫' : '🕑'
    offlinePeerInfoList.push(`${alias} ${icon} ${percent} ${daysOffline}`)
  }
  const offlinePeerInfo = offlinePeerInfoList.join('\n ') || 'n/a'

  const message =
    peers !== null
      ? `🔍 Simple reconnect done (every ${MINUTES_BETWEEN_SIMPLE_RECONNECTS} minutes).\n\n` +
        // give overall statistics on offline
        `<b>Offline peers</b>: ${finalOffline.length}/${peersTotal}` +
        ` (${((finalOffline.length / peersTotal) * 100).toFixed(0)}%)\n\n` +
        // write out offline peers
        ` ${offlinePeerInfo}\n\n` +
        // write out overall statistics on reconnected
        `<b>Reconnected peers</b>: ${finalReconnected.length}/${peersTotal}` +
        ` (${((finalReconnected.length / peersTotal) * 100).toFixed(0)}%)\n\n` +
        // write out reconnected peers
        ` ${finalReconnected.map(pk => ca(pkToAlias[pk]) || pk.slice(0, 20)).join(', ') || 'n/a'}\n\n` +
        `<b>Disabled-towards-me peers</b>: ${peersDisabledToMe.length}/${peersTotal}` +
        ` (${((peersDisabledToMe.length / peersTotal) * 100).toFixed(0)}%)\n\n` +
        // write out peers that disabled towards me
        ` ${peersDisabledToMe.map(pk => ca(pkToAlias[pk]) || pk.slice(0, 20)).join(', ') || 'n/a'}\n`
      : 'bos/lnd issue detected'

  // update user about offline peers just in case
  console.log(`${getDate()} ${message.replaceAll(/<\/?.>/g, '')}`)
  await telegramLog(message)
}

// starts everything
const initialize = async () => {
  // get authorized access to node
  await bos.initializeAuth()

  // get your own public key
  const identity = await bos.callAPI('getIdentity')
  if (!identity.public_key || identity.public_key.length < 10) {
    console.log()
    throw new Error('unknown public key for this node')
  }
  mynode.public_key = identity.public_key

  const feeUpdatesPerDay = +((60 * 24) / MINUTES_BETWEEN_FEE_CHANGES).toFixed(1)

  const feeRateInceaseString = (NUDGE_UP * 100).toFixed(2)
  const feeRateDecreaseString = (NUDGE_DOWN * 100).toFixed(2)
  const feeRateToleranceString = (FEE_CHANGE_TOLERANCE * 100).toFixed(0)

  const maxUpFeeChangePerDay = ((1 + NUDGE_UP) ** feeUpdatesPerDay - 1) * 100
  const maxDownFeeChangePerDay = (1 - (1 - NUDGE_DOWN) ** feeUpdatesPerDay) * 100

  const hoursBetweenFeeChanges = (MINUTES_BETWEEN_FEE_CHANGES / 60).toFixed(1)

  // roughly how many decreases to equal to an increase
  const decreasesToUndo = ceil(NUDGE_UP / NUDGE_DOWN)
  // how much time is that including 2 periods before decreases are allowed
  const minutesToUndo = (decreasesToUndo + 2) * MINUTES_BETWEEN_FEE_CHANGES
  const daysToUndoString = (minutesToUndo / 60 / 24).toFixed(1)

  console.log(`${getDate()}
  ========================================================

    this node's public key:

      "${mynode.public_key}"

    There are a maximum of ${feeUpdatesPerDay} fee updates per day.

    UP: Channel fee rate set-point increases by max of +${feeRateInceaseString}%
      every ${hoursBetweenFeeChanges} hours or more
      with higher if its outflow at that rate is closer to local sats per day.

      (At constant high outflow absolute max is +${maxUpFeeChangePerDay.toFixed(1)}% / day.)

    DOWN: Fee rate set-point decreases by max of -${feeRateDecreaseString}%
      every ${hoursBetweenFeeChanges} hours or more
      if no outflow took place in at least 2x as long of time.

      Channel must also have more than ${pretty(MIN_SATS_PER_SIDE)} sats local
        to allow decrease fee rate or outflow numbers are unreliable.

      At continous 0 outflow, max decrease per day is -${maxDownFeeChangePerDay.toFixed(1)}%.

    One high increase in fee rate takes ${daysToUndoString} days to undo with decreases.

    Actual fee rate in policy is only updated when set-point is more
      than ${feeRateToleranceString}% away from current policy fee rate.

    If channel has under ${pretty(SATS_PER_SIDE_DRAINED_LIMIT)} sats local
      it's also considered drained and policy fee rate is temporarily increased
      to ${ROUTING_STOPPING_FEE_RATE} ppm to discorage additional routing.


    IF THIS IS INCORRECT, ctrl + c

  ========================================================
  `)

  // small pause for friendly stop
  await sleep(5 * seconds)

  // make folders for all the files I use
  if (!fs.existsSync(PEERS_LOG_PATH)) {
    fs.mkdirSync(PEERS_LOG_PATH, { recursive: true })
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

    // add to avoid list from there
    if (mynode.settings?.avoid?.length) {
      mynode.settings.avoid.forEach(pk => {
        if (!pk.startsWith('//')) AVOID_LIST.push(pk)
      })
      console.log(`${getDate()}`, { AVOID_LIST })
    }
  }

  // timers
  initializeBotTimers()

  // generate snapshots at start to ensure recent data
  await generatePeersSnapshots()

  // small pause for friendly stop
  await sleep(5 * seconds)

  // initialize forwarding request limiter if used
  if (ALLOW_HTLC_LIMITER) mynode.htlcLimiter = htlcLimiter(SHOW_HTLC_REQUESTS)

  // start bot loop
  runBot()
}

// restart node if requested
const runNodeRestartCheck = async () => {
  if (!(ALLOW_DAILY_RESET && ALLOW_NODE_RESET)) return null

  logDim('runNodeRestartCheck()')

  const now = Date.now()
  const timers = mynode.timers
  const thisHour = new Date(now).getUTCHours()

  // check if right hour
  const isRightHour = UTC_HOUR_FOR_RESTART === thisHour

  // check if at least 6 hours since last daily reset or since last reset from other sources
  const HOURS_DELTA = 4
  const hoursSinceDailyReset = (now - timers.lastDailyReset) / hours
  const hoursSinceReset = (now - timers.lastNodeReset) / hours
  const beenLongEnough = hoursSinceDailyReset > HOURS_DELTA && hoursSinceReset > HOURS_DELTA // just in case, checking both

  const isReseting = isRightHour && beenLongEnough

  // prettier-ignore
  logDim(`runNodeRestartCheck() ${isRightHour && beenLongEnough ? 'reseting node processes' : 'not right time'}
    ${thisHour} UTC hour ${isRightHour ? 'matches' : 'is not'} the specified ${UTC_HOUR_FOR_RESTART} UTC hour for timed node reset.
    It has been ${hoursSinceReset > 24 * 2 ? 'over 2 days' : hoursSinceReset.toFixed(1) + ' hours'} since last known reset.
    It has been ${hoursSinceDailyReset > 24 * 2 ? 'over 2 days' : hoursSinceDailyReset.toFixed(1) + ' hours'} since last daily reset.
    Both must be more than ${HOURS_DELTA} hours to reset again.
  `)

  if (!isReseting) return null

  // seems time to restart node
  logDim('runNodeRestartCheck() - right hour and been long enough so restarting node processes')

  // update timers
  updateBotTimers({ lastDailyReset: now })

  await restartNodeProcess()

  // run reconnect script to ensure everything is ready again
  await runBotReconnect()
}

const initializeBotTimers = () => {
  if (!fs.existsSync(TIMERS_PATH)) {
    // if no timer file, just generate timers file to keep track between runs
    console.log(`${getDate()} creating timers file at ${TIMERS_PATH}`)
  } else {
    // if timer file exists, overwrite defaults with whatever is available in file
    try {
      const timersOnFile = JSON.parse(fs.readFileSync(TIMERS_PATH))
      mynode.timers = { ...mynode.timers, ...(timersOnFile ?? {}) }
      console.log(`${getDate()} found & updating timers file at ${TIMERS_PATH}`)
    } catch (e) {
      console.log(`${getDate()} timers file unreadable, writing to ${TIMERS_PATH}`)
    }
  }
  console.log(
    `${getDate()} current UTC timestamps: ${JSON.stringify(
      Object.keys(mynode.timers).map(timerName => `${timerName.padStart(20)}: ${getDate(mynode.timers[timerName])}`),
      null,
      2
    )}`
  )
  fs.writeFileSync(TIMERS_PATH, JSON.stringify(mynode.timers))
}

// setting/updating both bot global and written to file timers with newItems object item(s)
// getting is just mynode.timers as its updated from defaults+file during start up and w/ updates
const updateBotTimers = newItems => {
  mynode.timers = {
    ...mynode.timers,
    ...newItems
  }
  console.log(`${getDate()} Updated ${TIMERS_PATH}`)
  fs.writeFileSync(TIMERS_PATH, JSON.stringify(mynode.timers))
}

// carefully shut down node if low on battery
const checkBattery = async () => {
  if (!ALLOW_NODE_SHUTDOWN_ON_LOW_BATTERY) return null

  const battery = await getBattery()
  logDim(`checkBattery(): ${battery + '%' || 'n/a'}`)

  if (battery && +battery < 50) {
    console.log(`${getDate()} checkBattery(): battery below 50%`)

    // check internet connection
    const isInternetConnected = await dns.promises
      .lookup('google.com')
      .then(() => true)
      .catch(() => false)

    if (isInternetConnected && ALLOW_HTLC_LIMITER) {
      // if internet still connected can wait a little for existing forwards to clear
      console.log(`${getDate()} checkBattery(): requesting blocking of all new forward requests`)

      // if HTLClimiter used, should signal it to reject all NEW forward requests until node is down
      mynode.htlcLimiter.stop = true

      // giving it 2 min to clear old htlcs
      await sleep(2 * minutes)
    }

    console.log(`${getDate()} checkBattery(): requesting node shut down`)

    // now signaling node shut down, picked up by resetHandler.js
    const requestTime = Date.now()
    const SHUTDOWN_REQUEST_PATH = 'shutdownRequest.json'
    fs.writeFileSync(SHUTDOWN_REQUEST_PATH, JSON.stringify({ requestTime }))

    // giving lightning node 5 min to shut down
    await sleep(5 * minutes)

    // exit this bot
    console.log(`${getDate()} checkBattery(): terminating bot processes`)
    process.exit(0)
  }
}

// experimental parallel rebalancing function (unsplit, wip)
const runBotRebalanceOrganizer = async () => {
  logDim('runBotRebalanceOrganizer()')
  // match up peers
  // high weight lets channels get to pick good peers first (not always to occasionally search for better matches)

  // get active peers
  const peers = await runBotGetPeers()
  // make a list of remote heavy and local heavy peers via balance check
  const remoteHeavyPeers = rndWeightedSort(
    peers.filter(includeForRemoteHeavyRebalance),
    // this one includes fee rate in weight so more profitable channels more likely to be tried more often
    WEIGHT_REMOTE
  )
  const localHeavyPeers = rndWeightedSort(peers.filter(includeForLocalHeavyRebalance), WEIGHT)
  // grab original number of peers for each side
  const [nRHP, nLHP] = [remoteHeavyPeers.length, localHeavyPeers.length]

  /*
  // print out all options of peers & their weight
  if (VERBOSE) {
    console.log(`${getDate()} Peer weight / balance / alias.   Weight function: ${WEIGHT}`)
    for (const p of localHeavyPeers) {
      const weight = WEIGHT(p).toFixed(5)
      const w = weight.padStart(13)
      const b = p.balance.toFixed(2)
      const local = (p.outbound_liquidity / 1e6).toFixed(1).padStart(4) + 'M'
      const remote = (p.inbound_liquidity / 1e6).toFixed(1).padStart(4) + 'M'
      console.log(`Local-heavy: ${ca(p.alias).padEnd(30)} ${w}w  ${b}b ${local}|${remote}`)
    }
    console.log('')
    for (const p of remoteHeavyPeers) {
      const weight = WEIGHT(p).toFixed(5)
      const w = weight.padStart(12)
      const b = p.balance.toFixed(2)
      const local = (p.outbound_liquidity / 1e6).toFixed(1).padStart(4) + 'M'
      const remote = (p.inbound_liquidity / 1e6).toFixed(1).padStart(4) + 'M'
      console.log(`Remote-heavy: ${ca(p.alias).padEnd(30)} ${w}w  ${b}b ${local}|${remote}`)
    }
    console.log('')
  }
  */

  // assemble list of matching peers and how much to rebalance
  const matchups = []

  // keep taking peers out of arrays to match until one side empty
  while (localHeavyPeers.length > 0 && remoteHeavyPeers.length > 0) {
    // get top lucky remote channel
    const remoteHeavy = remoteHeavyPeers[0]

    // try to see if there's good match in locals for this peer
    // just do it half the time to discover more
    const localHeavyIndexIdeal =
      random() < 0.5 ? findGoodPeerMatch({ remoteChannel: remoteHeavy, peerOptions: localHeavyPeers }) : -1
    // use localHeavyIndexIdeal if it returns an index, otherwise use top local channel
    const isGoodPeer = localHeavyIndexIdeal > -1
    const localHeavyIndexUsed = isGoodPeer ? localHeavyIndexIdeal : 0
    const localHeavy = localHeavyPeers[localHeavyIndexUsed]

    // max amount to rebalance is the smaller sats off-balance between the two
    const maxSatsToRebalance = trunc(min(localHeavy.unbalancedSats, remoteHeavy.unbalancedSats))

    // can also calculate fee rate used this week for routing instead of just current fee rate
    // round down fees to nearest sat to get rid of base fee
    const routedOut = remoteHeavy.routed_out_msats / 1000
    const earnedOut = remoteHeavy.routed_out_fees_msats / 1000
    // const capacity = remoteHeavy.capacity
    // const remoteSats = remoteHeavy.inbound_liquidity

    // grab my outgoing fee for remote heavy peer (from record if available)
    const rateNowOutgoing = trunc(getReferenceFee(remoteHeavy))
    // actual earning rate (how else to handle very small amounts giving incorrect fee rate?)
    const effectiveFeeRate = trunc((floor(earnedOut) / routedOut) * 1e6) || 0
    // near MIN_SATS_PER_SIDE routed out will use effective fee, otherwise channel setting
    const routedOutFactor = 1 - exp((-routedOut * PI) / MIN_SATS_PER_SIDE)
    // the more I route out the more reliable calculated fee rate is vs current channel fee rate
    const usedRefFeeRate = trunc(effectiveFeeRate * routedOutFactor + rateNowOutgoing * (1 - routedOutFactor) || 0)

    // start calculating rebalance rate
    const feeRateUsedForCalc = !INCLUDE_EARNED_FEE_RATE_FOR_REBALANCE
      ? rateNowOutgoing
      : min(rateNowOutgoing, usedRefFeeRate)

    // level of emergency decided by highest need of either channel 0-1
    const weightRemote = WEIGHT(remoteHeavy)
    const weightLocal = WEIGHT(localHeavy)
    const levelOfEmergency = max(weightRemote, weightLocal)
    // time dependence starts at 0 and ~1 after DAYS_FOR_STATS
    const channelsAgeRemote = min(...(remoteHeavy.ids?.map(c => c.channel_age_days || 0) || [0]))
    if (DEBUG && !remoteHeavy.ids) console.log('unknown channel ids on remote heavy peer', remoteHeavy)
    const timeFactor = 1 - exp((-PI * channelsAgeRemote) / DAYS_FOR_STATS)

    // fee via simple subtraction & division from reference
    const safeRateBaseline = subtractSafety(feeRateUsedForCalc)

    // new remoteHeavy channels can wait to be rebalanced
    const safeRateForAge = trunc(timeFactor * feeRateUsedForCalc)

    // low levels of emergency will try less hard
    // high level of emergency will go as high as subtractSafety allows
    // fee via weights from 0.5-1x of reference ppm
    const rateBasedOnEmergency = trunc((0.5 + 0.5 * levelOfEmergency) * feeRateUsedForCalc)

    // use smallest of 3 rebalance fee rate limits
    const safeRate = min(rateBasedOnEmergency, safeRateBaseline, safeRateForAge)

    // check against the absolute highest rebalance rate allowed
    const maxRebalanceRate = min(safeRate, MAX_FEE_RATE_FOR_REBALANCE)

    // console.log(remoteHeavy.alias, { effectiveFeeRate, rateNowOutgoing, maxRebalanceRate })

    // check if rebalance rate is below absolute min fee rate for rebalance allowed or below inbound fee rate
    if (maxRebalanceRate < MIN_FEE_RATE_FOR_REBALANCE || maxRebalanceRate < remoteHeavy.inbound_fee_rate) {
      remoteHeavyPeers.splice(0, 1) // drop remote-heavy peer from consideration
      continue // move onto next peer
    }

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
      isGoodPeer,
      rateNowOutgoing,
      usedRefFeeRate,
      effectiveFeeRate,
      routedOut,
      earnedOut,
      routedOutFactor,
      channelsAgeRemote,
      timeFactor,
      weightRemote,
      weightLocal,
      levelOfEmergency,
      rateBasedOnEmergency,
      safeRateBaseline,
      safeRate,
      safeRateForAge
    })

    // remove these peers from peer lists
    localHeavyPeers.splice(localHeavyIndexUsed, 1)
    remoteHeavyPeers.splice(0, 1)

    // stop if limit reached
    if (matchups.length >= MAX_PARALLEL_REBALANCES) break
  }

  if (VERBOSE) {
    console.log(
      `${getDate()} ${matchups.length} rebalance matchups from ${nRHP} remote-heavy & ${nLHP} local-heavy peers
      sorted with offbalance-weighted randomness of ${WEIGHT}
      ${dim}weighting factors: wL = local-offbalance, wR = remote-offbalance, wT = aged weight, wO = outflow weight${undim}
      ${dim}rebalance ppm's considered: eff = effective, safe = max safe, rush = offbalance emergency${undim}
      `
    )
    for (const match of matchups) {
      const outOf = ca(match.localHeavy.alias).padStart(30)
      const into = ca(match.remoteHeavy.alias).padEnd(30)
      const meAtLH = (match.localHeavy.outbound_liquidity / 1e6).toFixed(1).padStart(5) + 'M'
      const remAtLH = (match.localHeavy.inbound_liquidity / 1e6).toFixed(1).padStart(5) + 'M'
      const meAtRH = (match.remoteHeavy.outbound_liquidity / 1e6).toFixed(1).padStart(5) + 'M'
      const remAtRH = (match.remoteHeavy.inbound_liquidity / 1e6).toFixed(1).padStart(5) + 'M'

      // show ppm used for routing in channel regularly and not temporary high ppm used on very drained channels as former is used for rebalancing reference

      // const myFeeAtLH = `(${match.localHeavy.fee_rate})`.padStart(6)
      const myFeeAtLH = `(${getReferenceFee(match.localHeavy)})`.padStart(6)
      const remFeeAtLH = `(${match.localHeavy.inbound_fee_rate})`.padEnd(6)

      // const myFeeAtRH = `(${match.remoteHeavy.fee_rate})`.padEnd(6)
      const myFeeAtRH = `(${getReferenceFee(match.remoteHeavy)})`.padEnd(6)
      const remFeeAtRH = `(${match.remoteHeavy.inbound_fee_rate})`.padStart(6)

      const factorsUsed = [
        `${match.weightLocal.toFixed(1)}wL`,
        `${match.weightRemote.toFixed(1)}wR`,
        `${match.timeFactor.toFixed(1)}wT`, // `-${match.channelsAgeRemote}d`
        `${match.routedOutFactor.toFixed(1)}wO`,
        `${match.levelOfEmergency.toFixed(1)}wE`,
        `${match.usedRefFeeRate}eff`.padStart(7),
        `${match.safeRateBaseline}safe`.padStart(8),
        `${match.rateBasedOnEmergency}rush`.padStart(8)
      ].join(' ')

      const isGoodPeer = match.isGoodPeer ? '💚' : ''

      console.log(
        `  me☂️  ${dim}${myFeeAtLH} ${meAtLH} [ ||||-> ] ${remAtLH} ${remFeeAtLH}${undim} ${outOf} ${dim}--> ?` +
          ` -->${undim} ${into} ${dim}${remFeeAtRH} ${remAtRH} [ ||||-> ] ${meAtRH} ${myFeeAtRH}${undim}  me☂️   ` +
          `${dim}${factorsUsed}${undim} ${isGoodPeer}`
      )
    }
    console.log('')
  }

  // if not actually rebalancing we end here
  if (!ALLOW_REBALANCING) return null

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
      ? fuzzyAmount(min(maxSatsToRebalance, MAX_REBALANCE_SATS))
      : fuzzyAmount(min(maxSatsToRebalance, MAX_REBALANCE_SATS_KEYSEND))

    // task launch message
    console.log(
      `${getDate()} Starting ${localString} --> ${remoteString} run #${run}` +
        ` rebalance @ ${maxRebalanceRateString}, ${pretty(maxSatsToRebalance).padStart(10)} sats left to balance ` +
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
            avoid: copy(AVOID_LIST), // avoid these nodes in paths
            retryAvoidsOnTimeout: RETRIES_ON_TIMEOUTS_REBALANCE
          },
          undefined,
          // {} // no terminal output, too many things happening
          { details: SHOW_REBALANCE_LOG }
        )
      : await bos.send(
          {
            destination: mynode.public_key,
            fromChannel: localHeavy.public_key,
            toChannel: remoteHeavy.public_key,
            // add randomness to amt (downward only)
            sats: maxSatsToRebalanceAfterRules,
            maxMinutes: MINUTES_FOR_KEYSEND,
            maxFeeRate: maxRebalanceRate,
            retryAvoidsOnTimeout: RETRIES_ON_TIMEOUTS_SEND,
            avoid: copy(AVOID_LIST) // avoid these nodes in paths
          },
          // {} // no terminal output, too many things happening
          { details: SHOW_REBALANCE_LOG }
        )

    const taskLength = ((Date.now() - startedAt) / minutes).toFixed(1) + ' minutes'
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
        `${getDate()} Stopping ${localString} --> ${remoteString} run #${run} ${maxRebalanceRateString} ` +
          `rebalance failed ${reasonString}` +
          `${dim}(${tasksDone}/${matchups.length} done after ${taskLength})${undim}`
      )
      // fails are to be logged only when there's a useful suggested fee rate
      if (resBalance.ppmSuggested) {
        appendRecord({
          peer: remoteHeavy,
          newRebalance: {
            t: Date.now(),
            ppm: resBalance.ppmSuggested,
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
      if (matchedPair.maxSatsToRebalance < MIN_REBALANCE_SATS) {
        // successful & stopping - rebalanced "enough" as sats off-balance below minimum
        matchedPair.done = true
        const tasksDone = matchups.reduce((count, m) => (m.done ? count + 1 : count), 0)
        console.log(
          `${getDate()} Completed${localString} --> ${remoteString} at #${run} ${maxRebalanceRateString} ` +
            `rebalance done for ${pretty(rebalanced)} sats @ ${resBalance.fee_rate} ppm ${yays}` +
            ` & completed! 🍾🥂🏆 ${dim}(${tasksDone}/${matchups.length} done after ${taskLength})${undim}`
        )
        // return matchedPair
      } else if (
        // if reached max # of rebalances without a discount
        (run >= MAX_REBALANCE_REPEATS && discount < 2) ||
        // if reached max # of rebalances even with major discount
        run >= MAX_REBALANCE_REPEATS_ANY
      ) {
        // successful & stopping - at max repeats for minor discounts (< than 1/2 of attempted fee rate)
        matchedPair.done = true
        const tasksDone = matchups.reduce((count, m) => (m.done ? count + 1 : count), 0)
        console.log(
          `${getDate()} Completed${localString} --> ${remoteString} at #${run} ${maxRebalanceRateString} ` +
            `rebalance done for ${pretty(rebalanced)} sats @ ${resBalance.fee_rate} ppm ${yays}` +
            ` & reached max number of repeats. ${dim}(${tasksDone}/${matchups.length} done after ${taskLength})${undim}`
        )
        // return matchedPair
      } else {
        // successful & keep doing rebalances
        console.log(
          `${getDate()} Updating ${localString} --> ${remoteString} run #${run} ${maxRebalanceRateString} ` +
            `rebalance succeeded for ${pretty(rebalanced)} sats @ ${resBalance.fee_rate} ppm ${yays}` +
            ` & moving onto run #${run + 1} ${dim}(${taskLength})${undim}`
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
// needs optimization, right now just made to work
const findGoodPeerMatch = ({ remoteChannel, peerOptions }) => {
  // start a list of potential candidates
  const localCandidates = []
  const uniquePeers = {}

  // get historic info if available
  const logFileData = readRecord(remoteChannel.public_key)
  const remoteRealFeeRate = getReferenceFee(remoteChannel)

  // remove balancing attempts below basic useful ppm
  const balancingData = logFileData.rebalance?.filter(b => b.ppm < subtractSafety(remoteRealFeeRate)) || []

  // no past rebalance info for this remote heavy peer
  if (balancingData.length === 0) return -1

  // list made of just very recent (time wise) rebalances list to rule out very recent repeats
  // some results like timeout & no path between peers wont' show up in records
  const recentBalances = balancingData.filter(b => Date.now() - b.t < MIN_MINUTES_BETWEEN_SAME_PAIR * minutes)

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

  const winningCandidatePublicKey = localCandidates[trunc(random() * random() * localCandidates.length)]
  const winningOptionIndex = peerOptions.findIndex(p => p.public_key === winningCandidatePublicKey)

  // pick random peer, ones added at lower ppm or multiple times have more chance
  return winningOptionIndex
}

// gets peers info including using previous slow to generate snapshot data
// can use await generatePeersSnapshots() instead to get fully updated stats for _all_ peers
const runBotGetPeers = async ({ all = false } = {}) => {
  logDim('runBotGetPeers()')

  // use bos peers command to get objects describing each peer with alias and pubkey
  const getPeers = all
    ? await bos.peers({}) // all peers
    : await bos.peers() // active & public peers (default)

  if (getPeers === null) {
    // only happens in event of bos error like if lnd not running
    logDim('runBotGetPeers() got no response from bos peers')
    await runBotReconnect()
    sleep(60 * seconds)
    // retry again
    return await runBotGetPeers({ all })
  }

  // this local fee policy call updates fastest
  const myFeesArray = (await bos.callAPI('getFeeRates'))?.channels || []
  const myFeesById = myFeesArray.reduce((final, channel) => {
    final[channel.id] = channel
    return final
  }, {})
  const myFeesByPublicKey = {}
  const channels = (await bos.callAPI('getChannels'))?.channels || []
  channels.forEach(c => {
    if (myFeesById[c.id]?.fee_rate !== undefined) {
      // use highest fee rate
      myFeesByPublicKey[c.partner_public_key] = myFeesByPublicKey[c.partner_public_key]
        ? max(myFeesById[c.id]?.fee_rate, myFeesByPublicKey[c.partner_public_key])
        : myFeesById[c.id]?.fee_rate
    }
  })

  // add to default peer data
  const peers = getPeers
    .map(p => {
      p.fee_rate = myFeesByPublicKey[p.public_key] ?? null // null fee rate means not specified so don't rely on it
      // debugging instances where fee rate is unknown
      if (p.fee_rate === null) {
        console.log(
          `${getDate()} runBotGetPeers() Unknown outgoing fee rate for ${p.alias} ${p.public_key} so set to "null"`
        )
      }
      // add custom quick calculations
      p.inbound_fee_rate = +p.inbound_fee_rate || 0
      p.inbound_liquidity = +p.inbound_liquidity || 0
      p.outbound_liquidity = +p.outbound_liquidity || 0
      p.totalSats = p.inbound_liquidity + p.outbound_liquidity // no unsettled sats
      p.balance = +(p.outbound_liquidity / p.totalSats).toFixed(3)
      p.unbalancedSatsSigned = trunc(p.outbound_liquidity * 0.5 - p.inbound_liquidity * 0.5)
      p.unbalancedSats = abs(p.unbalancedSatsSigned)
      return p
    })
    // remove offline peers if not all to be shown
    .filter(p => all || !p.is_offline)
    // sort by local sats by default
    .sort((a, b) => b.outbound_liquidity - a.outbound_liquidity)

  // add any needed numbers calculated just last time snapshots were created.
  // Rarely changing details that are still needed should be fetched fast this way
  addDetailsFromSnapshot(peers)

  // return just peers we took detailed snapshot of before unless "all" are requested
  // that is typically from very new channels so including them will be missing data
  return peers.filter(p => all || !p.missing_details_pass)
}

// how many sats I need for balance vs how much I'll probably get in _ days
// + check info is reliable via more than 1 recent sample or 1 very recent sample
// + check this isn't an emergency shortage situation
const acceptableFlowToLocal = p =>
  // in time the fee needs to be reduced existing flow rate should fix it alone
  -p.unbalancedSatsSigned < ((p.routed_in_msats / DAYS_FOR_STATS / 1000) * DAYS_FOR_STATS) / 2 &&
  daysAgo(p.routed_in_last_at) < DAYS_FOR_STATS / 2 && // on recent side of time range
  !isVeryRemoteHeavy(p) && // not emergency shortage on local side (waiting is not an option)
  !isNetOutflowing(p) // neutral or flows to local

const acceptableFlowToRemote = p =>
  // in time the fee needs to be reduced existing flow rate should fix it alone
  p.unbalancedSatsSigned < ((p.routed_out_msats / DAYS_FOR_STATS / 1000) * DAYS_FOR_STATS) / 2 &&
  daysAgo(p.routed_out_last_at) < DAYS_FOR_STATS / 2 && // on recent side of time range
  !isVeryLocalHeavy(p) && // not emergency shortage on remote side (waiting is not an option)
  !isNetInflowing(p) // neutral or flows to remote

// allow these channels to be used as a remote heavy channel in a rebalance
const includeForRemoteHeavyRebalance = p =>
  // balance on remote side beyond min-off-balance or enough for max rebalance size
  isRemoteHeavy(p) &&
  // large enough channel
  p.totalSats >= MIN_CHAN_SIZE &&
  // enough sats to balance
  p.unbalancedSats > MIN_REBALANCE_SATS &&
  // only if no settings about it or if no setting for no remote-heavy rebalance true
  !getRuleFromSettings({ peer: p })?.no_remote_rebalance &&
  // fee is known: not null, not NaN, not undefined, and not 0 (too low anyway)
  getReferenceFee(p) &&
  // supposed rebalance fee unrealistically small
  subtractSafety(getReferenceFee(p)) > MIN_FEE_RATE_FOR_REBALANCE &&
  // rebalance fee (max) should be larger than incoming fee rate
  // or it's literally impossible since last hop costs more ppm already
  subtractSafety(getReferenceFee(p)) > p.inbound_fee_rate &&
  // insufficient existing flow to remote side recently
  !acceptableFlowToLocal(p) &&
  // can't rebalance if inbound is disabled
  !p.is_inbound_disabled &&
  // check against any user set avoid rules
  !AVOID_LIST.includes(p.public_key)

/*
// for testing what happened
const includeForRemoteHeavyRebalanceTest = p => {
  const checks = []
  checks.push(() => isRemoteHeavy(p))
  checks.push(() => p.totalSats >= MIN_CHAN_SIZE)
  checks.push(() => p.unbalancedSats > MIN_REBALANCE_SATS)
  checks.push(() => !getRuleFromSettings({ peer: p })?.no_remote_rebalance)
  checks.push(() => subtractSafety(p.fee_rate) > MIN_FEE_RATE_FOR_REBALANCE)
  checks.push(() => subtractSafety(p.fee_rate) > p.inbound_fee_rate)
  checks.push(() => !acceptableFlowToLocal(p))
  return checks
}
*/

// allow these channels to be used as a local heavy channel in a rebalance
const includeForLocalHeavyRebalance = p =>
  // balance on my side beyond min-off-balance or enough for max rebalance size
  isLocalHeavy(p) &&
  p.totalSats >= MIN_CHAN_SIZE &&
  p.unbalancedSats > MIN_REBALANCE_SATS &&
  // only if no settings about it or if no setting for no local-heavy rebalance true
  !getRuleFromSettings({ peer: p })?.no_local_rebalance &&
  // insufficient existing flow to local side recently
  !acceptableFlowToRemote(p) &&
  // no pending htlcs right now through this channel to avoid flooding my own channel
  // !p.is_forwarding &&
  // check against any user set avoid rules
  !AVOID_LIST.includes(p.public_key)

// check settings for rules matching as substring of this alias or publick key
const getRuleFromSettings = ({ peer }) => {
  const { alias, public_key } = peer
  // get rule
  const rules =
    // if we know what public key and a rule has a public key it will try to find a match
    mynode.settings?.rules?.find(r => public_key && r.public_key && public_key === r.public_key) ||
    // OR it will try to find a first match for aliasMatch, "" aliasMatch would always work
    mynode.settings?.rules?.find(
      r => alias && !(r.aliasMatch === undefined) && alias.toLowerCase().includes(r.aliasMatch.toLowerCase())
    )
  // remove notes (so can print out rules cleaner)
  if (rules) {
    Object.keys(rules).forEach(name => {
      if (name.includes('NOTE') || name.startsWith('//')) delete rules[name]
    })
  }
  return rules
}

// reconnection timer handling
const runBotReconnectCheck = async () => {
  const now = Date.now()
  const timers = mynode.timers

  // check if earlier reconnect is necessary

  // get list of all peers and active peers to check if enough are online
  const allPeers = await bos.peers({})
  if (!allPeers) {
    logDim('runBotReconnectCheck(): no valid response from bos peers, running runBotReconnect early')
    await runBotReconnect()
    return null
  }
  const offlinePeers = allPeers.filter(p => p.is_offline)

  // const allPeers = await runBotGetPeers({ all: true })
  // const peers = await runBotGetPeers()

  // check if too many peers are offline
  logDim(`runBotReconnectCheck(): Offline peers: ${offlinePeers.length} / ${allPeers.length}`)

  // if need emergency reconnect - running reconnect early regardless of timers!
  const isRunningEmergencyReconnect = offlinePeers.length / allPeers.length > mynode.offlineLimitPercentage / 100.0
  if (isRunningEmergencyReconnect) {
    console.log(
      `${getDate()} runBotReconnectCheck(): too many peers offline (>${
        mynode.offlineLimitPercentage
      }%). Running early reconnect.`
    )
    await runBotReconnect()
    updateBotTimers({ lastReconnect: Date.now() })
    return null
  }

  // now actually check for scheduled one
  const lastReconnect = timers.lastReconnect || 0
  const timeSince = now - lastReconnect
  const isTimeForReconnect = timeSince > 1000 * 60 * MINUTES_BETWEEN_RECONNECTS
  const minutesSince = (timeSince / (1000.0 * 60)).toFixed(1)
  console.log(
    `${getDate()} runBotReconnectCheck(): ${
      isTimeForReconnect ? 'Time to run' : 'Skipping'
    } BoS reconnect. (${MINUTES_BETWEEN_RECONNECTS} minutes timer)` +
      ` Last run: ${lastReconnect === 0 ? 'never' : `${minutesSince} minutes ago at ${getDate(lastReconnect)}`}`
  )
  if (isTimeForReconnect) {
    // check for internet / tor issues
    await runBotReconnect()
    updateBotTimers({ lastReconnect: Date.now() })
    return null
  }
}

// fee update timer handling
const runUpdateFeesCheck = async () => {
  const now = Date.now()
  const timers = mynode.timers
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
    updateBotTimers({ lastFeeUpdate: now })
  }
}

// database/payments cleaning timer handling
const runCleaningCheck = async () => {
  if (!ALLOW_DB_CLEANUP) return null

  const now = Date.now()
  const timers = mynode.timers
  const lastCleaningUpdate = timers?.lastCleaningUpdate || 0
  const timeSince = now - lastCleaningUpdate
  const isTime = timeSince > DAYS_BETWEEN_DB_CLEANING * days

  const daysSince = (timeSince / days).toFixed(1)
  console.log(
    `${getDate()} ${
      isTime ? 'Time to run' : 'Skipping'
    } db payments cleaning. (${DAYS_BETWEEN_DB_CLEANING} days timer)` +
      ` Last run: ${lastCleaningUpdate === 0 ? 'never' : `${daysSince} days ago at ${getDate(lastCleaningUpdate)}`}`
  )
  if (isTime) {
    // clean db
    await runCleaning()
    updateBotTimers({ lastCleaningUpdate: now })
  }
}

// first backup payments to logs folder and then clear them
const runCleaning = async () => {
  logDim('runCleaning()')

  const DAYS_FOR_STATS = 999 // how many days back to backup

  if (!fs.existsSync(LOG_FILES)) fs.mkdirSync(LOG_FILES, { recursive: true })

  const payments = await bos.customGetPaymentEvents({ days: DAYS_FOR_STATS })
  fs.writeFileSync(`${LOG_FILES}/${Date.now()}_paymentHistory.json`, JSON.stringify(payments, fixJSON, 2))
  console.log(`${getDate()} ${payments.length} payments backed up`)

  const res = await bos.callAPI('deletePayments')
  console.log(`${getDate()} all payments deleted from database`, res || '')
}

// logic for updating fees & max htlc sats size (v3)
const updateFees = async () => {
  logDim('updateFees() v3')

  if (!ADJUST_POLICIES) {
    console.log(`${getDate()} ADJUST_POLICIES=false so just simulating what it would've been`)
  }

  // generate brand new snapshots of peers with ALL the details (slow)
  const allPeers = await generatePeersSnapshots()

  // SMALL CHANNELS - just htlc size

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
    const by_channel_id = sizeMaxHTLC(peer)
    const byChannelHtlcString = Object.values(by_channel_id)
      .map(v => pretty(v.max_htlc_mtokens / 1000))
      .join('|')

    logDim(
      `${ca(peer.alias).padEnd(30)} < ${pretty(MIN_CHAN_SIZE)} ` +
        'sats capacity setting so skipping fee adjustments, ' +
        `max htlc: ${byChannelHtlcString.padStart(11)}`
    )
    if (ADJUST_POLICIES) {
      await bos.setPeerPolicy({
        peer_key: peer.public_key,
        by_channel_id,
        my_key: mynode.public_key // speeds it up
      })
    }
  }

  // NORMAL CHANNELS - adjust fees & max htlcs
  const peers = allPeers.filter(
    p =>
      !p.is_offline &&
      !p.is_pending &&
      !p.is_private &&
      p.is_active &&
      // leave small channels alone
      p.totalSats > MIN_CHAN_SIZE
  )

  // simple counts for summary
  let nIncreased = 0
  let nDecreased = 0
  let nTargetsInceased = 0
  let nTargetsDecreased = 0

  // fetch forwards since last policy update or fee update range
  // adding 10% to bridge any minor gaps
  const daysSinceLastChange = mynode.timers?.lastFeeUpdate
    ? daysAgo(mynode.timers.lastFeeUpdate)
    : (MINUTES_BETWEEN_FEE_CHANGES * 1.01) / 60.0 / 24.0

  DEBUG &&
    console.log(
      `${getDate()} testing time diff`,
      { daysSinceLastChange },
      { lastFeeUpdate: getDate(mynode.timers.lastFeeUpdate) }
    )

  const forwardsSinceUpdate = await bos.customGetForwardingEvents({
    days: daysSinceLastChange
  })

  let feeChangeSummary = `${getDate()} Fee change summary`

  for (const peer of peers) {
    // current stats
    const now = Date.now()
    const ppmOld = peer.fee_rate // already getting this through getReferenceFee(peer)

    // if undefined or not a number or null peer channel is not in state to manage (channel likely closing/opening)
    if (isNaN(ppmOld) || ppmOld === null) {
      console.log(
        `${getDate()} ${peer.alias} ${
          peer.public_key
        } issue: peer has uncertain outgoing fee rate so skipped (val = ${ppmOld})`
      )
      // skip this peer
      continue
    }

    const flowOutRecentDaysAgo = daysAgo(peer.routed_out_last_at)
    const logFileData = readRecord(peer.public_key)

    // check if there are rules about this peer
    const rule = getRuleFromSettings({ peer })

    const applyRules = ppm => {
      // settings.json rules checked first
      ppm = rule?.min_ppm !== undefined ? max(rule.min_ppm, ppm) : ppm
      ppm = rule?.max_ppm !== undefined ? min(rule.max_ppm, ppm) : ppm
      // followed by absolute script rules set at top
      ppm = max(min(MAX_PPM_ABSOLUTE, ppm), MIN_PPM_ABSOLUTE)
      return +ppm.toFixed(5) // round to 5 decimal spaces
    }

    // use peer rule based delay before fees are allowed to reduce if provided, otherwise default
    const daysWaitingBeforeFeeReduction = rule?.days_for_fee_reduction ?? DAYS_FOR_FEE_REDUCTION

    // determine rules when to increase and decrease

    let isIncreasing = flowOutRecentDaysAgo < daysSinceLastChange

    let isDecreasing =
      !isIncreasing &&
      flowOutRecentDaysAgo > daysWaitingBeforeFeeReduction &&
      // safer to skip VERY-remote-heavy channels to avoid false measurements since unable to route out anymore
      !isVeryRemoteHeavy(peer)

    const flowString = `${isNetOutflowing(peer) ? 'outflowing' : isNetInflowing(peer) ? ' inflowing' : '   no flow'}`
    const flowOutDaysString =
      flowOutRecentDaysAgo > DAYS_FOR_STATS
        ? `${DAYS_FOR_STATS}+`.padStart(5)
        : flowOutRecentDaysAgo.toFixed(1).padStart(5)

    feeChangeSummary += '\n'

    // determine by how much to increase or decrease

    // check record for float ppm, if available and matches current ppm, use float
    // otherwise just uses current ppm
    const ppmRecord = getReferenceFee(peer)
    if (ppmRecord === null) continue // was some issue with getting fee rate

    // let ppmNewFloat = ppmRecord && trunc(ppmRecord) === ppmOld ? ppmRecord : ppmOld

    // starting point is current fee rate
    // will have to change fee rates using settings.json file
    // on other hand, opening more channels at some fee rate won't reset current fee rate for all
    let ppmNewFloat = ppmRecord

    // measure rate of flow of sats out of local side of channel
    const outflow =
      forwardsSinceUpdate[peer.public_key]?.reduce((sum, fw) => fw.mtokens / 1000.0 / daysSinceLastChange + sum, 0) || 0
    // scale of outflow per day compared to refSatsOutflow based on forwards since last fee update
    // starts at 0 and ~1 when flow rate (extrapolated to per day) is on scale of half capacity
    const refSatsOutflow = peer.outbound_liquidity // less signficant increases if out liquidity large
    // const refSatsOutflow = peer.capacity / 2 // compare outflow to this
    const outflowFactor = 1 - exp((-PI * outflow) / refSatsOutflow)

    // ppm is nudged here up or down and then rules are applied
    // if (isIncreasing) ppmNewFloat = ppmNewFloat * (1 + modifiedNudgeUp)
    // else if (isDecreasing) ppmNewFloat = trunc(ppmNewFloat * (1 - NUDGE_DOWN))
    if (isIncreasing) ppmNewFloat = stepUpFee(ppmNewFloat, outflowFactor * NUDGE_UP)
    else if (isDecreasing) ppmNewFloat = stepDownFee(ppmNewFloat, NUDGE_DOWN)
    ppmNewFloat = applyRules(ppmNewFloat)
    const ppmNewFloatTrunc = trunc(ppmNewFloat)

    // check if actual increase or decrease is necessary post changes & rules
    // isIncreasing = ppmNewFloatTrunc > trunc(ppmRecord)
    // isDecreasing = ppmNewFloatTrunc < trunc(ppmRecord)

    // re-check if truncated fee changes are bigger than FEE_CHANGE_TOLERANCE
    isIncreasing = trunc(ppmNewFloat) > trunc(ppmOld * (1 + FEE_CHANGE_TOLERANCE))
    isDecreasing = trunc(ppmNewFloat) < trunc(ppmOld * (1 - FEE_CHANGE_TOLERANCE))

    // get the rest of channel policies figured out
    const localSats = ((peer.outbound_liquidity / 1e6).toFixed(1) + 'M').padStart(6)
    const remoteSats = ((peer.inbound_liquidity / 1e6).toFixed(1) + 'M').padEnd(6)
    // max htlc sizes for this peers channels
    const by_channel_id = sizeMaxHTLC(peer)
    const byChannelHtlcString = Object.values(by_channel_id)
      .map(v => pretty(v.max_htlc_mtokens / 1000).padStart(10))
      .join('|')

    // if change is too small just keep same fee rate so forwards don't fail bc of outdated fee as often
    let appliedFeeRate = isIncreasing || isDecreasing ? ppmNewFloatTrunc : ppmOld
    // EXCEPTION: use ROUTING_STOPPING_FEE_RATE if my side of channel is drained
    appliedFeeRate = isDrained(peer) ? max(ROUTING_STOPPING_FEE_RATE, ppmNewFloatTrunc) : appliedFeeRate

    const outflowString = outflow ? `${pretty(outflow).padStart(10)} sats/day` : ''

    const hasUsedChanged = isIncreasing || isDecreasing
    const hasTargetChanged = ppmNewFloat.toFixed(3) !== ppmRecord.toFixed(3)
    const targetChangePercent = hasTargetChanged ? +(((ppmNewFloat - ppmRecord) / ppmRecord) * 100).toFixed(2) : 0

    // to print fees actually seen on gossip before and after
    // prettier-ignore
    const ppmActualFees = `${ppmOld.toFixed(0).padStart(5)} ${hasUsedChanged ? '->' : '  '} ${appliedFeeRate.toFixed(0).padEnd(6)}`
    // to print floating set points used ideally
    // prettier-ignore
    const ppmSetPoints = `${ppmRecord.toFixed(3).padStart(9)} ${hasTargetChanged ? '->' : '  '} ${ppmNewFloat.toFixed(3).padEnd(10)}`

    // console.log({ targetChangePercent, hasTargetChanged, ppmNewFloat, ppmRecord })
    // assemble warnings
    const notes = [
      `max-htlc: ${byChannelHtlcString}`,
      hasTargetChanged ? `${targetChangePercent.toFixed(3).padStart(8)}%` : ''.padStart(9),
      isIncreasing ? '🔼-ppm' : '',
      isDecreasing ? '🔻-ppm' : '',
      isVeryRemoteHeavy(peer) ? '💤-VRH' : '',
      isDrained(peer) ? `⛔-BLOCK ${ROUTING_STOPPING_FEE_RATE}ppm` : '',
      outflowString
    ].join(' ')

    // update counts
    if (isIncreasing) nIncreased++
    if (isDecreasing) nDecreased++
    if (targetChangePercent > 0) nTargetsInceased++
    if (targetChangePercent < 0) nTargetsDecreased++

    // prettier-ignore
    const feeChangeLine = `${getDate()} ${ca(peer.alias).padEnd(30)} used: ${ppmActualFees} setpt: ${ppmSetPoints} ${flowString.padStart(12)} ${flowOutDaysString} days  ${localSats}|${remoteSats} ${notes}`
    feeChangeSummary += feeChangeLine
    console.log(feeChangeLine)

    // do policy adjustment

    if (ADJUST_POLICIES) {
      const res = await bos.setPeerPolicy({
        peer_key: peer.public_key,
        by_channel_id, // max htlc sizes
        fee_rate: appliedFeeRate, // fee rate
        my_key: mynode.public_key // speeds it up
      })

      if (res?.length) {
        // if no update, skip appending record & move on
        // most likely cause getNode command doesn't have this channel info yet
        feeChangeSummary += '👮‍♂️-POLICY-CHANGE-FAILED'
        continue
      }

      // record data

      // this creates record if one doesn't exist yet so just checking increasing/decreasing not enough
      // update record if last recorded fee rate (float) if exists isn't ppmNewFloat
      if ((logFileData?.feeChanges || [])[0]?.ppmFloat !== ppmNewFloat) {
        appendRecord({
          peer,
          newRecordData: {
            ppmFloat: ppmNewFloat, // this will be ppm used next update if available
            feeChanges: [
              {
                t: now,
                UTC: getDate(now),
                ppm: appliedFeeRate, // fee actually used on channel
                ppmFloat: ppmNewFloat, // fee set-point floating pt target
                // for ppm vs Fout data
                ppm_old: ppmOld, // old fee used on channel
                ppmFloat_old: ppmRecord, // old set-point floating reference ppm
                routed_out_msats: peer.routed_out_msats,
                daysNoRouting: +flowOutRecentDaysAgo.toFixed(1)
              },
              ...(logFileData?.feeChanges || [])
            ]
          }
        })
      }
    }
  }

  feeChangeSummary += '\n'

  const unchanged = peers.length - nIncreased - nDecreased

  const feeChangeTotals = `
${allPeers.length.toFixed(0).padStart(5)} peers
${peers.length.toFixed(0).padStart(5)} channels (above min size) evaluated for fee updates
${nTargetsInceased.toFixed(0).padStart(5)} floating set-points increased
${nTargetsDecreased.toFixed(0).padStart(5)} floating set-points decreased
${nIncreased.toFixed(0).padStart(5)} broadcasted fee rates increased
${nDecreased.toFixed(0).padStart(5)} broadcasted fee rates decreased
${unchanged.toFixed(0).padStart(5)} active fee rate policies unchanged
  `
  feeChangeSummary += feeChangeTotals
  console.log(feeChangeTotals)

  if (ADJUST_POLICIES) await telegramLog('📣 Fee change summary:' + feeChangeTotals.replace(/ +/g, ' '))

  // make it available for review
  const previousFeeChanges = fs.existsSync('_feeChanges.txt') ? fs.readFileSync('_feeChanges.txt') : ''
  fs.writeFileSync(`${LOG_FILES}/${getDay()}_feeChanges.txt`, previousFeeChanges + '\n' + feeChangeSummary)
  fs.writeFileSync('_feeChanges.txt', feeChangeSummary + '\n' + previousFeeChanges)
}

// keep track of peers rebalancing attempts in files
// keep peers separate to avoid rewriting entirety of data at once on ssd
const appendRecord = ({ peer, newRecordData = {}, newRebalance = {} }, log = false) => {
  // filename uses 10 first digits of pubkey hex
  const fullPath = PEERS_LOG_PATH + '/' + peer.public_key.slice(0, 10) + '.json'

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
  const fullPath = PEERS_LOG_PATH + '/' + publicKey.slice(0, 10) + '.json'
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
// returns peers info with maximum detail (content of _peers.json)
const generatePeersSnapshots = async () => {
  logDim('generatePeersSnapshots()')
  printMemoryUsage('(before snapshot)')

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
  const feeRatesArray = (await bos.callAPI('getFeeRates'))?.channels || []
  const feeRates = feeRatesArray.reduce((final, channel) => {
    final[channel.id] = channel
    return final
  }, {})

  // get all peers info
  const peers = await runBotGetPeers({ all: true })
  const publicKeyToAlias = {} // public_key -> alias table
  peers.forEach(p => {
    publicKeyToAlias[p.public_key] = p.alias
  })

  // taking notes of when last seen in one place
  const lastSeenPath = `${LOG_FILES}/lastSeen.json`
  const lastSeen = fs.existsSync(lastSeenPath) ? JSON.parse(fs.readFileSync(lastSeenPath)) : {}
  const now = Date.now()
  for (const peer of peers) {
    const isFirstRecord = !lastSeen[peer.public_key]
    // if peer online now or I just need to initialize a time even if its online, mark down time for this public key
    if (isFirstRecord || !peer.is_offline) lastSeen[peer.public_key] = now
  }

  // specific routing events

  // gets every routing event indexed by out peer
  const peerForwardsByOuts = await bos.customGetForwardingEvents({
    days: DAYS_FOR_STATS
  })
  // make a by-inlets reference table copy with ins as keys
  const peerForwardsByIns = {}

  // create a reference array of forwards
  const forwardsAll = []

  // summarize forwarding results myself from individual forwading events
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
  // now forwardsSum has forwards inflow and outflow info by each channel as key

  // payments and received payments
  // get all payments from db
  const getPaymentEvents = await bos.customGetPaymentEvents({
    days: DAYS_FOR_STATS
  })
  // payments can be deleted so scan log file backups
  const res = fs.readdirSync(LOG_FILES) || []
  const paymentLogFiles = res.filter(f => f.match(/_paymentHistory/))
  const isRecent = t => Date.now() - t < DAYS_FOR_STATS * days
  VERBOSE && logDim(`${getPaymentEvents.length} payment records found in db`)
  for (const fileName of paymentLogFiles) {
    const timestamp = fileName.split('_')[0]
    const useFile = isRecent(timestamp)
    // logDim(`${fileName} - is Recent? ${useFile}`) // say for each log file if used
    if (!useFile) continue // log file older than oldest needed record
    const payments = JSON.parse(fs.readFileSync(`${LOG_FILES}/${fileName}`))
    getPaymentEvents.push(...payments.filter(p => isRecent(p.created_at_ms)))
    VERBOSE && logDim(`${getPaymentEvents.length} payment records used from log file`)
  }

  // get all received funds
  const getReceivedEvents = await bos.customGetReceivedEvents({
    days: DAYS_FOR_STATS,
    idKeys: true
  })
  // get just payments to myself
  const rebalances = getPaymentEvents.filter(p => p.destination === mynode.public_key)
  // get payments to others
  const paidToOthersLN = getPaymentEvents.filter(p => p.destination !== mynode.public_key)
  // get list of received payments and remove those from payments to self
  const receivedFromOthersLN = Object.assign({}, getReceivedEvents) // shallow clone
  rebalances.forEach(r => {
    delete receivedFromOthersLN[r.id]
  })

  const policies =
    (await bos.getNodeChannels({
      public_key: mynode.public_key
    })) || {}

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

  const { current_block_height } = (await bos.callAPI('getHeight')) || {}

  // accumulators
  let [lifetimeSentAll, lifetimeReceivedAll] = [0, 0]

  // ==================== add in all extra new data for each peer ==================
  peers.forEach(peer => {
    // this is the direct details generation pass
    delete peer.missing_details_pass

    // fee_earnings is from bos peer call with days specified, not necessary hmm

    // my rough estimate of last seen
    peer.last_seen_days_ago = +daysAgo(lastSeen[peer.public_key]).toFixed(1)

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
    // https://github.com/lightningnetwork/lnd/blob/master/lnwire/features.go
    peer.features = networkingData[peer.public_key]?.features?.map(f => `${f.bit} ${f.type}`)

    // really odd choice of object with just 1 channel id in it instead of array, so replacing with boolean
    peer.is_forwarding = !!peer.is_forwarding

    // experimental
    // calculateFlowRateMargin(peer)

    // initialize capacity (sum below from each individual channel to this peer)
    // more constant measure of total sats indifferent from inflight htlcs & reserves
    peer.capacity = 0
    // initialize pending htlc counter
    peer.pending_count = 0
    // initialize base fees
    peer.remoteBaseFee = 0
    peer.baseFee = 0

    // grab array of separate short channel id's for this peer
    const ids = publicKeyToIds[peer.public_key]

    // convert array of text ids to array of info for each ids channel
    peer.ids = ids.reduce((final, id) => {
      // if any of the our channels are active I'll mark peer as active
      peer.is_active = !!peer.is_active || channelOnChainInfo[id].is_active
      peer.unsettled_balance = (peer.unsettled_balance || 0) + channelOnChainInfo[id].unsettled_balance
      // add up capacities which can be different from total sats if in flight sats
      peer.capacity += channelOnChainInfo[id].capacity
      // put highest base fee into peer
      peer.remote_base_fee_mtokens = max(peer.remote_base_fee_mtokens, +policies[id]?.remote.base_fee_mtokens)
      peer.base_fee_mtokens = max(peer.base_fee_mtokens, +feeRates[id].base_fee_mtokens)

      // estimate channel age from opening transaction block height to minimize reliance on api
      const openingHeight = +id.split('x')[0]
      const channelAgeDays = +(((current_block_height - openingHeight) * 10) / (60 * 24)).toFixed(1) || 0

      // easy to check # of in flight htlcs
      peer.pending_count += channelOnChainInfo[id]?.pending_payments?.length || 0

      // add this info for each of peer's channels separately
      final.push({
        // pick what to put into peers file here for each channel id
        id,
        transaction_id: channelOnChainInfo[id].transaction_id,
        transaction_vout: channelOnChainInfo[id].transaction_vout,
        channel_age_days: channelAgeDays,
        capacity: channelOnChainInfo[id].capacity,

        pending_payments: channelOnChainInfo[id]?.pending_payments || [],

        local_base_fee_mtokens: +feeRates[id].base_fee_mtokens,
        local_fee_rate: +feeRates[id].fee_rate,
        local_ctlv_delta: +policies[id]?.local.cltv_delta,
        local_is_disabled: policies[id]?.local.is_disabled,
        local_max_pending_mtokens: +channelOnChainInfo[id].local_max_pending_mtokens,
        local_max_htlc_mtokens: +policies[id]?.local.max_htlc_mtokens,
        local_min_htlc_mtokens: +policies[id]?.local.min_htlc_mtokens,
        local_min_pending_mtokens: +channelOnChainInfo[id].local_min_htlc_mtokens,

        remote_base_fee_mtokens: +policies[id]?.remote.base_fee_mtokens,
        remote_fee_rate: +policies[id]?.remote.fee_rate,
        remote_ctlv_delta: +policies[id]?.remote.cltv_delta,
        remote_is_disabled: policies[id]?.remote.is_disabled,
        remote_max_pending_mtokens: +channelOnChainInfo[id].remote_max_pending_mtokens,
        remote_max_htlc_mtokens: +policies[id]?.remote.max_htlc_mtokens,
        remote_min_htlc_mtokens: +policies[id]?.remote.min_htlc_mtokens,
        remote_min_pending_mtokens: +channelOnChainInfo[id].remote_min_htlc_mtokens,

        sent: channelOnChainInfo[id].sent,
        received: channelOnChainInfo[id].received,
        past_states: channelOnChainInfo[id].past_states,
        time_online_ms: channelOnChainInfo[id].time_online,
        time_offline_ms: channelOnChainInfo[id].time_offline,

        is_active: channelOnChainInfo[id].is_active,
        unsettled_balance: channelOnChainInfo[id].unsettled_balance,

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

      lifetimeSentAll += channelOnChainInfo[id]?.sent ?? 0
      lifetimeReceivedAll += channelOnChainInfo[id]?.received ?? 0

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

  const totalLocalSatsOffline = peers.reduce((sum, peer) => (peer.is_offline ? sum + peer.outbound_liquidity : sum), 0)
  const totalRemoteSatsOffline = peers.reduce((sum, peer) => (peer.is_offline ? sum + peer.inbound_liquidity : sum), 0)
  const pLocalSatsOffline = ((totalLocalSatsOffline / totalLocalSats) * 100).toFixed(0)
  const pRemoteSatsOffline = ((totalRemoteSatsOffline / totalRemoteSats) * 100).toFixed(0)

  // idea for normalized metric "unbalanced %"
  // 2 * sats-away-from-balance / total capacity * 100%
  // completely unbalanced would be like 2*5M/10M = 100%
  // complete balanced would be 0 / 10M = 0%
  const totalSatsOffBalance = peers.reduce((sum, peer) => sum + peer.unbalancedSats, 0)
  const totalCapacity = peers.reduce((sum, peer) => sum + peer.totalSats, 0)
  const unbalancedPercent = (((2.0 * totalSatsOffBalance) / totalCapacity) * 100).toFixed(0)

  const totalSatsOffBalanceSigned = peers.reduce((sum, peer) => sum + peer.unbalancedSatsSigned, 0)

  const baseFeesStats = median(feeRatesArray.map(d => +d.base_fee_mtokens)).s
  const ppmFeesStats = median(feeRatesArray.map(d => d.fee_rate)).s
  const channelCapacityStats = median(
    getChannels.channels.map(d => d.capacity),
    { f: pretty }
  ).s

  // inconsistent data by days with total it reports
  // const earningsSummary = await bos.getFeesChart({ days: DAYS_FOR_STATS })
  // const totalEarnedFromForwards = earningsSummary.data?.reduce((t, v) => t + v, 0) || 0
  // this is just for current peers, closed channels earnings not included
  // const totalEarnedFromForwards = peers.reduce((t, p) => t + p.routed_out_fees_msats, 0) / 1000

  const statsEarnedPerPeer = median(
    peers.filter(p => p.routed_out_last_at).map(p => p.routed_out_fees_msats / 1000),
    { f: pretty }
  ).s

  const totalPeersRoutingIn = peers.filter(p => p.routed_in_last_at).length
  const totalPeersRoutingOut = peers.filter(p => p.routed_out_last_at).length

  const chainFeesSummary = await bos.getChainFeesChart({ days: DAYS_FOR_STATS })

  const unsettledTotalCount = peers.reduce((t, p) => t + p.pending_count, 0)

  const balances = await bos.getDetailedBalance()

  // get totals from payments and received
  const totalReceivedFromOthersLN =
    Object.values(receivedFromOthersLN).reduce((t, r) => t + r.received_mtokens, 0) / 1000
  const totalSentToOthersLN = paidToOthersLN.reduce((t, p) => t + p.mtokens, 0) / 1000
  const totalRebalances = rebalances.reduce((t, p) => t + p.mtokens, 0) / 1000

  const totalRebalanceFees = rebalances.reduce((t, p) => t + p.fee_mtokens, 0) / 1000
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
  const totalEarnedFromForwards = forwardsAll.reduce((t, f) => t + f.fee_mtokens / 1000, 0)

  const totalChainFees = chainFeesSummary.data?.reduce((t, v) => t + v, 0) || 0

  const totalProfit = totalEarnedFromForwards - totalChainFees - totalRebalanceFees

  const memoryUsed = printMemoryUsage()

  peers.forEach(p => {
    // add this experimental flow rate calc (temp)
    // calculateFlowRateMargin(p)
    // calculate weight for each peer
    p.rndWeight = WEIGHT(p)
  })

  // prettier-ignore
  const nodeSummary = `${getDate()}

  NODE FUNDS SUMMARY
  (Timeframe used where applicable is last ${DAYS_FOR_STATS} days)

    total peers:                      ${peers.length}

    lightning local available:        ${pretty(totalLocalSats)} sats (${pLocalSatsOffline}% offline)
    lightning remote available:       ${pretty(totalRemoteSats)} sats (${pRemoteSatsOffline}% offline)
    lightning total:                  ${pretty(balances.offchain_balance * 1e8)} sats
    lightning unsettled:              ${pretty(totalUnsettledSats)} sats (n: ${unsettledTotalCount})
    lightning pending                 ${pretty(balances.offchain_pending * 1e8)} sats

    on-chain closing:                 ${pretty(balances.closing_balance * 1e8)} sats
    on-chain total:                   ${pretty(balances.onchain_balance * 1e8)} sats
  -------------------------------------------------------------

  FORWARDS STATISTICS:

    total earned forwarding:          ${pretty(totalEarnedFromForwards)} sats
    total on-chain fees paid:         ${pretty(totalChainFees)} sats
    total rebalance fees paid:        ${pretty(totalRebalanceFees)} sats

    NET PROFIT:                       ${pretty(totalProfit)} sats

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

    % routed/local                    ${(totalRouted / totalLocalSats * 100).toFixed(0)} %
    % net-profit/earned               ${(totalProfit / totalEarnedFromForwards * 100).toFixed(0)} %
    avg earned/routed:                ${(totalEarnedFromForwards / totalRouted * 1e6).toFixed(0)} ppm
    avg net-profit/routed:            ${(totalProfit / totalRouted * 1e6).toFixed(0)} ppm
    avg earned/local:                 ${(totalEarnedFromForwards / totalLocalSats * 1e6).toFixed(0)} ppm
    avg net-profit/local:             ${(totalProfit / totalLocalSats * 1e6).toFixed(0)} ppm
    est. annual ROI:                  ${(totalProfit / DAYS_FOR_STATS * 365.25 / totalLocalSats * 100).toFixed(3)} %
    est. annual profit:               ${pretty(totalProfit / DAYS_FOR_STATS * 365.25)} sats
  -------------------------------------------------------------

  MY LN SUMMARY:

    LN received from others:          ${pretty(totalReceivedFromOthersLN)} sats (n: ${Object.keys(receivedFromOthersLN).length})
    LN payments to others:            ${pretty(totalSentToOthersLN)} sats, fees: ${pretty(totalSentToOthersFees)} sats (n: ${paidToOthersLN.length})
    LN total rebalanced:              ${pretty(totalRebalances)} sats, fees: ${pretty(totalRebalanceFees)} (n: ${rebalances.length})
    LN total forwarded:               ${pretty(totalRouted)} sats (n: ${totalForwardsCount})

    my base fee stats:                ${baseFeesStats} msats
    my proportional fee stats:        ${ppmFeesStats} ppm
    my channel capacity stats:        ${channelCapacityStats} sats
    lifetime all peers sent:          ${pretty(lifetimeSentAll)} sats
    lifetime all peers received:      ${pretty(lifetimeReceivedAll)} sats
    lifetime capacity used:           ${((lifetimeSentAll + lifetimeReceivedAll) / totalLocalSats * 100).toFixed(0)} %

    total unbalanced local:           ${pretty(totalLocalSatsOffBalance)} sats
    total unbalanced remote:          ${pretty(abs(totalRemoteSatsOffBalance))} sats
    total unbalanced:                 ${pretty(totalSatsOffBalance)} sats
    total unbalanced sats percent:    ${unbalancedPercent}%
    net unbalanced sats:              ${pretty(totalSatsOffBalanceSigned)} sats
    overall balance:                  ${(totalLocalSats / totalCapacity).toFixed(2)}

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
  -------------------------------------------------------------
    script RAM usage:                 ${memoryUsed?.rssString} MB resident set size
  `
  /*
                                      ${(os.freemem() / 1024 / 1024).toFixed(0)} MB free system memory
                                      ${(os.totalmem() / 1024 / 1024).toFixed(0)} MB system memory
                                      ${memoryUsed?.usedString} MB usedHeap (occupied by js objects)
                                      ${memoryUsed?.externalString} MB external (buffers)
                                      ${memoryUsed?.rssString} MB rss (js process consumption)
  */
  console.log(nodeSummary)

  // by channel flow rate summary

  // sort by most to least flow total, normalized by capacity
  // higher rating uses capacity better and recommended for size up
  // lower rating uses capacity worse or not at all and recommended for changes
  // const score = p => (p.routed_out_msats + p.routed_in_msats) / p.capacity // uses available capacity best
  // const score = p => ((p.routed_out_fees_msats + p.routed_in_fees_msats) / p.capacity) * 1e6 // best returns for available capacity
  const score = p => p.routed_out_fees_msats + p.routed_in_fees_msats

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
        ? `last ∆ppm: ${lastPpmChange.ppm_old?.toFixed(3)} -> ${lastPpmChange.ppmFloat?.toFixed(3)} ppm @ ` +
          `${(lastPpmChangeMinutes / 60 / 24).toFixed(1)} days ago`
        : ''

    const lastRoutedIn = (Date.now() - p.routed_in_last_at) / days
    const lastRoutedInString =
      lastRoutedIn > DAYS_FOR_STATS ? `${DAYS_FOR_STATS}+? days` : `${lastRoutedIn.toFixed(1)} days`
    // ? `routed-in <--  ${DAYS_FOR_STATS}+? days ago`
    // : `routed-in <--  ${lastRoutedIn.toFixed(1)} days ago`
    const lastRoutedOut = (Date.now() - p.routed_out_last_at) / days
    const lastRoutedOutString =
      lastRoutedOut > DAYS_FOR_STATS ? `${DAYS_FOR_STATS}+? days ago` : `${lastRoutedOut.toFixed(1)} days ago`
    // ? `routed-out (-->) ${DAYS_FOR_STATS}+? days ago`
    // : `routed-out (-->) ${lastRoutedOut.toFixed(1)} days ago`

    const issues = []

    if (p.rebalanced_out_msats > 0 && p.rebalanced_in_msats > 0) issues.push('2-WAY-REBALANCE')
    // warning if fee is lower than needed for rebalancing on remote heavy channel with no flow in
    if (
      p.outbound_liquidity < MIN_SATS_PER_SIDE && // low liquidity
      p.capacity > MIN_CHAN_SIZE && // for capacity above rebalanced
      p.routed_in_msats === 0 && // and no helpful routing
      p.rebalanced_in_msats === 0 && // and no helpful rebalancing
      rebalanceSuggestionHistory.o.bottom25 && // have rebalance data
      addSafety(rebalanceSuggestionHistory.o.bottom25) > getReferenceFee(p) // too low
    ) {
      issues.push('FEE-BELOW-REBALANCE')
    }

    if (p.is_offline) {
      issues.push('OFFLINE-' + daysAgo(lastSeen[p.public_key]).toFixed(1) + '-DAYS')
    }

    if (p.is_inbound_disabled) {
      issues.push('IN-DISABLED')
    }

    if (p.remoteBaseFee && p.baseFee && p.remoteBaseFee > 1000 && p.remoteBaseFee > p.baseFee * 10) {
      issues.push('REMOTE-BASE-FEE-10X-LARGER-' + (p.remoteBaseFee / 1000).toFixed(3) + '-sats')
    }

    const issuesString = issues.length > 0 ? '🚨 ' + issues.join(', ') : ''

    const lifetimeSentFlowrate = pretty(p.ids.reduce((sum, c) => c.sent / c.channel_age_days + sum, 0)) + ' sats/day'
    const lifeTimeReceivedFlowrate =
      pretty(p.ids.reduce((sum, c) => c.received / c.channel_age_days + sum, 0)) + ' sats/day'
    const lifetimeSent = p.ids.reduce((sum, c) => c.sent + sum, 0)
    const lifeTimeReceived = p.ids.reduce((sum, c) => c.received + sum, 0)
    const capacityTotal = p.capacity
    const capacityUsed = ((lifetimeSent + lifeTimeReceived) / capacityTotal).toFixed(1) + 'x capacity used'
    const oldestChannelAge = p.ids.reduce((oldest, c) => max(ceil(c.channel_age_days), oldest), 0) + ' days'
    const htlcsString = p.pending_count ? `${p.pending_count}-htlcs ` : ' '

    // show past states for each channel with MB estimate
    // prettier-ignore
    const pastStates = p.ids.map(c => `${c.id}: ${pretty(c.past_states)} ~${((c.past_states * 0.51) / 1024).toFixed(1)}MB`).join(', ')

    // help out force closing by providing exact command to use in flow summary
    const forceCloseLine =
      daysAgo(lastSeen[p.public_key]) < 14
        ? ''
        : 'Run to force-close: ' +
          p.ids.map(c => `lncli closechannel --force ${c.transaction_id} ${c.transaction_vout}`).join(' ; ') +
          ' \n'

    // prettier-ignore
    flowRateSummary += `${('#' + (i + 1)).padStart(4)}  score: ${pretty(score(p))} pubkey: ${p.public_key} (./peers/${p.public_key.slice(0, 10)}.json)
      ${' '.repeat(15)}me  ${(p.fee_rate + 'ppm').padStart(7)} [-${local}--|--${remote}-] ${(p.inbound_fee_rate + 'ppm').padEnd(7)} ${p.alias}  ${p.balance.toFixed(1)}b ${htlcsString}${isNetOutflowing(p) ? 'F_net-->' : ''}${isNetInflowing(p) ? '<--F_net' : ''} ${issuesString}
      ${dim}${routeIn.padStart(26)} <---- routing ----> ${routeOut.padEnd(23)} +${routeOutEarned.padEnd(17)} ${routeInPpm.padStart(5)}|${routeOutPpm.padEnd(10)} ${('#' + p.routed_in_count).padStart(5)}|#${p.routed_out_count.toString().padEnd(5)}${undim}
      ${dim}${rebIn.padStart(26)} <-- rebalancing --> ${rebOut.padEnd(23)} -${rebOutFees.padEnd(17)} ${rebInPpm.padStart(5)}|${rebOutPpm.padEnd(10)} ${('#' + p.rebalanced_in_count).padStart(5)}|#${p.rebalanced_out_count.toString().padEnd(5)}${undim}
      ${dim}${lifeTimeReceivedFlowrate.padStart(26)} <- avg. lifetime -> ${lifetimeSentFlowrate.padEnd(23)} ${capacityUsed.padStart(18)} over ~${oldestChannelAge}
      ${dim}${' '.repeat(17)} ${lastRoutedInString} <-- last routed --> ${lastRoutedOutString}  ${lastPpmChangeString || 'no ppm change data found'}${undim}
      ${dim}${' '.repeat(17)}rebalances-in (<--) used (ppm): ${rebalanceHistory.s}${undim}
      ${dim}${' '.repeat(17)}rebalances-in (<--) est. (ppm): ${rebalanceSuggestionHistory.s}${undim}
      ${dim}${' '.repeat(17)}past states: ${pastStates}
      ${forceCloseLine}
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

  fs.writeFileSync(`${SNAPSHOTS_PATH}/networkingData.json`, JSON.stringify(networkingData, fixJSON, 2))
  // rebalances sums by peer
  fs.writeFileSync(`${SNAPSHOTS_PATH}/rebalancesSum.json`, JSON.stringify(rebalancesByPeer, fixJSON, 2))
  // highly detailed peer info
  fs.writeFileSync(`${LOG_FILES}/${getDay()}_peers.json`, JSON.stringify(peers, fixJSON, 2))
  fs.writeFileSync(`${SNAPSHOTS_PATH}/peers.json`, JSON.stringify(peers, fixJSON, 2))
  fs.writeFileSync('_peers.json', JSON.stringify(peers, fixJSON, 2)) // got tired of opening folder
  // last seen info in one place
  fs.writeFileSync(lastSeenPath, JSON.stringify(lastSeen))

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

  // prettier-ignore
  const message = `🌱 Statistics for ${DAYS_FOR_STATS} days:

earned: ${pretty(totalEarnedFromForwards)}
spent: ${pretty(totalRebalanceFees + totalChainFees)}
net: ${pretty(totalProfit)}
routing rewards: ${median(forwardsAll.map(f => f.fee_mtokens / 1000.0), { pr: 1 }).s}
memory used: ${memoryUsed?.rssString} MB
`

  await telegramLog(message)

  mynode.peers = peers
  printMemoryUsage('(after snapshot)')
  return peers
}

// uses telegram logging if available
const telegramLog = async message => {
  const { token, chat_id } = mynode.settings?.telegram || {}
  if (token && chat_id) await bos.sayWithTelegramBot({ token, chat_id, message })
}

// experimental
// read slow to calculate peers.json for flowrate info
// update in place the peers array from it
const addDetailsFromSnapshot = peers => {
  const pathPeers = `${SNAPSHOTS_PATH}/peers.json`
  const pathIndex = `${SNAPSHOTS_PATH}/peersIndex.json`
  const fromFilePeers = fs.existsSync(pathPeers) && JSON.parse(fs.readFileSync(pathPeers))
  const fromFilePeersIndex = fs.existsSync(pathIndex) && JSON.parse(fs.readFileSync(pathIndex))
  if (!fromFilePeersIndex || !fromFilePeers) return null

  // checking each item in recently fetched peers array
  // updating it from fromFilePeers array
  // fromFilePeersIndex has fromFilePeers array index for each public key as key
  //   to avoid searching entire array for match per peer
  for (const p of peers) {
    const i = fromFilePeersIndex[p.public_key]

    if (i === undefined) {
      logDim(`${p.public_key} ${p.alias} missing details pass`)
      p.missing_details_pass = true
      continue // no point doing rest
    }

    // most recent routing summary added
    p.routed_out_msats = p.routed_out_msats ?? fromFilePeers[i]?.routed_out_msats ?? 0
    p.routed_in_msats = p.routed_in_msats ?? fromFilePeers[i]?.routed_in_msats ?? 0

    p.routed_out_fees_msats = p.routed_out_fees_msats ?? fromFilePeers[i]?.routed_out_fees_msats ?? 0
    p.routed_in_fees_msats = p.routed_in_fees_msats ?? fromFilePeers[i]?.routed_in_fees_msats ?? 0

    p.rebalanced_out_count = p.rebalanced_out_count ?? fromFilePeers[i]?.rebalanced_out_count ?? 0
    p.rebalanced_in_count = p.rebalanced_in_count ?? fromFilePeers[i]?.rebalanced_in_count ?? 0

    p.routed_out_last_at = p.routed_out_last_at ?? fromFilePeers[i]?.routed_out_last_at ?? 0
    p.routed_in_last_at = p.routed_in_last_at ?? fromFilePeers[i]?.routed_in_last_at ?? 0

    // channel stats
    p.capacity = p.capacity ?? fromFilePeers[i]?.capacity ?? p.totalSats

    // add weight
    p.rndWeight = WEIGHT(p)

    // individual channel info
    p.ids = fromFilePeers[i]?.ids || []
  }
}

// return n peers disabled towards this node and total peers it has
// policy based so likely delay
const getPeersDisabledTowards = async ({ public_key }) => {
  const channelsByPublicKey = await bos.getNodeChannels({
    public_key,
    byPublicKey: true // index by its peers public key
  })
  if (!channelsByPublicKey) return {}

  const nodePeers = Object.values(channelsByPublicKey) || []
  const totalNodePeers = nodePeers.length
  // just looking at 1st channel for each peer
  const totalPeersThatDisabled = nodePeers.reduce((sum, p) => sum + (+p[0]?.remote?.is_disabled || 0), 0)

  return {
    countPeers: totalNodePeers,
    countDisabled: totalPeersThatDisabled
  }
}

// 1. check internet connection, when ok move on
// 2. do bos reconnect
// 3. get updated complete peer info
// 4. peers offline high = reset tor & rerun entire check after delay
const runBotReconnect = async () => {
  logDim('runBotReconnect()')

  // check for basic internet connection
  const isInternetConnected = await dns.promises
    .lookup('google.com')
    .then(() => true)
    .catch(() => false)
  console.log(`${getDate()} Connected to clearnet internet? ${isInternetConnected}`)

  // keep trying until internet connects
  if (!isInternetConnected) {
    await sleep(2 * minutes)
    return await runBotReconnect()
  }

  if (!ALLOW_BOS_RECONNECT) return null

  // run bos reconnect
  const res1 = await bos.reconnect(true)
  updateBotTimers({ lastReconnect: Date.now() })

  console.log(`${getDate()} bos.reconnect() saw ${res1?.reconnected?.length} reconnected.`)

  const offline = res1?.offline || []
  const reconnected = res1?.reconnected || []

  const peers = await bos.peers({}) // get all known peers

  if (!peers) {
    console.log(`${getDate()} no valid response from bos peers`)
    // try re-initializing until it works
    await bos.initializeAuth()
    // add small delay before retrying command again
    await sleep(0.5 * minutes)
    return await runBotReconnect() // rerun function from start
  }
  if (peers.length === 0) return console.warn('no peers')

  const peersDisabledToMe = peers.filter(p => p.is_inbound_disabled).length
  const peersTotal = peers?.length

  const considerOffline = INCLUDE_RECONNECTED_IN_OFFLINE
    ? [...offline, ...reconnected] // peers.filter(p => p.is_offline)
    : offline
  const majorError = peers === null

  // make a list of offline peer aliases and % of peers that disabled towards them according to graph
  const offlinePeerInfoList = []

  const lastSeenPath = `${LOG_FILES}/lastSeen.json`
  const lastSeen = fs.existsSync(lastSeenPath) ? JSON.parse(fs.readFileSync(lastSeenPath)) : {}

  // sort by offline time
  offline.sort((a, b) => (lastSeen[a.public_key] || 0) - (lastSeen[b.public_key] || 0))

  for (const p of offline) {
    const alias = ca(p.alias)
    const { countPeers, countDisabled } = await getPeersDisabledTowards({ public_key: p.public_key })
    const percent = countPeers ? ((countDisabled / countPeers) * 100).toFixed(0) : 'n/a '
    const daysOffline = lastSeen[p.public_key] ? daysAgo(lastSeen[p.public_key]).toFixed(1) + 'd' : ''
    const isReallyOffline = daysOffline > 1 || (countPeers && countDisabled / countPeers > 0.33)
    const icon = isReallyOffline ? '🚫' : '🕑'
    offlinePeerInfoList.push(`${alias} ${icon} ${percent}% ${daysOffline}`)
  }
  const offlinePeerInfo = offlinePeerInfoList.join('\n ') || 'n/a'

  const message = !majorError
    ? `🍳 BoS reconnect done (every ${MINUTES_BETWEEN_RECONNECTS} minutes).\n\n` +
      // give overall statistics on offline
      `<b>Offline peers</b>: ${offline.length}/${peersTotal}` +
      ` (${((offline.length / peersTotal) * 100).toFixed(0)}%)\n\n` +
      // write out offline peers
      ` ${offlinePeerInfo}\n\n` +
      // write out overall statistics on reconnected
      `<b>Reconnected peers</b>: ${reconnected.length}/${peersTotal}` +
      ` (${((reconnected.length / peersTotal) * 100).toFixed(0)}%)\n\n` +
      // write out reconnected peers
      ` ${reconnected.map(p => ca(p.alias)).join(', ') || 'n/a'}\n\n` +
      `<b>Disabled-towards-me-peers</b>: ${peersDisabledToMe}/${peersTotal}` +
      ` (${((peersDisabledToMe / peersTotal) * 100).toFixed(0)}%)\n`
    : 'bos/lnd issue detected'

  // update user about offline peers just in case
  console.log(`${getDate()} ${message.replaceAll(/<\/?.>/g, '')}`)
  await telegramLog(message)

  // skip if set to not reset tor or unused
  if (!ALLOW_NODE_RESET) return 0

  // if all good we're done here
  if (!majorError && considerOffline.length / peersTotal <= mynode.offlineLimitPercentage / 100.0) {
    mynode.offlineLimitPercentage = max(mynode.offlineLimitPercentage - 1, PEERS_OFFLINE_PERCENT_MAXIMUM) // down to const
    mynode.restartFailures = 0
    return 0
  }

  // restart node processes
  mynode.offlineLimitPercentage = min(mynode.offlineLimitPercentage + 1, 100) // up to 100%
  mynode.restartFailures += 1
  await restartNodeProcess(mynode.restartFailures)

  console.log(`${getDate()} checking everything again`)
  // process.exit(0)

  // recheck offline peers again
  return runBotReconnect()
}

const restartNodeProcess = async (attempt = 1) => {
  console.log(`${getDate()} restartNodeProcess(): Attempt #${attempt}`)

  updateBotTimers({ lastNodeReset: Date.now() })

  // tor restarting shell command here or

  // create request file for separate script to run with sudo permission
  // when it sees request file it will execute the action and erase the request file
  const RESET_REQUEST_PATH = 'resetRequest.json' // create this file to reset node
  const requestTime = Date.now()
  fs.writeFileSync(RESET_REQUEST_PATH, JSON.stringify({ requestTime }))

  // give it a LOT of time (could be lots of things updating)
  // double the time after each failure
  const maxResetBackoff = 12 * hours // 12h
  const minResetBackoff = MIN_WAIT_MINUTES_FOR_NODE_RESTART * minutes // eg 21 min
  const msWaitingTime = min(minResetBackoff * pow(2, attempt - 1), maxResetBackoff)

  await telegramLog(`💤 Restarting node processes with wait time of ${(msWaitingTime / minutes).toFixed(0)} minutes`)
  await sleep(msWaitingTime) // long to reset node

  if (fs.existsSync(RESET_REQUEST_PATH)) {
    console.log(
      `${getDate()} restartNodeProcess() reset did not happen, request file still there. no resetHandler script running?`
    )
    process.exit(1)
  } else {
    console.log(`${getDate()} restartNodeProcess() request file is gone so assuming reset is complete after waiting`)
  }

  // re-initialize lnd access
  await bos.initializeAuth() // this waits for it to be fully online now
  return true
}

// const subtractSafety = ppm => trunc(max(min(ppm - SAFETY_MARGIN_FLAT_MAX, ppm / SAFETY_MARGIN), 0))
// const addSafety = ppm => trunc(max(ppm + SAFETY_MARGIN_FLAT_MAX, ppm * SAFETY_MARGIN))

const addSafety = ppm => trunc(min(ppm * SAFETY_MARGIN + 1, ppm + SAFETY_MARGIN_FLAT_MAX))
const subtractSafety = ppm => trunc(max((ppm - 1) / SAFETY_MARGIN, ppm - SAFETY_MARGIN_FLAT_MAX, 0))

// result offset via "+ nudge * 100" should help lift ppm from 0 & scale with nudge
const stepUpFee = (ppm, nudge) => ppm * (1 + nudge) + nudge * 100
// trunc will speed up moves down to at least -1ppm
const stepDownFee = (ppm, nudge) => trunc(ppm * (1 - nudge))

// return recorded reference fee rate (actual fee rate can be higher to block routing)
// or fall back to actual fee rate in channel
const getReferenceFee = p => trunc(readRecord(p.public_key)?.ppmFloat ?? p.fee_rate)

// if (isIncreasing) ppmNewFloat = ppmNewFloat * (1 + modifiedNudgeUp)
// else if (isDecreasing) ppmNewFloat = trunc(ppmNewFloat * (1 - NUDGE_DOWN))

const isRemoteHeavy = p => p.unbalancedSatsSigned < -MIN_SATS_OFF_BALANCE

const isLocalHeavy = p => p.unbalancedSatsSigned > MIN_SATS_OFF_BALANCE

const isNetOutflowing = p => p.routed_out_msats - p.routed_in_msats > 0

const isNetInflowing = p => p.routed_out_msats - p.routed_in_msats < 0

// very remote heavy = very few sats on local side, the less the remote-heavier
const isVeryRemoteHeavy = p => p.outbound_liquidity < MIN_SATS_PER_SIDE
// very local heavy = very few sats on remote side, the less the local-heavier
const isVeryLocalHeavy = p => p.inbound_liquidity < MIN_SATS_PER_SIDE

// used to see if channel is unfit to handle routing out anymore
const isDrained = p => p.outbound_liquidity < SATS_PER_SIDE_DRAINED_LIMIT

const seconds = 1000
const minutes = 60 * seconds
const hours = 60 * minutes
const days = 24 * hours

const daysAgo = ts => (Date.now() - ts) / days
const minutesAgo = ts => (Date.now() - ts) / minutes

const pretty = n => String(trunc(n || 0)).replace(/\B(?=(\d{3})+\b)/g, '_')

const getDate = timestamp => (timestamp !== undefined ? new Date(timestamp) : new Date()).toISOString()
const getDay = () => new Date().toISOString().slice(0, 10)

const fixJSON = (k, v) => (v === undefined ? null : v)

const unique = arr => Array.from(new Set(arr))

const isEmpty = obj => !!obj && Object.keys(obj).length === 0 && obj.constructor === Object
const isNotEmpty = obj => !isEmpty(obj)

const logDim = (...args) => console.log(`${getDate()} ${dim}${args.join(' ')}${undim}`)

// rounds down to nearest power of 10
// const floor10 = v => pow(10, floor(log10(v)))
// rounds down to nearest power of 2
const floor2 = v => pow(2, floor(log2(v)))

const sizeMaxHTLC = peer => {
  const rule = getRuleFromSettings({ peer })
  const ruleMaxHTLC = rule?.max_htlc_sats ?? pow(2, 24) // most compatible max (wumbo size)

  return peer.ids?.reduce((final, channel) => {
    const { local_balance } = channel
    // shouldn't happen
    if (local_balance === undefined) return final

    // round down to nearest 2^X for max htlc to minimize failures and hide exact balances
    const safeHTLC = min(ruleMaxHTLC, max(1, floor2(local_balance))) * 1000
    final[channel.id] = { max_htlc_mtokens: safeHTLC }

    // logDim(`  ${channel.id} max htlc safe size to be set to ${pretty(safeHTLC / 1000)} sats`)

    return final
  }, {})
}

// if quiet nothing is printed and exit request isn't checked
const sleep = async (ms, { msg = '', quiet = false } = {}) => {
  if (quiet) return await new Promise(resolve => setTimeout(resolve, trunc(ms)))

  const secondsDelay = ms / seconds
  const minutesDelay = ms / minutes
  const t = minutesDelay >= 1 ? minutesDelay.toFixed(1) + ' minutes' : secondsDelay.toFixed(1) + ' seconds'
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

const printMemoryUsage = text => {
  if (!SHOW_RAM_USAGE) return null

  const memUse = process.memoryUsage()
  const totalString = (memUse.heapTotal / 1024 / 1024).toFixed(0)
  const usedString = (memUse.heapUsed / 1024 / 1024).toFixed(0)
  const externalString = (memUse.external / 1024 / 1024).toFixed(0)
  const rssString = (memUse.rss / 1024 / 1024).toFixed(0)

  logDim(
    `Using ${totalString} heapTotal & ${usedString} MB heapUsed & ${externalString} MB external & ${rssString} MB resident set size. ${text}`
  )
  return { ...memUse, usedString, totalString, externalString, rssString }
}

// clean alias from emoji & non standard characters
const ca = alias => (alias || '').replace(/[^\x00-\x7F]/g, '').trim() // .replace(/[\u{0080}-\u{10FFFF}]/gu,'');

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
    top: f(tr(sorted[sorted.length - 1]))
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
