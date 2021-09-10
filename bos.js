/*
  Wrapper for balanceofsatoshis installed globally
  linked via `npm link balanceofsatoshis`
  Used with bos v10.14.0
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

// use existing global bos authentication
const mylnd = async () => (await lnd.authenticatedLnd({})).lnd

// returns {closing_balance, offchain_balance, offchain_pending, onchain_balance, onchain_vbytes}
const getDetailedBalance = async (choices = {}, log = false) => {
  try {
    console.boring(`${getDate()} bos.getDetailedBalance()`)
    const res = await bosGetDetailedBalance({
      lnd: await mylnd(), // required
      ...choices
    })
    log && console.log(`${getDate()} bos.getDetailedBalance() complete`, res)

    const stylingPatterns =
      // eslint-disable-next-line no-control-regex
      /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g
    return JSON.parse(
      JSON.stringify(res, (k, v) =>
        typeof v === 'string'
          ? v.replace(stylingPatterns, '')
          : v === undefined
          ? 0
          : v
      )
    )
  } catch (e) {
    console.error(
      `\n${getDate()} bos.getDetailedBalance() aborted:`,
      JSON.stringify(e)
    )
    return {}
  }
}

// returns {description, title, data: []}
const getFeesPaid = async (choices = {}, log = false) => {
  try {
    console.boring(`${getDate()} bos.getFeesPaid()`)
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
    console.error(
      `\n${getDate()} bos.getFeesPaid() aborted:`,
      JSON.stringify(e)
    )
    return {}
  }
}

// returns {description, title, data: []}
const getFeesChart = async (choices = {}, log = false) => {
  try {
    console.boring(`${getDate()} bos.getFeesChart()`)
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
    console.error(
      `\n${getDate()} bos.getFeesChart() aborted:`,
      JSON.stringify(e)
    )
    return {}
  }
}

// returns {description, title, data: []}
const getChainFeesChart = async (choices = {}, log = false) => {
  try {
    console.boring(`${getDate()} bos.getChainFeesChart()`)
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
    console.error(
      `\n${getDate()} bos.getChainFeesChart() aborted:`,
      JSON.stringify(e)
    )
    return {}
  }
}

const forwards = async (choices = {}, log = false) => {
  try {
    console.boring(`${getDate()} bos.forwards()`)
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
    console.boring(`${getDate()} bos.reconnect()`)
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
  {
    fromChannel,
    toChannel,
    maxSats = 200000,
    maxMinutes = 2,
    maxFeeRate = 100
  },
  choices = {},
  log = false
) => {
  try {
    // change to internal key names, add overwrites in choices
    const options = {
      out_through: fromChannel,
      in_through: toChannel,
      max_rebalance: String(Math.trunc(maxSats)),
      timeout_minutes: Math.trunc(maxMinutes),
      max_fee_rate: Math.trunc(maxFeeRate),
      max_fee: Math.trunc(maxSats * 0.01), // unused, 10k ppm
      avoid: [], // necessary
      // out_channels: [],
      // in_outound: undefined,
      // out_inbound: undefined,
      ...choices
    }
    console.boring(
      `${getDate()} bos.rebalance()`,
      log ? JSON.stringify(options) : ''
    )
    const res = await bosRebalance({
      fs: { getFile: readFile }, // required
      lnd: await mylnd(), // required
      logger: logger(log),
      out_channels: [], // seems necessary
      ...options
    })
    log &&
      console.log(
        `\n${getDate()} bos.rebalance() success:`,
        JSON.stringify(res)
      )
    console.log('')
    return {
      fee_rate: +res.rebalance[2]?.rebalance_fee_rate.match(/\((.*)\)/)[1],
      rebalanced: Math.trunc(+res.rebalance[2]?.rebalanced * 1e8)
    }
  } catch (e) {
    console.error(`\n${getDate()} bos.rebalance() aborted:`, JSON.stringify(e))
    // provide suggested ppm if possible
    return {
      failed: true,
      ppmSuggested:
        e[1] === 'RebalanceFeeRateTooHigh' ? +e[2].needed_max_fee_rate : null,
      msg: e
    }
  }
}

const send = async (
  {
    destination, // public key, kind of important
    fromChannel = undefined, // public key
    toChannel = undefined, // public key
    sats = 1,
    maxMinutes = 1,
    maxFeeRate = 100
  },
  log = false,
  retry = false
) => {
  const options = {
    destination,
    out_through: fromChannel,
    in_through: toChannel,
    amount: String(Math.trunc(sats)),
    timeout_minutes: Math.trunc(maxMinutes),
    // uses max fee (sats) only so calculated from max fee rate (ppm)
    max_fee: Math.trunc(sats * maxFeeRate * 1e-6 + 1)
    // message: '',
  }
  try {
    console.boring(
      `${getDate()} bos.send() to ${destination}`,
      log ? JSON.stringify(options) : ''
    )
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
    log &&
      console.log(`\n${getDate()} bos.send() success:`, JSON.stringify(res))
    console.log('')
    return {
      fee_rate: Math.trunc(((1.0 * +res.fee) / +res.paid) * 1e6),
      rebalanced: Math.trunc(+res.paid - +res.fee)
    }
  } catch (e) {
    console.error(`\n${getDate()} bos.send() aborted:`, JSON.stringify(e))
    // just max fee suggestions so convert to ppm
    // e.g. [400,"MaxFeeLimitTooLow",{"needed_fee":167}]

    // if higher fee was JUST found try just 1 more time
    if (!retry && e[1] === 'FeeInsufficient') {
      console.error(
        `\n${getDate()} retrying just once after FeeInsufficient error`
      )
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
        true
      )
    }
    return {
      failed: true,
      ppmSuggested:
        e[1] === 'MaxFeeLimitTooLow'
          ? Math.trunc(((1.0 * +e[2].needed_fee) / sats) * 1e6 + 1.0)
          : null,
      msg: e
    }
  }
}

// returns new set fee
const setFees = async (peerPubKey, fee_rate, log = false) => {
  try {
    console.boring(`${getDate()} bos.setFees()`)
    const res = await bosAdjustFees({
      fs: { getFile: readFile }, // required
      lnd: await mylnd(),
      logger: {}, // logger not used
      to: [peerPubKey], // array of pubkeys to adjust fees towards
      fee_rate: String(fee_rate) // pm rate to set
    })
    const newFee = res.rows[1][1]?.match(/\((.*)\)/)[1]
    log &&
      console.log(`${getDate()} bos.setFees()`, JSON.stringify(res), newFee)
    return +newFee
  } catch (e) {
    console.error(`${getDate()} bos.setFees() aborted:`, e)
    return {}
  }
}

// bos call api commands to lnd
// bos call getIdentity - get my pub key
// bos call getForwards - forwarding events
// bos call getChannels - on-chain channel info
// bos call getFeeRates - has base fee info (via channel or tx ids, not pubkeys)
// bos call getForwards - choices: either {limit: 5} or {token: '{"offset":10,"limit":5}'}
// names for methods and choices for arguments via `bos call` or here
// https://github.com/alexbosworth/balanceofsatoshis/blob/master/commands/api.json
const callAPI = async (method, choices = {}) => {
  try {
    console.boring(`${getDate()} bos.callAPI() for ${method}`)
    return await callRawApi({
      lnd: await mylnd(),
      method,
      ask: (u, cbk) => cbk(null, choices)
    })
  } catch (e) {
    console.error(`${getDate()} bos.callAPI() aborted:`, e)
    return undefined
  }
}

const peers = async (choices = {}, log = false) => {
  try {
    console.boring(`${getDate()} bos.peers()`)
    const res = await bosGetPeers({
      fs: { getFile: readFile }, // required
      lnd: await mylnd(),
      omit: [], // required
      active: true, // only connected peers
      public: true, // only public peers
      earnings_days: 3, // can comment this out
      ...choices
    })
    const peers = res.peers

      // convert fee rate to just ppm
      .map(peer => ({
        ...peer,
        inbound_fee_rate: +peer.inbound_fee_rate?.match(/\((.*)\)/)[1] || 0
      }))

    log &&
      console.log(`${getDate()} bos.peers()`, JSON.stringify(peers, fixJSON, 2))
    return peers
  } catch (e) {
    console.error(`${getDate()} bos.peers() aborted:`, e)
    return []
  }
}

// returns {pubkey: my_ppm_fee_rate}
const getFees = async (log = false) => {
  try {
    console.boring(`${getDate()} bos.getFees()`)
    const res = await bosAdjustFees({
      fs: { getFile: readFile }, // required
      lnd: await mylnd(),
      logger: {}, // logger not used
      to: [] // array of pubkeys to adjust fees towards
    })
    log &&
      console.log(
        `${getDate()} bos.getFees() result:`,
        JSON.stringify(res, fixJSON, 2)
      )

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

const getDate = timestamp =>
  (timestamp ? new Date(timestamp) : new Date()).toISOString()

// const request = (o, cbk) => cbk(null, {}, {})
const request = fetchRequest({ fetch })

const fixJSON = (k, v) => (v === undefined ? null : v)

const logger = log => ({
  info: v => (log ? console.log(getDate(), v) : process.stdout.write('.'))
})

console.boring = args => console.log(`\x1b[2m${args}\x1b[0m`)

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
  getDetailedBalance
}
export default bos
