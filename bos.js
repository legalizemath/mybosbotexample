/*
  Wrapper for balanceofsatoshis installed globally
  Needs node v14+, check: node -v, using v16.13.2
  Installed/updated with `npm i -g balanceofsatoshis@12.16.3`
  Global install linked locally via `npm link balanceofsatoshis`

  It's unofficial independent wrapper so if anything changes this can break.
  (e.g. changes in ln-service or bos functions, parameter names, output)
  I just add wrappers here on need-to basis and some parts become abandoned.
*/

import {
  fetchRequest
  // callRawApi
} from 'balanceofsatoshis/commands/index.js'
import fetch from 'balanceofsatoshis/node_modules/@alexbosworth/node-fetch/lib/index.js'
import { readFile } from 'fs'
import lnd from 'balanceofsatoshis/lnd/index.js'
import lnServiceRaw from 'balanceofsatoshis/node_modules/ln-service/index.js'

import {
  adjustFees as bosAdjustFees,
  getFeesChart as bosGetFeesChart,
  getChainFeesChart as bosGetChainFeesChart,
  getFeesPaid as bosGetFeesPaid
} from 'balanceofsatoshis/routing/index.js'

// import { rebalance as bosRebalance } from 'balanceofsatoshis/swaps/index.js'
import { manageRebalance as bosRebalance } from 'balanceofsatoshis/swaps/index.js'

import {
  getDetailedBalance as bosGetDetailedBalance,
  getBalance as bosGetBalance
} from 'balanceofsatoshis/balances/index.js'

import {
  pushPayment as bosPushPayment,
  reconnect as bosReconnect,
  getPeers as bosGetPeers,
  getForwards as bosGetForwards
} from 'balanceofsatoshis/network/index.js'

const { trunc, min, ceil } = Math

// reused authentication object or making new ones uses up a TON of memory
// re-initialize if node restarts with bos.initializeAuth()
let authed

// this method updates authentication object from global bos authentication
// WARNING:
// calling await lnd.authenticatedLnd({}) each time uses up some RAM
// recalling this method doesn't seem to let go of previous RAM
// # of times this is called must be kept low as each call leaks memory
const mylnd = async () => {
  authed = (await lnd.authenticatedLnd({})).lnd
  return authed
}
// max MB RAM script can use, above terminated for memory leak
const MAX_RAM_USE_MB = 250
// This ms delay is longest it will ever back off from retrying if auth fails
const MAX_RETRY_DELAY = 21 * 60 * 1000 // 21 minutes

// data from bos balance --detailed with onchain_confirmed from bos balance --onchain --confirmed
// returns {
//   closing_balance, conflicted_pending, invalid_pending, offchain_balance,
//   offchain_pending, onchain_confirmed, onchain_pending, onchain_vbytes,
//   utxos_count
// }
const getDetailedBalance = async (choices = {}, log = false) => {
  try {
    log && logDim(`${getDate()} bos.getDetailedBalance()`)
    const res = await bosGetDetailedBalance({
      lnd: authed ?? (await mylnd()), // required
      ...choices
    })
    log && console.log(`${getDate()} bos.getDetailedBalance(): bos balance --detailed complete`, res)

    // coop open channel created odd external utxo that is counted above in current version
    // --onchain flag however correctly excludes it
    const resOnChain = await bosGetBalance({
      lnd: authed ?? (await mylnd()),
      is_onchain_only: true,
      is_confirmed: true
    })
    log && console.log(`${getDate()} bos.getDetailedBalance(): bos balance --onchain complete`, resOnChain)

    return {
      ...removeStyling(res),
      onchain_confirmed: (resOnChain.balance * 1e-8).toFixed(8), // overwrite broken output
      channel_balance: resOnChain.channel_balance // might as well include
    }
  } catch (e) {
    console.error(`\n${getDate()} bos.getDetailedBalance() aborted.`, e?.message || e)
    return {}
  }
}

// returns {description, title, data: []}
const getFeesPaid = async (choices = {}, log = false) => {
  try {
    log && logDim(`${getDate()} bos.getFeesPaid()`)
    const res = await bosGetFeesPaid({
      lnds: [authed ?? (await mylnd())], // required
      days: 30,
      // is_most_forwarded_table: // ?
      // is_most_fees_table: // ?
      // is_network: // ?
      // is_peer: // ?
      ...choices
    })
    log && console.log(`${getDate()} bos.getFeesPaid() complete`, res)
    return res
  } catch (e) {
    console.error(`\n${getDate()} bos.getFeesPaid() aborted.`, e?.message || e)
    return {}
  }
}

// returns {description, title, data: []}
const getFeesChart = async (choices = {}, log = false) => {
  try {
    log && logDim(`${getDate()} bos.getFeesChart()`)
    const res = await bosGetFeesChart({
      lnds: [authed ?? (await mylnd())], // required
      days: 30,
      is_count: false,
      fs: { getFile: readFile },
      // via: <public key>
      ...choices
    })
    log && console.log(`${getDate()} bos.getFeesChart() complete`, res)
    return res
  } catch (e) {
    console.error(`\n${getDate()} bos.getFeesChart() aborted.`, e?.message || e)
    return {}
  }
}

// pay an invoice/request (bolt-11)
/*
  {
    avoid: [<Avoid Forwarding Through String>]
    [fs]: {
      getFile: <Read File Contents Function> (path, cbk) => {}
    }
    [in_through]: <Pay In Through Node With Public Key Hex String>
    lnd: <Authenticated LND API Object>
    logger: <Winston Logger Object>
    max_fee: <Max Fee Tokens Number>
    max_paths: <Maximum Paths Number>
    [message]: <Message String>
    out: [<Out Through Peer With Public Key Hex String>]
    request: <BOLT 11 Payment Request String>
  }
  */

// returns {description, title, data: []}
const getChainFeesChart = async (choices = {}, log = false) => {
  try {
    log && logDim(`${getDate()} bos.getChainFeesChart()`)
    const res = await bosGetChainFeesChart({
      lnds: [authed ?? (await mylnd())], // required
      days: 30,
      is_monochrome: true,
      request,
      ...choices
    })
    log && console.log(`${getDate()} bos.getChainFeesChart() complete`, res)
    return res
  } catch (e) {
    console.error(`\n${getDate()} bos.getChainFeesChart() aborted.`, e?.message || e)
    return { data: [] }
  }
}

const forwards = async (choices = {}, log = false) => {
  try {
    log && logDim(`${getDate()} bos.forwards()`)
    const res = await bosGetForwards({
      lnd: authed ?? (await mylnd()), // required
      fs: { getFile: readFile }, // required
      days: 1,
      // [from: public key]
      // [to: public key]
      ...choices
    })
    log && console.log(`${getDate()} bos.forwards() complete`, res)
    return res.peers
  } catch (e) {
    console.error(`\n${getDate()} bos.forwards() aborted.`, e?.message || e)
    return []
  }
}

const reconnect = async (log = false) => {
  try {
    log && logDim(`${getDate()} bos.reconnect()`)
    const res = await bosReconnect({
      lnd: authed ?? (await mylnd())
    })
    log && console.log(`${getDate()} bos.reconnect() complete`, res)
    return res
  } catch (e) {
    console.error(`\n${getDate()} bos.reconnect() aborted.`, e?.message || e)
  }
}

const rebalance = async (
  { fromChannel, toChannel, maxSats = 1, maxMinutes = 3, maxFeeRate = 1, avoid = [], retryAvoidsOnTimeout = 0 },
  choices = {},
  log = { details: false, progress: true }
) => {
  try {
    // change to internal key names, add overwrites in choices
    const options = {
      out_through: fromChannel, // public key
      in_through: toChannel, // public key
      max_rebalance: String(trunc(maxSats)), // sats
      timeout_minutes: trunc(maxMinutes), // minutes
      max_fee_rate: trunc(maxFeeRate), // max fee rate
      max_fee: trunc(maxSats * 0.05), // 5% just in case
      avoid,
      // out_channels: [],
      // in_outound: undefined,
      // out_inbound: undefined,
      ...choices
    }
    log?.details && logDim(`${getDate()} bos.rebalance()`, JSON.stringify(options))
    if (fromChannel === toChannel) throw new Error('fromChannel same as toChannel')
    const res = await bosRebalance({
      fs: { getFile: readFile }, // required
      lnd: authed ?? (await mylnd()), // required
      logger: logger(log),
      out_channels: [], // seems necessary
      ...options
    })
    log?.progress && console.log('')
    log?.details && console.log(`\n${getDate()} bos.rebalance() success:`, JSON.stringify(res))
    const finalFeeRate = +res.rebalance[2]?.rebalance_fee_rate.match(/\((.*)\)/)[1]
    // bos just shows down to sats
    const finalAmount = trunc(+res.rebalance[2].rebalanced * 1e8)
    const feeSpent = trunc(+res.rebalance[2].rebalance_fees_spent * 1e8)
    return {
      // failed: false,
      fee_rate: finalFeeRate, // parts per million spent on fee
      rebalanced: finalAmount, // total sats sent
      msg: res, // bos response

      arrived: finalAmount - feeSpent, // amount arrived at destination
      sent: finalAmount, // total sats sent|spent from source
      fee: feeSpent // sats paid for fee

      // ppmSuggested: null
    }
    // e.g. {"fee_rate":250,"rebalanced":100025,"msg":{"rebalance":[{"increased_inbound_on":"ZCXZCXCZ","liquidity_inbound":"0.07391729","liquidity_outbound":"0.07607982"},{"decreased_inbound_on":"ASDASDASD","liquidity_inbound":"0.01627758","liquidity_outbound":"0.00722753"},{"rebalanced":"0.00100025","rebalance_fees_spent":"0.00000025","rebalance_fee_rate":"0.03% (250)"}]}}'
  } catch (e) {
    log?.progress && console.log('')
    log?.details && console.error(`\n${getDate()} bos.rebalance() aborted.`, e?.message || e)

    // if we're retrying on timeouts & avoid wasn't used, rerun again with avoid of low fees
    if (retryAvoidsOnTimeout && e[1] === 'ProbeTimeout') {
      retryAvoidsOnTimeout-- // 1 less retry left now
      const oldAvoidPpm = +(avoid[0] || '').match(/FEE_RATE<(.+?)\//)?.[1] || 0
      // each new retry moves avoid fee rate 25% closer to half max total fee rate
      const newAvoidPpm = trunc(oldAvoidPpm * 0.75 + (maxFeeRate / 2) * 0.25)
      const newAvoid = `FEE_RATE<${newAvoidPpm}/${toChannel}`

      const pkToAlias = await getPublicKeyToAliasTable()
      const alias = ca(pkToAlias[toChannel] || '')

      logDim(
        `${getDate()} Retrying bos.rebalance after ProbeTimeout error @ ${maxFeeRate} maxFeeRate with --avoid FEE_RATE<${newAvoidPpm}` +
          ` to self through ${alias} ${toChannel.slice(0, 10)}. Retries left: ${retryAvoidsOnTimeout}`
      )

      // for simplicity will always overwrite or create first item in avoid array
      if ((avoid[0] || '').includes('FEE_RATE<')) avoid[0] = newAvoid
      else avoid.unshift(newAvoid)
      // continue as retry
      return await rebalance(
        { fromChannel, toChannel, maxSats, maxMinutes, maxFeeRate, avoid, retryAvoidsOnTimeout },
        choices,
        log
      )
    }

    // provide suggested ppm if possible
    const ppmSuggested = e[1] === 'RebalanceFeeRateTooHigh' ? +e[2].needed_max_fee_rate : null
    return {
      failed: true,
      // fee_rate: null,
      // rebalanced: null,
      msg: e, // bos response

      // arrived, // amount arrived at destination
      // sent, // total sats sent|spent from source
      // fee, // sats paid for fee

      ppmSuggested // fee rate suggested
    }
  }
}

const send = async (
  {
    destination, // public key or lnurl or lighting address, kind of important
    destinationPubKey = destination, // if above is not pubkey, this should be
    fromChannel = undefined, // public key
    toChannel = undefined, // public key
    sats = 1, // how much needs to arrive at destination
    maxMinutes = 5,
    maxFeeRate = undefined, // ppm, rounded up to next sat
    // use smaller of these fee limits:
    maxFee = undefined, // max fee sats, 1 sat fee per 1 sat arriving somewhere is default max
    message = undefined, // string to send (reveals sender unless is_omitting_message_from = true)
    // retryAvoidsOnTimeout = 0
    avoid = [],
    isRebalance = false, // double checks in/out peers specified to avoid using same for both
    is_omitting_message_from = false, // old default to include your key in messages
    retryAvoidsOnTimeout = 0,
    otherArgs = {} // additional arguments to add to bos pushPayment
  },
  log = { details: false, progress: true },
  isRetry = false
) => {
  try {
    const unspecifiedFee = maxFee === undefined && maxFeeRate === undefined
    if (unspecifiedFee) throw new Error('need to specify maxFeeRate or maxFee')
    const isPubkey = str => str.length === 66 && /^[A-F0-9]+$/i.test(str)
    if (!isPubkey(destination) && !isPubkey(destinationPubKey)) {
      throw new Error('destination or destinationPubKey must be a pubkey (66char hex)')
    }
    maxFee = maxFee ?? ceil(0.1 * sats) // 10% fallback if unspecified
    maxFeeRate = maxFeeRate ?? trunc(((1.0 * maxFee) / sats) * 1e6)
    const options = {
      destination,
      out_through: fromChannel,
      in_through: toChannel,
      amount: String(trunc(sats)),
      timeout_minutes: trunc(maxMinutes),
      // uses max fee (sats) only so calculated from max fee rate (ppm)
      max_fee: min(
        ceil((sats * maxFeeRate) / 1e6), // from fee rate rounded up to next sat
        maxFee // from max fee in exact sats
      ),
      message,
      is_omitting_message_from,
      ...otherArgs
    }

    log?.details && logDim(`${getDate()} bos.send() to ${destination}`, JSON.stringify(options))

    if (fromChannel === toChannel && toChannel !== undefined) throw new Error('fromChannel same as toChannel')
    if (isRebalance && !(fromChannel && toChannel)) throw new Error('need to specify both "from" and "to" channels')

    const res = await bosPushPayment({
      lnd: authed ?? (await mylnd()),
      logger: logger(log),
      fs: { getFile: readFile }, // required
      avoid, // required
      is_dry_run: false, // required
      quiz_answers: [], // required
      request,
      ...options
    })
    log?.progress && console.log('')
    log?.details && console.log(`\n${getDate()} bos.send() success:`, JSON.stringify(res))
    const sent = +res.paid
    const arrived = +res.paid - +res.fee
    const totalFee = +res.fee
    return {
      // failed: false,
      fee_rate: trunc(((1.0 * totalFee) / arrived) * 1e6),
      msg: res, // bos info

      arrived, // amount arrived at destination
      sent, // total sent (spent) including fee
      fee: totalFee

      // ppmSuggested: null
    }
    // example of successful payment res
    /*
    {"fee":1,"id":"aaaaaaaaaaaaaccccccccccccddddddddddeeeeeeeeeeee","latency_ms":17543,"paid":1001,"preimage":"fffffffffffffgggggggggggggghhhhhhhhhhhhhhhhiiiiiiiiiiiii","relays":["030c3f19d742ca294a55c00376b3b355c3c90d61c6b6b39554dbc7ac19b141c14f","0260fab633066ed7b1d9b9b8a0fac87e1579d1709e874d28a0d171a1f5c43bb877","0340796fc55aec99d8f142659cd67e19080100a98ea14e8916525789b57e054eb3","03d1e805c38257b713340049745ff5a15d9ee5d733517a1d48a956815c9482055c"],"success":["696272x1444x1","679020x1484x0","687689x770x1","694601x1655x0"]}
    */
  } catch (e) {
    log?.progress && console.log('')
    log?.details && console.error(`\n${getDate()} bos.send() aborted.`, e?.message || e)

    // just max fee suggestions so convert to ppm
    // e.g. [400,"MaxFeeLimitTooLow",{"needed_fee":167}]

    // if someone JUST changed fee try again just 1 more time
    if (!isRetry && e[1] === 'FeeInsufficient') {
      logDim(`\n${getDate()} retrying bos.send just once after FeeInsufficient error`)
      return await send(
        {
          destination,
          destinationPubKey,
          fromChannel,
          toChannel,
          sats,
          maxMinutes,
          maxFeeRate,
          maxFee,
          message,
          avoid,
          isRebalance,
          retryAvoidsOnTimeout
        },
        log,
        true // mark it as a retry
      )
    }

    // handle timeout retries if used, increment avoid filter each time
    // towards half of max fee rate
    if (retryAvoidsOnTimeout && e[1] === 'ProbeTimeout') {
      // if rebalance, we look at fee into last peer node (fee to ourselves can't change)
      // if not rebalance, we look at fee into destination
      const avoidFeeTowardsThisPubkey = isRebalance && toChannel ? toChannel : destinationPubKey

      // removed && avoid.length <= 1
      retryAvoidsOnTimeout-- // 1 less retry left now
      const oldAvoidPpm = +(avoid[0] || '').match(/FEE_RATE<(.+?)\//)?.[1] || 0
      // each new retry moves avoid fee rate 25% closer to half max total fee rate
      const newAvoidPpm = trunc(oldAvoidPpm * 0.75 + (maxFeeRate / 2) * 0.25)
      const newAvoid = `FEE_RATE<${newAvoidPpm}/${avoidFeeTowardsThisPubkey}`

      const pkToAlias = await getPublicKeyToAliasTable()
      const alias = ca(pkToAlias[avoidFeeTowardsThisPubkey] || '')

      logDim(
        `${getDate()} Retrying bos.send after ProbeTimeout error @ ${maxFeeRate} maxFeeRate with --avoid FEE_RATE<${newAvoidPpm}` +
          ` to ${alias} ${avoidFeeTowardsThisPubkey.slice(0, 10)}. Retries left: ${retryAvoidsOnTimeout}`
      )
      // for simplicity will always overwrite or create first item in avoid array
      if ((avoid[0] || '').includes('FEE_RATE<')) avoid[0] = newAvoid
      else avoid.unshift(newAvoid)
      // continue as retry
      return await send(
        {
          destination,
          destinationPubKey,
          fromChannel,
          toChannel,
          sats,
          maxMinutes,
          maxFeeRate,
          maxFee,
          message,
          avoid,
          isRebalance,
          retryAvoidsOnTimeout
        },
        log,
        isRetry
      )
    }

    // sometimes reputations get ruined by broken nodes, helps to reset those rarely
    // if (e[1] === 'UnexpectedSendPaymentFailure') {
    //   // 1 every 1000 on avg chance
    //   if (random() < 0.001) await callAPI('deleteforwardingreputations')
    // }

    // failed
    const suggestedFeeRate = e[1] === 'MaxFeeLimitTooLow' ? ceil(((1.0 * +e[2].needed_fee) / sats) * 1e6) : null
    return {
      failed: true,
      // fee_rate,
      msg: e,

      // arrived,
      // sent,
      // fee,

      ppmSuggested: suggestedFeeRate
    }
  }
}
// more accurate name as option
const keysend = send
// keysend specifically for rebalances so regular easier to use for actual sends
const keysendRebalance = (choices, logging, isRetry) => send({ ...choices, isRebalance: true }, logging, isRetry)

// returns new set fee
const setFees = async (peerPubKey, fee_rate, log = false) => {
  try {
    log && logDim(`${getDate()} bos.setFees()`)
    const res = await bosAdjustFees({
      fs: { getFile: readFile }, // required
      lnd: authed ?? (await mylnd()),
      logger: {}, // logger not used
      to: [peerPubKey], // array of pubkeys to adjust fees towards
      fee_rate: String(fee_rate) // pm rate to set
    })
    const newFee = res.rows[1][1]?.match(/\((.*)\)/)[1]
    log && console.log(`${getDate()} bos.setFees()`, JSON.stringify(res), newFee)
    return +newFee
  } catch (e) {
    console.error(`${getDate()} bos.setFees() aborted.`, e)
    return {}
  }
}

// helpful wrapper to re-use bos auth if not provided
// also handle errors via try/catch
// returns null on error, otherwise response || empty object
const lnServiceWrapped = {}
for (const cmd in lnServiceRaw) {
  lnServiceWrapped[cmd] = async (arg1, ...otherArgs) => {
    try {
      // if lnd auth was provided use it, otherwise try using bos one
      if (typeof arg1 === 'object' && 'lnd' in arg1) {
        return (await lnServiceRaw[cmd](arg1, ...otherArgs)) || {}
      } else {
        const arg1_mod = { ...arg1, lnd: authed ?? (await mylnd()) }
        return (await lnServiceRaw[cmd](arg1_mod, ...otherArgs)) || {}
      }
    } catch (e) {
      const argsUsed = [{ ...arg1, lnd: undefined }, ...otherArgs]
      logDim(`${getDate()} wrapped lnService.${cmd}${JSON.stringify(argsUsed)} aborted.`, e?.message || e)
      return null
    }
  }
}
const lnService = lnServiceWrapped

// just calls lnService directly using bos authorization
// get method spelling, options, and expected output here:
// https://github.com/alexbosworth/ln-service/blob/master/README.md#all-methods
// instead of bos.callAPI('getChannels', { is_public: true })
// can also do bos.lnService.getChannels({ lnd, is_public: true })
// null on error
const callAPI = async (method, choices = {}, log = false) => {
  try {
    // for compatibility w/ old method, e.g. 'getpeers' in ln-service has to be 'getPeers'
    ;[['getpeers', 'getPeers']].forEach(r => {
      if (r[0] === method) method = r[1]
    })
    log && logDim(`${getDate()} lnService.${method}()`)
    // handle bad calls
    if (!(method in lnService)) throw new Error(`method ${method} doesn't exist in lnService`)
    const res = await lnServiceRaw[method]({
      lnd: authed ?? (await mylnd()),
      ...choices
    })
    return res || {}
    // empty object if nothing good yet without caught errors
  } catch (e) {
    logDim(`${getDate()} lnService.${method}(), ${JSON.stringify(choices)}) aborted.`, e?.message || e)
    return null
  }
}
const call = callAPI

const find = async (query, log = false) => {
  try {
    log && logDim(`${getDate()} bos.find('${query}')`)
    return await lnd.findRecord({
      lnd: authed ?? (await mylnd()),
      query
    })
  } catch (e) {
    console.error(`${getDate()} bos.find('${query}') aborted.`, e)
    return null
  }
}

/**
 * Direct call to bos peers. Use default filters with peers() or show all with peers({}).
 * See source reference for additional filters.
 * Reference: https://github.com/alexbosworth/balanceofsatoshis/blob/master/network/get_peers.js
 * @param {Object} choices
 * @param {Boolean|undefined} [choices[].is_active = true] - show only if has active channels
 * @param {Boolean|undefined} [choices[].is_public = true] - show only if has public channels
 * @param {Boolean|undefined} [choices[].is_private = undefined] - show only if has private channels
 * @param {Boolean|undefined} [choices[].is_offline = undefined] - show only offline peers
 * @param {Boolean} [log = false] - log to console
 * @returns (Object[]|null) - array of peers or null on error
 */
const peers = async (
  choices = {
    // defaults
    is_active: true, // only connected peers
    is_public: true // only public channels
  },
  log = false
) => {
  try {
    log && logDim(`${getDate()} bos.peers()`)
    const res = await bosGetPeers({
      fs: { getFile: readFile }, // required
      lnd: authed ?? (await mylnd()), // required
      omit: [], // required
      ...choices
    })
    const foundPeers =
      res?.peers
        // convert fee rate to just ppm
        ?.map(peer => ({
          ...peer,
          inbound_fee_rate: +peer.inbound_fee_rate?.match(/\((.*)\)/)?.[1] || null
        })) || null

    log && console.log(`${getDate()} bos.peers()`, JSON.stringify(peers, fixJSON, 2))
    return foundPeers
    /* typical result
    {
      alias: 'some alias',
      fee_earnings: undefined,
      downtime_percentage: undefined,
      first_connected: '7 months ago',
      last_activity: undefined,
      inbound_fee_rate: 153,
      inbound_liquidity: 3852992,
      is_forwarding: undefined,
      is_inbound_disabled: undefined,
      is_offline: undefined,
      is_pending: undefined,
      is_private: undefined,
      is_small_max_htlc: undefined,
      is_thawing: undefined,
      outbound_liquidity: 1146107,
      public_key: '555555555555555555555555555555555555555555555555'
    }
    */
  } catch (e) {
    console.error(`${getDate()} bos.peers() aborted.`, e)
    return null
  }
}

// way to get fees faster than from gossip info (e.g. getNode), which updates slower
const getFees = async ({ both = false }, log = false) => {
  log && logDim(`${getDate()} bos.getFees()`)
  const idToPubkey = await getIdToPublicKeyTable()
  const feesForChannelIds = (await lnService.getFeeRates())?.channels
  if (!feesForChannelIds || !idToPubkey) {
    console.error(`${getDate()} bos.getFees() failed to fetch data`)
    return null
  }
  const result = {}
  for (const channel of feesForChannelIds) {
    const pubKey = idToPubkey[channel.id]
    result[pubKey] = both
      ? {
          base_fee_mtokens: +channel.base_fee_mtokens || 0,
          fee_rate: +channel.fee_rate || 0
        }
      : +channel.fee_rate || 0
  }
  return result
}

// ------------- custom frequently used functions -------------

// get node info, https://github.com/alexbosworth/ln-service#getnode
const getNodeFromGraph = async ({ public_key, is_omitting_channels = true }, log = false) => {
  log && logDim(`${getDate()} bos.getNodeFromGraph()`)
  try {
    const res = await callAPI('getNode', { public_key, is_omitting_channels })
    return res
  } catch (e) {
    console.error(`${getDate()} bos.getNodeFromGraph() aborted.`, e)
    return null
  }
}

// token looks like adsfasfdsf:adsfsadfasdfasfasdfasfd-asdfsf
// chat_id looks like 1231231231
const sayWithTelegramBot = async ({ token, chat_id, message, parse_mode = 'HTML' }, log = false) => {
  // parse_mode can be undefined, or 'MarkdownV2' or 'HTML'
  // https://core.telegram.org/bots/api#html-style
  const parseModeString = parse_mode ? `&parse_mode=${parse_mode}` : ''
  try {
    log && logDim(`${getDate()} bos.sayWithTelegramBot()`)
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage?chat_id=${chat_id}` +
        `&text=${encodeURIComponent(message)}${parseModeString}`
    )
    const fullResponse = await res.json()
    log && logDim(`${getDate()} bos.sayWithTelegramBot() result:`, JSON.stringify(fullResponse, null, 2))
    return fullResponse
  } catch (e) {
    console.error(`${getDate()} bos.sayWithTelegramBot() aborted.`, e)
    return null
  }
}

// bos call getForwards (and calls bos call getChannels)
// and returns by peer: {[public_keys]: [forwards]}
// or by time: [forwards]
// forwards look like this with my changes:
/*
  {
    created_at: '2021-09-10T14:31:44.000Z',
    fee: 34,
    fee_mtokens: 34253,
    incoming_channel: '689868x588x1',
    mtokens: 546018000,
    outgoing_channel: '689686x689x1',
    tokens: 546018,
    created_at_ms: 1631284304000,
    outgoing_peer: '03271338633d2d37b285dae4df40b413d8c6c791fbee7797bc5dc70812196d7d5c',
    incoming_peer: '037cc5f9f1da20ac0d60e83989729a204a33cc2d8e80438969fadf35c1c5f1233b'
  }
*/
const customGetForwardingEvents = async (
  {
    days = 1, // how many days ago to look back
    byInPeer = false, // use in-peers as keys instead of out-peers
    timeArray = false, // return as array of time points instead of object
    max_minutes_search = 2 // safety if takes too long
  } = {},
  log = false
) => {
  log && logDim(`${getDate()} bos.customGetForwardingEvents()`)

  const started = Date.now()
  const isRecent = t => Date.now() - Date.parse(t) < days * 24 * 60 * 60 * 1000

  const byPeer = {}
  const byTime = []

  const pageSize = 5000
  let page = 0

  // need a table to convert short channel id's to public keys
  const idToPublicKey = {}
  // from existing channels
  const getChannels = await callAPI('getChannels', {}, log)
  getChannels.channels.forEach(channel => {
    idToPublicKey[channel.id] = channel.partner_public_key
  })
  // also from closed channels which wouldn't be part of getChannels
  const getClosedChannels = await callAPI('getClosedChannels', {}, log)
  getClosedChannels.channels.forEach(channel => {
    idToPublicKey[channel.id] = channel.partner_public_key
  })

  while (Date.now() - started < max_minutes_search * 60 * 1000) {
    // get newer events
    const thisOffset = `{"offset":${pageSize * page++},"limit":${pageSize}}`
    const res = await callAPI('getForwards', { token: thisOffset })
    log && logDim(`${getDate()} this offset: ${thisOffset}`)

    const forwards = res.forwards || [] // new to old

    if (forwards.length === 0) break // done
    if (!isRecent(forwards[0].created_at)) continue // page too old

    forwards.reverse() // old to new

    for (const routed of forwards) {
      if (!isRecent(routed.created_at)) continue // next item

      const outPeer = idToPublicKey[routed.outgoing_channel] || 'unknown'
      const inPeer = idToPublicKey[routed.incoming_channel] || 'unknown'

      // switch to timestamp and public key
      routed.created_at_ms = Date.parse(routed.created_at)
      routed.outgoing_peer = outPeer
      routed.incoming_peer = inPeer
      routed.fee_mtokens = +routed.fee_mtokens || 0
      routed.mtokens = +routed.mtokens

      if (timeArray) {
        byTime.push(routed)
        continue
      }

      if (!byInPeer) {
        if (byPeer[outPeer]) byPeer[outPeer].push(routed)
        else byPeer[outPeer] = [routed]
      } else {
        if (byPeer[inPeer]) byPeer[inPeer].push(routed)
        else byPeer[inPeer] = [routed]
      }
    }
  }

  if (!timeArray) return byPeer
  return byTime
}

/*
  returns payment events, new to old [] of
  {
    destination: <public key string>
    created_at: <iso timestamp string>
    created_at_ms: <ms time stamp> // converted to int
    fee: <sats integer>
    fee_mtokens: <msats integer> // converted to int
    hops: [<public key strings>]
    id: <payment id hex>
    index: <number in database>
    is_confirmed: true (?)
    is_outgoing: true (?)
    mtokens: <msats integer paid> // converted to int
    request: (?)
    secret: <secret string hex>
    safe_fee: <int>
    safe_tokens: <int>
    tokens: <int>
    hops_details: [ // just for simplify: true
      {channel, channel_capacity, fee, fee_mtokens, forward, forward_mtokens, public_key, timeout}
      // mtokens converted to integer too
    ]
    attempts: // removed for simplify: true
  }
*/
const customGetPaymentEvents = async (
  {
    days = 1, // how many days ago to look back
    max_minutes_search = 2, // safety if takes too long
    simplify = true, // remove failed attempts to save space
    destination = undefined, // filter out by public key destination,
    notDestination = undefined // filter out all payments to this destination
  } = {},
  log = false
) => {
  log && logDim(`${getDate()} bos.customGetPaymentEvents()`)

  const started = Date.now()

  const isRecent = t => Date.now() - Date.parse(t) < days * 24 * 60 * 60 * 1000

  const byTime = []

  const pageSize = 5000
  let nextOffset

  const isTimedOut = () => {
    const inTime = Date.now() - started < max_minutes_search * 60 * 1000
    if (!inTime) {
      console.error(`${getDate()} bos.customGetPaymentEvents() timed out`)
    }
    return !inTime
  }

  while (!isTimedOut()) {
    // get newer events
    const res = await callAPI('getPayments', !nextOffset ? { limit: pageSize } : { token: nextOffset }, log)

    log && logDim(`${getDate()} this offset: ${nextOffset}, next offset: ${res.next}`)
    nextOffset = res.next
    const payments = res.payments || [] // new to old

    if (payments.length === 0) break // done
    if (!nextOffset) break // done
    if (!isRecent(payments[0].created_at)) break // pages now too old

    for (const paid of payments) {
      // beyond days back
      if (!isRecent(paid.created_at)) break

      // skip unwanted destinations
      if (destination && paid.destination !== destination) continue
      if (notDestination && paid.destination === notDestination) continue

      // unexpected messages
      if (paid.request) {
        log && console.log(`${getDate()} bos.customGetPaymentEvents() ??? request found`, paid)
      }
      if (paid.is_confirmed === false) {
        log && console.log(`${getDate()} bos.customGetPaymentEvents() ??? unconfirmed found`, paid)
        continue
      }

      // switch to timestamp and public key
      paid.created_at_ms = Date.parse(paid.created_at)
      paid.fee_mtokens = +paid.fee_mtokens || 0
      paid.mtokens = +paid.mtokens

      if (simplify) {
        // just relevant successful attempt kept
        paid.hops_details = paid.attempts
          .filter(a => a.is_confirmed)[0]
          .route.hops.map(h => ({
            ...h,
            fee_mtokens: +h.fee_mtokens,
            forward_mtokens: +h.forward_mtokens
          }))
        // get rid of giant fail-inclusive attempts list
        delete paid.attempts
      }

      byTime.push(paid)
    }
  }

  return byTime
}

/*
[{chain_address, cltv_delta, confirmed_at,
confirmed_index, created_at, description,
description_hash, expires_at, features,
id, index, is_canceled, is_confirmed,
is_held, is_private, is_push, mtokens,
payment, payments, received,
received_mtokens, request, secret,
tokens, created_at_ms, confirmed_at_ms}]
*/
const customGetReceivedEvents = async (
  {
    days = 1, // how many days ago to look back
    max_minutes_search = 2, // safety if takes too long
    idKeys = false // return object instead with ids as keys
  } = {},
  log = false
) => {
  log && logDim(`${getDate()} bos.customGetReceivedEvents()`)

  const started = Date.now()

  const isRecent = t => Date.now() - Date.parse(t) < days * 24 * 60 * 60 * 1000

  const byTime = []
  const byId = {}

  const pageSize = 5000
  let nextOffset

  const isTimedOut = () => {
    const inTime = Date.now() - started < max_minutes_search * 60 * 1000
    if (!inTime) {
      console.error(`${getDate()} bos.customGetReceivedEvents() timed out`)
    }
    return inTime
  }

  while (isTimedOut()) {
    // get newer events
    const res = await callAPI('getInvoices', !nextOffset ? { limit: pageSize } : { token: nextOffset }, log)

    log && logDim(`${getDate()} this offset: ${nextOffset}, next offset: ${res.next}`)
    nextOffset = res.next

    const payments = (res.invoices || []) // new to old
      .filter(p => p.is_confirmed) // just care about completed

    if (payments.length === 0) break // done
    if (!nextOffset) break // done

    // if entire page now too old
    if (!isRecent(payments[0].confirmed_at)) break

    for (const paid of payments) {
      // end if created before cut-off AND confirmed before cut-off
      if (!isRecent(paid.confirmed_at)) break

      // switch to timestamp and public key
      paid.created_at_ms = Date.parse(paid.created_at)
      paid.confirmed_at_ms = Date.parse(paid.confirmed_at)
      paid.received_mtokens = +paid.received_mtokens || 0
      paid.mtokens = +paid.mtokens || 0

      if (idKeys) byId[paid.id] = paid
      else byTime.push(paid)
    }
  }

  return idKeys ? byId : byTime
}

// gets node info and policies for every channel, slightly reformated
// if peer_key is provided, will only return channels with that peer
// if public_key not provided, will use this nodes public key
// byPublicKey will use peer public key as object keys and values will be arrach of all channels to that peer
// important: this seems to update much slower for your own node's new channels than callAPI('getFeeRates')
// uses https://github.com/alexbosworth/ln-service#getnode
const getNodeChannels = async ({ public_key, peer_key, byPublicKey = false } = {}) => {
  try {
    if (!public_key) public_key = (await callAPI('getIdentity')).public_key
    const res = await callAPI('getNode', { public_key, is_omitting_channels: false })
    // put remote public key directly into channels info
    // instead of channels being a random array, convert to object where channel id is key
    // instead of policies being array length 2 make it object with local: {}, and remote: {} data
    // so getting remote fee rate would be
    // res.channels[id].policy.remote.fee_rate
    // and remote public key would be
    // res.channels[id].public_key
    const betterChannels = res.channels.reduce((edited, channel) => {
      const outgoingPolicy = channel.policies.find(p => p.public_key === public_key)
      const incomingPolicy = channel.policies.find(p => p.public_key !== public_key)
      const remotePublicKey = incomingPolicy.public_key
      // if specific peer for this node was requested, ignore all other peer keys
      if (peer_key && peer_key !== remotePublicKey) return edited
      const keyToUse = byPublicKey ? remotePublicKey : channel.id
      if (byPublicKey) {
        if (!edited[keyToUse]) edited[keyToUse] = []
        // have to separate different channels to same public key in an array
        const n = edited[keyToUse].push(channel) // returns new array length
        edited[keyToUse][n - 1].local = outgoingPolicy
        edited[keyToUse][n - 1].remote = incomingPolicy
        edited[keyToUse][n - 1].public_key = remotePublicKey
        delete edited[keyToUse][n - 1].policies // don't need anymore
        return edited
      } else {
        edited[keyToUse] = channel
        edited[keyToUse].local = outgoingPolicy
        edited[keyToUse].remote = incomingPolicy
        edited[keyToUse].public_key = remotePublicKey
        delete edited[keyToUse].policies // don't need anymore
        return edited
      }
    }, {})
    return betterChannels
  } catch (e) {
    logDim(e?.message || e)
    return null
  }
}
const getNodePolicy = getNodeChannels // another name

// safer way to set channel policy to avoid default resets, no default values
// if by_channel_id is specified, looks at channel id keys  for specific settings
// by_channel_id: {'702673x1331x1': {max_htlc_mtokens: '1000000000' }}
const setPeerPolicy = async (newPolicy, log = false) => {
  const {
    peer_key,
    by_channel_id,
    base_fee_mtokens,
    fee_rate,
    cltv_delta,
    max_htlc_mtokens,
    min_htlc_mtokens,
    my_key
  } = newPolicy

  if (log) console.log(`${getDate()} setPeerPolicy()`, JSON.stringify(newPolicy, fixJSON))

  if (!peer_key) return 1
  let settings
  const fails = []
  try {
    // get my public key if not provided
    const me = my_key ?? (await callAPI('getIdentity')).public_key
    if (!me) return 1

    // get channels for my node with this peer
    const channels = await getNodeChannels({ public_key: me, peer_key })
    if (!channels) throw new Error('getNodeChannels returned nothing')
    if (Object.keys(channels).length === 0) {
      throw new Error('getNodeChannels returned {}, no current peer data')
    }

    log && console.log(`${getDate()} channels before changes: ${JSON.stringify(channels, fixJSON, 2)}`)

    // set settings for each channel with that peer & use ones provided to replace
    for (const channel of Object.values(channels)) {
      if (!channel || !channel.local || !channel.remote || !channel.transaction_id) {
        return 1
      }
      const byId = by_channel_id?.[channel.id]
      // updates seems to fail sometimes for max htlc above wumbo size ~16M completely so lets cap it there
      // also just in case cap below capacity with subtracted 1% reserve, whichever is smaller
      const capacity_msats = trunc(0.99 * channel.capacity * 1000)
      const wumbo_msats = 16777216 * 1000 // 2^24 * 1000
      let max_htlc_msats = +(byId?.max_htlc_mtokens ?? max_htlc_mtokens ?? channel.local.max_htlc_mtokens)
      max_htlc_msats = min(max_htlc_msats, capacity_msats, wumbo_msats)

      settings = {
        // channel to change:
        transaction_id: channel.transaction_id,
        transaction_vout: +channel.transaction_vout,
        // apply by descending priority: by-channel setting, overall setting, and then previous unchanged setting
        base_fee_mtokens: String(byId?.base_fee_mtokens ?? base_fee_mtokens ?? channel.local.base_fee_mtokens),
        fee_rate: +(byId?.fee_rate ?? fee_rate ?? channel.local.fee_rate),
        cltv_delta: +(byId?.cltv_delta ?? cltv_delta ?? channel.local.cltv_delta),
        min_htlc_mtokens: String(byId?.min_htlc_mtokens ?? min_htlc_mtokens ?? channel.local.min_htlc_mtokens),
        max_htlc_mtokens: String(max_htlc_msats)
      }

      // check if nothing changed
      const nothingChanged =
        settings.transaction_id === channel.transaction_id &&
        settings.transaction_vout === channel.transaction_vout &&
        settings.base_fee_mtokens === channel.base_fee_mtokens &&
        settings.fee_rate === channel.fee_rate &&
        settings.cltv_delta === channel.cltv_delta &&
        settings.min_htlc_mtokens === channel.min_htlc_mtokens &&
        settings.max_htlc_mtokens === channel.max_htlc_mtokens

      if (!nothingChanged) {
        log && console.log(`${getDate()} bos call updateRoutingFees`, settings)
        const res = await bos.callAPI('updateRoutingFees', settings)
        if (res?.failures?.length) {
          logDim(`${getDate()} bos call updateRoutingFees failures:`, JSON.stringify(res.failures))
          fails.push(...res.failures)
        }
      } else {
        log && console.log(`${getDate()} no policy changes necessary`)
      }
    }

    return fails
  } catch (e) {
    log && console.error('error:', e, 'with settings:', settings)
    fails.push(e)
    return fails
  }
}

// my bos call pay
const callPay = async (choices, log = false) => {
  log && logDim(`${getDate()} bos.call.pay() with ${JSON.stringify(choices)}`)
  const {
    invoice = null, // absolutely required
    maxFee = undefined, // max sats fee
    maxFeeRate = undefined, // max ppm fee rate
    maxMinutes = 1, // max waiting time
    maxPaths = undefined, // max paths to split between,
    fromChannels = undefined, // (Standard Channel Id Strings!) pay from these channels, array
    incomingPeer = undefined, // optional, pay through this peer (public key) on last hop
    options = {} // anything else
  } = choices

  // just abort if no invoice/request
  if (!invoice) {
    log && console.log(`${getDate()} bos.call.pay() request/invoice required`)
    return null
  }

  try {
    const parsedInvoice = lnServiceRaw.parsePaymentRequest({ request: invoice })
    const { tokens } = parsedInvoice

    // use smaller of constraints for fee
    const unspecifiedFee = maxFee === undefined && maxFeeRate === undefined
    if (unspecifiedFee) throw new Error('need to specify maxFeeRate or maxFee')
    const effectiveMaxFee = maxFee ?? ceil(0.1 * tokens) // max of 1 satoshi or 10% of sats sent as max fee
    const effectiveMaxFeeRate = maxFeeRate ?? trunc(((1.0 * maxFee) / tokens) * 1e6)
    const maxFeeUsed = min(effectiveMaxFee, ceil((tokens * effectiveMaxFeeRate) / 1e6))

    // https://github.com/alexbosworth/ln-service#pay
    const finalParams = {
      incoming_peer: incomingPeer,
      lnd: authed ?? (await mylnd()),
      max_fee: maxFeeUsed,
      max_paths: maxPaths,
      outgoing_channel: fromChannels && fromChannels.length === 1 ? fromChannels[0] : undefined,
      outgoing_channels: fromChannels && fromChannels.length > 1 ? fromChannels : undefined,
      request: invoice,
      pathfinding_timeout: trunc(maxMinutes * 60 * 1000),
      ...options
    }
    log && console.log(`${getDate()} bos.callPay(${JSON.stringify({ ...finalParams, lnd: undefined }, null, 2)})`)

    const res = await lnServiceRaw.pay(finalParams)

    log && console.log(`${getDate()} bos.callPay() complete`, res)
    return res
  } catch (e) {
    console.error(`\n${getDate()} bos.call.pay() aborted.`, e?.message || e)
    return null
  }
}

const getIdToPublicKeyTable = async () => {
  const table = {}
  // from existing channels
  try {
    const getChannels = await callAPI('getChannels')
    getChannels.channels.forEach(channel => {
      table[channel.id] = channel.partner_public_key
    })
  } catch (e) {}
  return table
}

const getPublicKeyToAliasTable = async () => {
  const table = {}
  try {
    // from existing channels
    const foundPeers = await peers({})
    foundPeers.forEach(p => {
      table[p.public_key] = p.alias
    })
  } catch (e) {}
  return table
}

const getIdToAliasTable = async () => {
  const table = {}
  const idToPublicKey = await getIdToPublicKeyTable()
  const publicKeyToAlias = await getPublicKeyToAliasTable()
  for (const id in idToPublicKey) {
    const pubkey = idToPublicKey[id]
    table[id] = publicKeyToAlias[pubkey]
  }
  return table
}

const getRemoteDisabledCount = async ({ public_key }) => {
  const policies = await bos.getNodeChannels({ public_key, byPublicKey: true })
  if (!policies) return null

  const theirChannelsByPeer = Object.values(policies)
  const totalPeers = theirChannelsByPeer.length
  // add up disables, just look at 1st channel for each peer
  let remoteDisabled = 0
  for (const channels of Object.values(policies)) {
    if (channels[0].remote.is_disabled) remoteDisabled++
  }
  return {
    totalPeers,
    remoteDisabled,
    remoteDisabledPercent: +((remoteDisabled / totalPeers) * 100).toFixed(0)
  }
}

// https://github.com/alexbosworth/ln-service#removepeer
const removePeer = async ({ public_key }, log = false) => {
  log && logDim(`${getDate()} bos.removePeer(${JSON.stringify({ public_key })}) `)
  try {
    const res = await lnServiceRaw.removePeer({
      lnd: authed ?? (await mylnd()),
      public_key
    })
    log && logDim(`${getDate()} bos.removePeer() done.`, JSON.stringify(res))
    return res
  } catch (e) {
    log && console.log('bos.removePeer() error:', e?.message || e)
    return null
  }
}

// tries to add a peer with { public_key }
// uses provided { socket } or pulls sockets from graph
// if peer is currently connected it will try to disconnect first
// https://github.com/alexbosworth/ln-service#addpeer
const addPeer = async (choices, log = false) => {
  const {
    public_key, // required
    socket, // optional, otherwise will try sockets in graph
    timeout = 21000 // Connection Attempt Timeout Milliseconds Number
  } = choices

  const TIME_DELAY_SECONDS = 2.1
  const sockets = []
  let shortKey = ''

  try {
    log && logDim(`${getDate()} bos.addPeer(${JSON.stringify(choices)})`)
    // must have public key
    if (!public_key) throw new Error('must provide { public_key }')
    shortKey = `${public_key.slice(0, 20)}...`
    // figuring out which socket to use (address:port)

    // check if we already have connection to this peer
    const { peers } = (await callAPI('getPeers')) ?? {}
    const thisPeer = peers.find(p => p.public_key === public_key)
    const isConnected = !!thisPeer

    // if no socket provided, get list of sockets from graph too
    if (socket) {
      sockets.push(socket)
    } else {
      // add current socket if already connected
      if (isConnected) sockets.push(thisPeer.socket)
      // add sockets from graph
      const graphSockets = (await getNodeFromGraph({ public_key }))?.sockets?.map(i => i.socket) ?? []
      sockets.push(...graphSockets)
    }

    if (!sockets) throw new Error(`${public_key} graph info not found`)
    if (!sockets.length) throw new Error(`${public_key} no socket info in graph`)

    // disconnect peer if already connected
    if (isConnected) {
      await removePeer({ public_key }, log)
      await sleep(TIME_DELAY_SECONDS * 1000)
    }

    for (let i = 0; i < sockets.length; i++) {
      if (i > 0) await sleep(TIME_DELAY_SECONDS * 1000)
      log &&
        logDim(`${getDate()} bos.addPeer(${shortKey}): ` + `trying socket ${i + 1}/${sockets.length}: ${sockets[i]}`)
      try {
        const res = await lnServiceRaw.addPeer({
          lnd: authed ?? (await mylnd()),
          public_key,
          socket: sockets[i],
          timeout,
          ...choices
        })
        log && logDim(`${getDate()} bos.addPeer(${shortKey}) connected`, res ?? '')
      } catch (addError) {
        log && logDim(`${getDate()} bos.addPeer(${shortKey}) connection attempt failed:`, JSON.stringify(addError))
        // error means move onto next socket, if any available
        continue
      }
      // no add peer error means it's connected
      return sockets[i]
    }
    // every socket must have failed
    throw new Error(`${public_key} failed to connect on all sockets (${sockets.length})`)
  } catch (e) {
    log && logDim(`${getDate()} bos.addPeer(${shortKey}) aborted.`, e?.message || e)
    return null
  }
}

// initialize authentication object, includes checks to make sure it worked before returning
const initializeAuth = async (
  {
    providedAuth = undefined,
    retryDelay = 10000 // initial delay for retry
  } = {},
  log = true
) => {
  log && logDim(`${getDate()} bos.initializeAuth(${providedAuth ? 'provided auth' : ''})`)

  try {
    if (!providedAuth) authed = await mylnd()
    if (providedAuth) authed = providedAuth

    // doing command checks to see if node is responsive:

    const height = await callAPI('getHeight') // does it know blockchain info
    if (!height) throw new Error('node not ready (getHeight failed)')
    sleep(100)

    const pk = await callAPI('getIdentity') // does it know its own identity
    if (!pk) throw new Error('node not ready (getIdentity failed)')
    sleep(100)

    const currentPeers = await peers({}) // does it know its peers
    if (!currentPeers) throw new Error('node not ready (bos peers failed)')
    sleep(100)

    // if none of those errored out, consider authorized

    log &&
      logDim(
        `${getDate()} bos.initializeAuth() node auth success:`,
        `${pk.public_key} id,`,
        `${height.current_block_height} height,`,
        `${currentPeers.length} peers`
      )

    return authed
  } catch (e) {
    // new retry delay will be twice of previous for exponential backoff, with max of MAX_RETRY_DELAY ms
    const newRetryDelay = min(MAX_RETRY_DELAY, retryDelay * 2)
    const newRetryDelaySeconds = trunc(newRetryDelay / 1000)

    logDim(`${getDate()} bos.initializeAuth() error, retrying in ${newRetryDelaySeconds}s, e:`, e?.message || e)
    authed = undefined
    await sleep(newRetryDelay)
    checkMemoryUsage() // terminates if memory leak found
    return await initializeAuth({ retryDelay: newRetryDelay }, log)
  }
}

const getDate = timestamp => (timestamp ? new Date(timestamp) : new Date()).toISOString()
const sleep = async ms => await new Promise(resolve => setTimeout(resolve, trunc(ms)))

// const request = (o, cbk) => cbk(null, {}, {})
const request = fetchRequest({ fetch })

const fixJSON = (k, v) => (v === undefined ? null : v)

const removeStyling = o =>
  JSON.parse(
    JSON.stringify(o, (k, v) =>
      // removing styling so can get numbers directly & replacing unknown with 0
      typeof v === 'string' ? v.replace(stylingPatterns, '') : v === undefined ? null : v
    )
  )

// to replace some logger bos uses internally
const logger = log => ({
  info: v =>
    log?.details ? console.log(getDate(), removeStyling(v)) : log?.progress ? process.stdout.write('.') : null,
  error: v => (log?.details ? console.error(getDate(), v) : log?.progress ? process.stdout.write('!') : null)
})

// const copy = item => JSON.parse(JSON.stringify(item, fixJSON))

const logDim = (...args) => setImmediate(() => console.log(`\x1b[2m${args.join(' ')}\x1b[0m`))

const stylingPatterns =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g

const ca = alias => alias.replace(/[^\x00-\x7F]/g, '').trim()

// until memory leak for getting auth object is fixed, might need this
const checkMemoryUsage = () => {
  const memUse = process.memoryUsage()
  const heapTotal = trunc(memUse.heapTotal / 1024 / 1024)
  const heapUsed = trunc(memUse.heapUsed / 1024 / 1024)
  const external = trunc(memUse.external / 1024 / 1024)
  const rss = trunc(memUse.rss / 1024 / 1024)

  logDim(
    `${getDate()} RAM check: ${heapTotal} heapTotal & ${heapUsed} MB heapUsed & ${external} MB external & ${rss} MB resident set size.`
  )

  if (rss > MAX_RAM_USE_MB || external > MAX_RAM_USE_MB || heapTotal > MAX_RAM_USE_MB) {
    console.log(`${getDate()} Hit RAM use limit of ${MAX_RAM_USE_MB} & terminating`)
    process.exit(1)
  }

  return { heapTotal, heapUsed, external, rss }
}

const bos = {
  peers,
  callAPI,
  call, // same as callAPI
  getFees,
  setFees,
  rebalance,
  reconnect,
  send,
  keysend,
  keysendRebalance,
  forwards,
  getFeesChart,
  getChainFeesChart,
  getFeesPaid,
  getDetailedBalance,
  customGetForwardingEvents,
  sayWithTelegramBot,
  customGetPaymentEvents,
  customGetReceivedEvents,
  getNodeChannels,
  getNodePolicy, // same as getNodeChannels
  setPeerPolicy,
  find,
  initializeAuth,
  callPay,
  lnService,
  lnServiceRaw,
  lnServiceWrapped,
  getIdToPublicKeyTable,
  getPublicKeyToAliasTable,
  getIdToAliasTable,
  getNodeFromGraph,
  getRemoteDisabledCount,
  addPeer,
  removePeer
}
export default bos
