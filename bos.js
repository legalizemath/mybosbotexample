/*
  Wrapper for balanceofsatoshis installed globally
  linked via `npm link balanceofsatoshis`
  Used with bos v10.10.2
*/

import { callRawApi } from 'balanceofsatoshis/commands/index.js'
import { adjustFees as bosAdjustFees } from 'balanceofsatoshis/routing/index.js'
import { rebalance as bosRebalance } from 'balanceofsatoshis/swaps/index.js'
import { readFile } from 'fs'
import lnd from 'balanceofsatoshis/lnd/index.js'
import {
  pushPayment as bosPushPayment,
  reconnect as bosReconnect,
  getPeers as bosGetPeers
} from 'balanceofsatoshis/network/index.js'

// use existing global bos authentication
const authenticatedLnd = lnd.authenticatedLnd({})

const reconnect = async (log = false) => {
  try {
    log && console.log(`${getDate()} bos.reconnect()`)
    const res = await bosReconnect({
      lnd: (await authenticatedLnd).lnd
    })
    log && console.log(`${getDate()} bos.reconnect() complete`, res)
    return res
  } catch (e) {
    console.error(`\n${getDate()} bos.reconnect() aborted:`, JSON.stringify(e))
  }
}

const rebalance = async ({
  fromChannel,
  toChannel,
  maxSats = 200000,
  maxMinutes = 2,
  maxFeeRate = 100
}, log = false) => {
  try {
    const options = {
      out_through: fromChannel,
      in_through: toChannel,
      max_rebalance: String(maxSats),
      timeout_minutes: Math.trunc(maxMinutes),
      max_fee_rate: maxFeeRate,
      max_fee: Math.trunc(maxSats * 0.010000) // unused, 10k ppm
    }
    console.log(`${getDate()} bos.rebalance()`, log ? JSON.stringify(options) : '')
    const res = await bosRebalance({
      ...options,
      fs: {getFile: readFile}, // required
      lnd: (await authenticatedLnd).lnd,
      logger: { info: v => log ? console.log(getDate(),v) : process.stdout.write('.') },
      avoid: [], // seems necessary
      out_channels: [] // seems necessary
    })
    log && console.log(`\n${getDate()} bos.rebalance() success:`, JSON.stringify(res))
    console.log('')
    return {
      fee_rate: +(res.rebalance[2]?.rebalance_fee_rate.match(/\((.*)\)/)[1]),
      rebalanced: Math.trunc(+(res.rebalance[2]?.rebalanced) * 1e8)
    }
  } catch (e) {
    console.error(`\n${getDate()} bos.rebalance() aborted:`, JSON.stringify(e))
    // provide suggested ppm if possible
    return {
      failed: true,
      ppmSuggested: e[1] === 'RebalanceFeeRateTooHigh' ? +e[2].needed_max_fee_rate : null,
      msg: e
    }
  }
}

const send = async ({
  destination,
  fromChannel,
  toChannel,
  sats = 1,
  maxMinutes = 1,
  maxFeeRate = 100
}, log = false) => {
  const options = {
    amount: String(Math.trunc(sats)),
    destination: destination,
    out_through: fromChannel,
    in_through: toChannel,
    // uses max fee (sats) only so calculated from max fee rate (ppm)
    max_fee: Math.trunc(sats * maxFeeRate * 1e-6 + 1),
    // message: '',
    timeout_minutes: Math.trunc(maxMinutes)
  }
  try {
    console.log(`${getDate()} bos.send()`, log ? JSON.stringify(options) : '')
    const res = await bosPushPayment({
      ...options,
      fs: {getFile: readFile}, // required
      lnd: (await authenticatedLnd).lnd,
      logger: {
        info: v => log ? console.log(getDate(), v) : process.stdout.write('.')
      },
      is_dry_run: false,
      quiz_answers: [],
      request
    })
    log && console.log(`\n${getDate()} bos.send() success:`, JSON.stringify(res))
    console.log('')
    return {
      fee_rate: Math.trunc(1.0 * +res.fee / +res.paid * 1e6),
      rebalanced: Math.trunc(+res.paid - +res.fee)
    }
  } catch (e) {
    console.log(`\n${getDate()} bos.send() aborted:`, JSON.stringify(e))
    // just max fee suggestions so convert to ppm
    // e.g. [400,"MaxFeeLimitTooLow",{"needed_fee":167}]
    return {
      failed: true,
      ppmSuggested: e[1] === 'MaxFeeLimitTooLow'
      ? (
        Math.trunc(1.0 * +e[2].needed_fee / sats * 1e6 + 1.0)
      )
      : null,
      msg: e
    }
  }
}

// returns new set fee
const setFees = async (peerPubKey, fee_rate, log = false) => {
  try {
    log && console.log(`${getDate()} bos.setFees()`)
    const res = await bosAdjustFees({
      fs: {getFile: readFile}, // required
      lnd: (await authenticatedLnd).lnd,
      logger: {}, // logger not used
      to: [peerPubKey], // array of pubkeys to adjust fees towards
      fee_rate: String(fee_rate) // pm rate to set
    })
    const newFee = res.rows[1][1]?.match(/\((.*)\)/)[1]
    log && console.log(`${getDate()} bos.setFees()`, JSON.stringify(res), newFee)
    return +newFee
  } catch(e) {
    console.error(`${getDate()} bos.setFees() aborted:`, e)
    return {}
  }
}


// bos call api commands to lnd
const callAPI = async (method, choices = {}) => {
  // names for methods and choices for arguments via `bos call` or here
  // https://github.com/alexbosworth/balanceofsatoshis/blob/master/commands/api.json
  // getFeeRates: my outgoing base_fee_mtokens and fee_rate via NNNNNNxNNNxVOUT id or transaction_id and transaction_vout
  // getChannels has channel specific information but no fees
  try {
    console.log(`${getDate()} bos.callAPI() for ${method}`)
    return await callRawApi({
      lnd: (await authenticatedLnd).lnd,
      method,
      ask: (undefined, cbk) => cbk(null, choices),
    })
  } catch (e) {
    console.error(`${getDate()} bos.callAPI() aborted:`, e)
    return undefined;
  }
}


// returns {public_key, inbound_liquidity, outbound_liquidity, inbound_fee_rate, alias}
const getPeers = async (options = {}, log = false) => {
  try {
    log && console.log(`${getDate()} bos.getPeers()`)
    const res = await bosGetPeers({
      fs: {getFile: readFile}, // required
      lnd: (await authenticatedLnd).lnd,
      omit: [], // required
      active: true, // only connected peers
      public: true, // only public peers
      ...options
    })
    const peers = res.peers

    // convert fee rate to just ppm
    .map(peer => ({
      ...peer,
      inbound_fee_rate: peer.inbound_fee_rate?.match(/\((.*)\)/)[1]
    }))

    log && console.log(`${getDate()} bos.getPeers()`, JSON.stringify(peers, (k, v) => v === undefined ? 'undefined' : v, 2))
    return peers
  } catch (e) {
    console.error(`${getDate()} bos.getPeers() aborted:`, e)
    return []
  }
}

// returns {pubkey: my_ppm_fee_rate}
const getFees = async (log = false) => {
  try {
    log && console.log(`${getDate()} bos.getFees()`)
    const res = await bosAdjustFees({
      fs: {getFile: readFile}, // required
      lnd: (await authenticatedLnd).lnd,
      logger: {}, // logger not used
      to: [] // array of pubkeys to adjust fees towards
    })
    const myFees = res.rows
      .slice(1) // remove table headers row
      .reduce((feeRates, thisPeer) => {
        const pubKey = thisPeer[2] // 3rd column is pubkey
        feeRates[pubKey] = thisPeer[1].match(/\((.*)\)/)[1] // 2nd column has fee ppm
        return feeRates
      }, {})
    return myFees
  } catch(e) {
    console.error(`${getDate()} bos.getFees() aborted:`, e)
    return undefined
  }
}

const getDate = timestamp => (timestamp ? new Date(timestamp) : new Date()).toISOString()

const request = ({}, cbk) => cbk(null, {}, {})

const bos = {
  getPeers,
  callAPI,
  getFees,
  setFees,
  rebalance,
  reconnect,
  send
}
export default bos
