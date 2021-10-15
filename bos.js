/*
  Wrapper for balanceofsatoshis installed globally
  Needs node v14+, node -v
  Installed with `npm i -g balanceofsatoshis@10.18.1`
  Linked via `npm link balanceofsatoshis`
*/

import { fetchRequest, callRawApi } from 'balanceofsatoshis/commands/index.js'
import fetch from 'balanceofsatoshis/node_modules/@alexbosworth/node-fetch/lib/index.js'
import { readFile } from 'fs'
import lnd from 'balanceofsatoshis/lnd/index.js'

import {
  adjustFees as bosAdjustFees,
  getFeesChart as bosGetFeesChart,
  getChainFeesChart as bosGetChainFeesChart,
  getFeesPaid as bosGetFeesPaid
} from 'balanceofsatoshis/routing/index.js'

// import { rebalance as bosRebalance } from 'balanceofsatoshis/swaps/index.js'
import { manageRebalance as bosRebalance } from 'balanceofsatoshis/swaps/index.js'

import { getDetailedBalance as bosGetDetailedBalance } from 'balanceofsatoshis/balances/index.js'

import {
  pushPayment as bosPushPayment,
  reconnect as bosReconnect,
  getPeers as bosGetPeers,
  getForwards as bosGetForwards
} from 'balanceofsatoshis/network/index.js'

const { trunc, min, ceil } = Math

// use existing global bos authentication
const mylnd = async () => (await lnd.authenticatedLnd({})).lnd

// returns {closing_balance, offchain_balance, offchain_pending, onchain_balance, onchain_vbytes}
const getDetailedBalance = async (choices = {}, log = false) => {
  try {
    log && console.boring(`${getDate()} bos.getDetailedBalance()`)
    const res = await bosGetDetailedBalance({
      lnd: await mylnd(), // required
      ...choices
    })
    log && console.log(`${getDate()} bos.getDetailedBalance() complete`, res)

    return removeStyling(res)
  } catch (e) {
    console.error(`\n${getDate()} bos.getDetailedBalance() aborted:`, JSON.stringify(e))
    return {}
  }
}

// returns {description, title, data: []}
const getFeesPaid = async (choices = {}, log = false) => {
  try {
    log && console.boring(`${getDate()} bos.getFeesPaid()`)
    const res = await bosGetFeesPaid({
      lnds: [await mylnd()], // required
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
    console.error(`\n${getDate()} bos.getFeesPaid() aborted:`, JSON.stringify(e))
    return {}
  }
}

// returns {description, title, data: []}
const getFeesChart = async (choices = {}, log = false) => {
  try {
    log && console.boring(`${getDate()} bos.getFeesChart()`)
    const res = await bosGetFeesChart({
      lnds: [await mylnd()], // required
      days: 30,
      is_count: false,
      is_forwarded: false,
      // via: <public key>
      ...choices
    })
    log && console.log(`${getDate()} bos.getFeesChart() complete`, res)
    return res
  } catch (e) {
    console.error(`\n${getDate()} bos.getFeesChart() aborted:`, JSON.stringify(e))
    return {}
  }
}

// returns {description, title, data: []}
const getChainFeesChart = async (choices = {}, log = false) => {
  try {
    log && console.boring(`${getDate()} bos.getChainFeesChart()`)
    const res = await bosGetChainFeesChart({
      lnds: [await mylnd()], // required
      days: 30,
      is_monochrome: true,
      request,
      ...choices
    })
    log && console.log(`${getDate()} bos.getChainFeesChart() complete`, res)
    return res
  } catch (e) {
    console.error(`\n${getDate()} bos.getChainFeesChart() aborted:`, JSON.stringify(e))
    return { data: [] }
  }
}

const forwards = async (choices = {}, log = false) => {
  try {
    log && console.boring(`${getDate()} bos.forwards()`)
    const res = await bosGetForwards({
      lnd: await mylnd(), // required
      fs: { getFile: readFile }, // required
      days: 1,
      // [from: public key]
      // [to: public key]
      ...choices
    })
    log && console.log(`${getDate()} bos.forwards() complete`, res)
    return res.peers
  } catch (e) {
    console.error(`\n${getDate()} bos.forwards() aborted:`, JSON.stringify(e))
    return []
  }
}

const reconnect = async (log = false) => {
  try {
    log && console.boring(`${getDate()} bos.reconnect()`)
    const res = await bosReconnect({
      lnd: await mylnd()
    })
    log && console.log(`${getDate()} bos.reconnect() complete`, res)
    return res
  } catch (e) {
    console.error(`\n${getDate()} bos.reconnect() aborted:`, JSON.stringify(e))
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
      max_fee: trunc(maxSats * 0.01),
      avoid,
      // out_channels: [],
      // in_outound: undefined,
      // out_inbound: undefined,
      ...choices
    }
    log?.details && console.boring(`${getDate()} bos.rebalance()`, JSON.stringify(options))
    if (fromChannel === toChannel) throw new Error('fromChannel same as toChannel')
    const res = await bosRebalance({
      fs: { getFile: readFile }, // required
      lnd: await mylnd(), // required
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
    log?.details && console.error(`\n${getDate()} bos.rebalance() aborted:`, JSON.stringify(e))

    // if we're retrying on timeouts & avoid wasn't used, rerun again with avoid of low fees
    if (retryAvoidsOnTimeout && e[1] === 'ProbeTimeout' && avoid.length <= 1) {
      retryAvoidsOnTimeout-- // 1 less retry left now
      const oldAvoidPpm = +(avoid[0] || '').match(/FEE_RATE<(.+?)\//)?.[1] || 0
      // each new retry moves avoid fee rate 25% closer to half max total fee rate
      const newAvoidPpm = trunc(oldAvoidPpm * 0.75 + (maxFeeRate / 2) * 0.25)
      const newAvoid = `FEE_RATE<${newAvoidPpm}/${toChannel}`

      // log?.details &&
      console.boring(
        `${getDate()} Retrying after ProbeTimeout error @ ${maxFeeRate} with --avoid ${newAvoid}` +
          ` (for last peer). Retries left: ${retryAvoidsOnTimeout}`
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
    destination, // public key, kind of important
    fromChannel = undefined, // public key
    toChannel = undefined, // public key
    sats = 1, // how much needs to arrive at destination
    maxMinutes = 1,
    maxFeeRate = undefined, // ppm, rounded up to next sat
    // use smaller of these fee limits:
    maxFee = undefined, // max fee sats, 1 sat fee per 1 sat arriving somewhere is default max
    message = undefined, // string to send (reveals sender when used)
    // retryAvoidsOnTimeout = 0
    isRebalance = true
  },
  log = { details: false, progress: true },
  retry = false
) => {
  try {
    const unspecifiedFee = maxFee === undefined && maxFeeRate === undefined
    maxFee = maxFee ?? sats
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
      message
    }

    log?.details && console.boring(`${getDate()} bos.send() to ${destination}`, JSON.stringify(options))

    if (fromChannel === toChannel && toChannel !== undefined) throw new Error('fromChannel same as toChannel')
    if (unspecifiedFee) throw new Error('need to specify maxFeeRate or maxFee')
    if (isRebalance && !(fromChannel && toChannel)) throw new Error('need to specify from and to channels')

    const res = await bosPushPayment({
      lnd: await mylnd(),
      logger: logger(log),
      fs: { getFile: readFile }, // required
      avoid: [], // required
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
    log?.details && console.error(`\n${getDate()} bos.send() aborted:`, JSON.stringify(e))
    // just max fee suggestions so convert to ppm
    // e.g. [400,"MaxFeeLimitTooLow",{"needed_fee":167}]

    // if someone JUST changed fee try again just 1 more time
    if (!retry && e[1] === 'FeeInsufficient') {
      console.boring(`\n${getDate()} retrying just once after FeeInsufficient error`)
      return await send(
        {
          destination,
          fromChannel,
          toChannel,
          sats,
          maxMinutes,
          maxFeeRate
        },
        log,
        true // mark it as a retry
      )
    }
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

// returns new set fee
const setFees = async (peerPubKey, fee_rate, log = false) => {
  try {
    log && console.boring(`${getDate()} bos.setFees()`)
    const res = await bosAdjustFees({
      fs: { getFile: readFile }, // required
      lnd: await mylnd(),
      logger: {}, // logger not used
      to: [peerPubKey], // array of pubkeys to adjust fees towards
      fee_rate: String(fee_rate) // pm rate to set
    })
    const newFee = res.rows[1][1]?.match(/\((.*)\)/)[1]
    log && console.log(`${getDate()} bos.setFees()`, JSON.stringify(res), newFee)
    return +newFee
  } catch (e) {
    console.error(`${getDate()} bos.setFees() aborted:`, e)
    return {}
  }
}

// bos call api commands to lnd
// bos call getIdentity - get my pub key
// bos call getChannels - on-chain channel info
// bos call getNode { public_key, is_omitting_channels: false } - both fees, max/min htlc, updated_at, is_disabled, cltv_delta
// bos call getFeeRates - has base fee info (via channel or tx ids, not pubkeys)
// bos call updateRoutingFees - MUST set every value or it is set to default (https://github.com/alexbosworth/ln-service#updateroutingfees)
// bos call getForwards - forwarding events, choices: either {limit: 5} or {token: `{"offset":10,"limit":5}`}
// bos call getpeers - contains networking data like bytes sent/received/socket
// names for methods and choices for arguments via `bos call` or here
// https://github.com/alexbosworth/ln-service
// https://github.com/alexbosworth/balanceofsatoshis/blob/master/commands/api.json
// 'cltv_delta' can just be found in getChannel and getNode, not getChannels, not getFeeRates
// ^ is set in updateRoutingFees
// 'max_htlc_mtokens' and 'min_htlc_mtokens' in getChannel and getChannels (@ local_, remote_) and getNode, not getFeeRates
// ^ updated just in updateRoutingFees
// 'base_fee_mtokens' in getChannel and getFeeRates and getNode, not getChannels
// ^ updated in updateRoutingFees
const callAPI = async (method, choices = {}, log = false) => {
  try {
    log && console.boring(`${getDate()} bos.callAPI() for ${method}`)
    return await callRawApi({
      lnd: await mylnd(),
      method,
      ask: (u, cbk) => cbk(null, choices),
      logger: logger(log)
    })
  } catch (e) {
    console.error(`${getDate()} bos.callAPI('${method}', ${JSON.stringify(choices)}) aborted:`, e)
    return undefined
  }
}

const find = async (query, log = false) => {
  try {
    log && console.boring(`${getDate()} bos.find('${query}')`)
    return await lnd.findRecord({
      lnd: await mylnd(),
      query
    })
  } catch (e) {
    console.error(`${getDate()} bos.find('${query}') aborted:`, e)
    return null
  }
}

// to get all peers including inactive just do bos.peers({ is_active: undefined })
const peers = async (choices = {}, log = false) => {
  try {
    log && console.boring(`${getDate()} bos.peers()`)
    const res = await bosGetPeers({
      fs: { getFile: readFile }, // required
      lnd: await mylnd(),
      omit: [], // required
      is_active: !choices.is_offline, // only connected peers
      is_public: true, // only public peers
      is_private: false, // no private channels
      is_offline: false, // online channels only by default
      // earnings_days: 7, // can comment this out
      ...choices
    })
    const peers = res.peers

      // convert fee rate to just ppm
      .map(peer => ({
        ...peer,
        inbound_fee_rate: +peer.inbound_fee_rate?.match(/\((.*)\)/)[1] || 0
      }))

    log && console.log(`${getDate()} bos.peers()`, JSON.stringify(peers, fixJSON, 2))
    return peers
  } catch (e) {
    console.error(`${getDate()} bos.peers() aborted:`, e)
    return null
  }
}

// returns {pubkey: my_ppm_fee_rate}
const getFees = async (log = false) => {
  try {
    log && console.boring(`${getDate()} bos.getFees()`)
    const res = await bosAdjustFees({
      fs: { getFile: readFile }, // required
      lnd: await mylnd(),
      logger: {}, // logger not used
      to: [] // array of pubkeys to adjust fees towards
    })
    log && console.log(`${getDate()} bos.getFees() result:`, JSON.stringify(res, fixJSON, 2))

    const myFees = res.rows
      .slice(1) // remove table headers row
      .reduce((feeRates, thisPeer) => {
        // 3rd column is pubkey
        const pubKey = thisPeer[2]
        // 2nd column has fee ppm
        feeRates[pubKey] = +thisPeer[1].match(/\((.*)\)/)[1]
        return feeRates
      }, {})

    return myFees
  } catch (e) {
    console.error(`${getDate()} bos.getFees() aborted:`, e)
    return undefined
  }
}

// token looks like adsfasfdsf:adsfsadfasdfasfasdfasfd-asdfsf
// chat_id looks like 1231231231
const sayWithTelegramBot = async ({ token, chat_id, message }, log = false) => {
  try {
    log && console.boring(`${getDate()} bos.sayWithTelegramBot()`)
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage?chat_id=${chat_id}` + `&text=${encodeURIComponent(message)}`
    )
    const fullResponse = await res.json()
    log && console.boring(`${getDate()} bos.sayWithTelegramBot() result:`, res, fullResponse)
    return fullResponse
  } catch (e) {
    console.error(`${getDate()} bos.sayWithTelegramBot() aborted:`, e)
    return null
  }
}

// ---- I needed this

// does calls bos call getChannels and bos call getForwards
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
  log && console.boring(`${getDate()} bos.customGetForwardingEvents()`)

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
    log && console.boring(`${getDate()} this offset: ${thisOffset}`)

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
  log && console.boring(`${getDate()} bos.customGetPaymentEvents()`)

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

    log && console.boring(`${getDate()} this offset: ${nextOffset}, next offset: ${res.next}`)
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
  log && console.boring(`${getDate()} bos.customGetReceivedEvents()`)

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

    log && console.boring(`${getDate()} this offset: ${nextOffset}, next offset: ${res.next}`)
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
const getNodeChannels = async ({ public_key, peer_key } = {}) => {
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
    const betterChannels = res.channels.reduce((channels_v2, channel) => {
      const outgoingPolicy = channel.policies.find(p => p.public_key === public_key)
      const incomingPolicy = channel.policies.find(p => p.public_key !== public_key)
      const remotePublicKey = incomingPolicy.public_key
      if (peer_key && peer_key !== remotePublicKey) return channels_v2
      channels_v2[channel.id] = channel
      channels_v2[channel.id].local = outgoingPolicy
      channels_v2[channel.id].remote = incomingPolicy
      channels_v2[channel.id].public_key = remotePublicKey
      delete channel.policies
      return channels_v2
    }, {})
    return betterChannels
  } catch (e) {
    console.error(JSON.stringify(e))
    return null
  }
}

// safer way to set channel policy to avoid default resets
// if by_channel_id is specified, looks at channel id keys  for specific settings
// by_channel_id: {'702673x1331x1': {max_htlc_mtokens: '1000000000' }}
const setPeerPolicy = async (
  { peer_key, by_channel_id, base_fee_mtokens, fee_rate, cltv_delta, max_htlc_mtokens, min_htlc_mtokens, my_key },
  log = false
) => {
  if (!peer_key) return 1
  let settings
  try {
    // get my public key
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
        await bos.callAPI('updateRoutingFees', settings)
      } else {
        log && console.log(`${getDate()} no policy changes necessary`)
      }
    }

    return 0
  } catch (e) {
    log && console.error('error:', e, 'with settings:', settings)
    return 1
  }
}

const getDate = timestamp => (timestamp ? new Date(timestamp) : new Date()).toISOString()

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

const logger = log => ({
  info: v =>
    log?.details ? console.log(getDate(), removeStyling(v)) : log?.progress ? process.stdout.write('.') : null,
  error: v => (log?.details ? console.error(getDate(), v) : log?.progress ? process.stdout.write('!') : null)
})

console.boring = (...args) => console.log(`\x1b[2m${args}\x1b[0m`)

const stylingPatterns =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g

const bos = {
  peers,
  callAPI,
  getFees,
  setFees,
  rebalance,
  reconnect,
  send,
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
  setPeerPolicy,
  find
}
export default bos
