/*
  Wrapper for balanceofsatoshis installed globally
  linked via `npm link balanceofsatoshis`
*/

import bos_network from 'balanceofsatoshis/network/index.js'
import { callRawApi } from 'balanceofsatoshis/commands/index.js'
import { adjustFees } from 'balanceofsatoshis/routing/index.js'
import { rebalance } from 'balanceofsatoshis/swaps/index.js'
import { readFile } from 'fs'
import lnd from 'balanceofsatoshis/lnd/index.js'

// use existing global bos authentication
const authenticatedLnd = lnd.authenticatedLnd({})

const runReconnect = async (log = false) => {
  try {
    log && console.log(`${getDate()} bos.runReconnect()`)
    const res = await bos_network.reconnect({
      lnd: (await authenticatedLnd).lnd
    })
    log && console.log(`${getDate()} bos.runReconnect() complete`, res)
    return res
  } catch (e) {
    console.error(`\n${getDate()} bos.runReconnect() aborted:`, JSON.stringify(e))
  }
}

const runRebalance = async ({
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
      timeout_minutes: maxMinutes,
      max_fee_rate: maxFeeRate,
      max_fee: Math.trunc(maxSats * 0.01) // unused, 10k ppm
    }
    log && console.log(`${getDate()} bos.runRebalance()`, JSON.stringify(options))
    const res = await rebalance({
      ...options,
      fs: {getFile: readFile}, // required
      lnd: (await authenticatedLnd).lnd,
      logger: { info: v => log ? console.log(getDate(),v) : process.stdout.write('.') },
      avoid: [], // seems necessary
      out_channels: [] // seems necessary
    })
    log && console.error(`\n${getDate()} bos.runRebalance() success:`, JSON.stringify(res))
    console.log('')
    return {
      fee_rate: +(res.rebalance[2]?.rebalance_fee_rate.match(/\((.*)\)/)[1]),
      rebalanced: Math.trunc(+(res.rebalance[2]?.rebalanced) * 1e8)
    }
  } catch (e) {
    console.error(`\n${getDate()} bos.runRebalance() aborted:`, JSON.stringify(e))
    return {
      failed: true,
      msg: e
    }
  }
}

// returns new set fee
const setFees = async (peerPubKey, fee_rate, log = false) => {
  try {
    log && console.log(`${getDate()} bos.setFees()`)
    const res = await adjustFees({
      fs: {getFile: readFile}, // required
      lnd: (await authenticatedLnd).lnd,
      logger: {}, // logger not used
      to: [peerPubKey], // array of pubkeys to adjust fees towards
      fee_rate: String(fee_rate) // pm rate to set
    })
    const newFee = res.rows[1][1]?.match(/\((.*)\)/)[1]
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
const getPeers = async (log = false) => {
  try {
    const res = await bos_network.getPeers({
      fs: {getFile: readFile}, // required
      lnd: (await authenticatedLnd).lnd,
      omit: [], // required
      active: true, // only connected peers
      public: true // only public peers
    })
    log && console.log(`${getDate()} bos.getPeers()`)
    // most keys are undefined so only some kept here
    const keysToShow = (
      {alias, public_key, inbound_liquidity, outbound_liquidity, inbound_fee_rate}
    ) => (
      {alias, public_key, inbound_liquidity, outbound_liquidity, inbound_fee_rate}
    )
    return res.peers
      .map(keysToShow)
      // convert fee rate to just ppm
      .map(peer => ({
        ...peer,
        inbound_fee_rate: peer.inbound_fee_rate?.match(/\((.*)\)/)[1]
      }))
  } catch (e) {
    console.error(`${getDate()} bos.getPeers() aborted:`, e)
    return []
  }
}

// returns {pubkey: my_ppm_fee_rate}
const getFees = async (log = false) => {
  try {
    log && console.log(`${getDate()} bos.getFees()`)
    const res = await adjustFees({
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

const bos = {
  getPeers,
  callAPI,
  getFees,
  setFees,
  runRebalance,
  runReconnect
}
export default bos
