// runs with: node lndsummary
// needs bos.js wrapper and package.json (so it knows its modules) in same folder
// just the generate summary snapshots part of my script that just reads lnd data and makes summary text files

import fs from 'fs' // comes with nodejs, to read/write log files
import bos from './bos.js' // my wrapper for bos, needs to be in same folder
const { max, floor, abs, ceil, trunc } = Math

// change this to change number of days summary is for
const DAYS_FOR_STATS = 7

// where to put random tables
const LOG_FILES = './logs'
const PEERS_LOG_PATH = './peers'
const SNAPSHOTS_PATH = './snapshots'

// generate data to save to files for easier external browsing
// returns peers info with maximum detail (content of _peers.json)
const generateSnapshots = async () => {
  console.boring(`${getDate()} generateSnapshots()`)

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

  const mynode = {}
  mynode.my_public_key = (await bos.callAPI('getIdentity')).public_key

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
  // get all payments from db
  const getPaymentEvents = await bos.customGetPaymentEvents({
    days: DAYS_FOR_STATS
  })
  // payments can be deleted so scan log file backups
  const res = fs.readdirSync(LOG_FILES) || []
  const paymentLogFiles = res.filter(f => f.match(/_paymentHistory/))
  const isRecent = t => Date.now() - t < DAYS_FOR_STATS * 24 * 60 * 60 * 1000
  console.boring(`${getDate()} ${getPaymentEvents.length} payment records found in db`)
  for (const fileName of paymentLogFiles) {
    const timestamp = fileName.split('_')[0]
    console.boring(`${fileName} - is Recent? ${isRecent(timestamp)}`)
    if (!isRecent(timestamp)) continue // log file older than oldest needed record
    const payments = JSON.parse(fs.readFileSync(`${LOG_FILES}/${fileName}`))
    getPaymentEvents.push(...payments.filter(p => isRecent(p.created_at_ms)))
    console.boring(`${getDate()} ${getPaymentEvents.length} payment records after log file`)
  }

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

    peer.socket = networkingData[peer.public_key]?.socket // rest of uri
    peer.bytes_sent = networkingData[peer.public_key]?.bytes_sent
    peer.bytes_received = networkingData[peer.public_key]?.bytes_received
    peer.is_inbound = networkingData[peer.public_key]?.is_inbound // who opened
    peer.ping_time = networkingData[peer.public_key]?.ping_time
    peer.reconnection_rate = networkingData[peer.public_key]?.reconnection_rate
    peer.last_reconnection = networkingData[peer.public_key]?.last_reconnection
    // array of supported features 'bit type'
    peer.features = networkingData[peer.public_key]?.features?.map(f => `${f.bit} ${f.type}`)

    // experimental
    // calculateFlowRateMargin(peer)

    // initialize capacity (sum below from each individual channel to this peer)
    // more constant measure of total sats indifferent from inflight htlcs & reserves
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

      // estimate channel age from opening transaction block height to minimize reliance on api
      const openingHeight = +id.split('x')[0]
      const channelAgeDays = +(((current_block_height - openingHeight) * 10) / (60 * 24)).toFixed(1)

      // add this info for each of peer's channels separately
      final.push({
        // pick what to put into peers file here for each channel id
        id,
        transaction_id: channelOnChainInfo[id].transaction_id,
        transaction_vout: channelOnChainInfo[id].transaction_vout,
        channel_age_days: channelAgeDays,

        base_fee_mtokens: +feeRates[id].base_fee_mtokens,
        capacity: channelOnChainInfo[id].capacity,
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
        remote_max_pending_mtokens: +channelOnChainInfo[id].remote_max_pending_mtokens,
        local_min_htlc_mtokens: +channelOnChainInfo[id].local_min_htlc_mtokens,
        remote_min_htlc_mtokens: +channelOnChainInfo[id].remote_min_htlc_mtokens,

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

  // idea for normalized metric "unbalanced %"
  // 2 * sats-away-from-balance / total capacity * 100%
  // completely unbalanced would be like 2*5M/10M = 100%
  // complete balanced would be 0 / 10M = 0%
  const totalSatsOffBalance = peers.reduce((sum, peer) => sum + peer.unbalancedSats, 0)
  const totalCapacity = peers.reduce((sum, peer) => sum + peer.totalSats, 0)
  const unbalancedPercent = (((2.0 * totalSatsOffBalance) / totalCapacity) * 100).toFixed(0)

  const totalSatsOffBalanceSigned = peers.reduce((sum, peer) => sum + peer.unbalancedSatsSigned, 0)

  const baseFeesStats = median(getFeeRates.channels.map(d => +d.base_fee_mtokens)).s
  const ppmFeesStats = median(getFeeRates.channels.map(d => d.fee_rate)).s
  const channelCapacityStats = median(
    getChannels.channels.map(d => d.capacity),
    { f: pretty }
  ).s

  const totalEarnedFromForwards = peers.reduce((t, p) => t + p.routed_out_fees_msats, 0) / 1000

  const statsEarnedPerPeer = median(
    peers.filter(p => p.routed_out_last_at).map(p => p.routed_out_fees_msats / 1000),
    { f: pretty }
  ).s

  const totalPeersRoutingIn = peers.filter(p => p.routed_in_last_at).length
  const totalPeersRoutingOut = peers.filter(p => p.routed_out_last_at).length

  const chainFeesSummary = await bos.getChainFeesChart({ days: DAYS_FOR_STATS })

  const balances = await bos.getDetailedBalance()

  // get totals from payments and received
  const totalReceivedFromOthersLN =
    Object.values(receivedFromOthersLN).reduce((t, r) => t + r.received_mtokens, 0) / 1000
  const totalSentToOthersLN = paidToOthersLN.reduce((t, p) => t + p.mtokens, 0) / 1000
  const totalRebalances = rebalances.reduce((t, p) => t + p.mtokens, 0) / 1000

  const totalRebalancedFees = rebalances.reduce((t, p) => t + p.fee_mtokens, 0) / 1000
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

  const totalChainFees = chainFeesSummary.data.reduce((t, v) => t + v, 0)

  const totalFeesPaid = totalRebalancedFees

  const totalProfit = totalEarnedFromForwards - totalChainFees - totalFeesPaid

  // prettier-ignore
  const nodeSummary = `${getDate()}

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
    lifetime all peers sent:          ${pretty(lifetimeSentAll)} sats
    lifetime all peers received:      ${pretty(lifetimeReceivedAll)} sats
    lifetime capacity used:           ${((lifetimeSentAll + lifetimeReceivedAll) / totalLocalSats * 100).toFixed(0)} %
  -------------------------------------------------------------
    (Per last ${DAYS_FOR_STATS} days)

    total earned:                     ${pretty(totalEarnedFromForwards)} sats
    total on-chain fees:              ${pretty(totalChainFees)} sats
    total ln fees paid:               ${pretty(totalFeesPaid)} sats

    NET PROFIT:                       ${pretty(totalProfit)} sats

    LN received from others:          ${pretty(totalReceivedFromOthersLN)} sats (n: ${Object.keys(receivedFromOthersLN).length})
    LN payments to others:            ${pretty(totalSentToOthersLN)} sats, fees: ${pretty(totalSentToOthersFees)} sats (n: ${paidToOthersLN.length})
    LN total rebalanced:              ${pretty(totalRebalances)} sats, fees: ${pretty(totalRebalancedFees)} (n: ${rebalances.length})
    LN total forwarded:               ${pretty(totalRouted)} sats (n: ${totalForwardsCount})

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
    avg earned/routed:                ${(totalEarnedFromForwards / totalRouted * 1e6).toFixed(0)} ppm
    avg net-profit/routed:            ${(totalProfit / totalRouted * 1e6).toFixed(0)} ppm
    avg earned/local:                 ${(totalEarnedFromForwards / totalLocalSats * 1e6).toFixed(0)} ppm
    avg net-profit/local:             ${(totalProfit / totalLocalSats * 1e6).toFixed(0)} ppm
    est. annual ROI:                  ${(totalProfit / DAYS_FOR_STATS * 365.25 / totalLocalSats * 100).toFixed(3)} %
    est. annual profit:               ${pretty(totalProfit / DAYS_FOR_STATS * 365.25)} sats
  -------------------------------------------------------------
    total unbalanced local:           ${pretty(totalLocalSatsOffBalance)} sats
    total unbalanced remote:          ${pretty(abs(totalRemoteSatsOffBalance))} sats
    total unbalanced:                 ${pretty(totalSatsOffBalance)} sats
    total unbalanced sats percent:    ${unbalancedPercent}%
    net unbalanced:                   ${pretty(totalSatsOffBalanceSigned)} sats
    ${
  totalSatsOffBalanceSigned > 420e3
    ? '  (lower on inbound liquidity, get/rent others to open channels to you' +
          ' or loop-out/boltz/muun/WoS LN to on-chain funds)'
    : ''
}
    ${
  totalSatsOffBalanceSigned < 420e3
    ? '  (lower on local sats, so open channels to increase local or reduce' +
          ' amount of remote via loop-in or opening channel to sinks like LOOP)'
    : ''
}
  `
  console.log(nodeSummary)

  // by channel flow rate summary

  // sort by most to least flow total, normalized by capacity
  // higher rating uses capacity better and recommended for size up
  // lower rating uses capacity worse or not at all and recommended for changes
  // const score = p => (p.routed_out_msats + p.routed_in_msats) / p.capacity // uses available capacity best
  // const score = p => ((p.routed_out_fees_msats + p.routed_in_fees_msats) / p.capacity) * 1e6 // best returns for available capacity
  const score = p => p.routed_out_fees_msats + p.routed_in_fees_msats // best returns overall

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
        ? `last ∆ppm: ${lastPpmChange.ppm_old}->${lastPpmChange.ppm}ppm @ ` +
          `${(lastPpmChangeMinutes / 60 / 24).toFixed(1)} days ago`
        : ''

    const lastRoutedIn = (Date.now() - p.routed_in_last_at) / (1000 * 60 * 60 * 24)
    const lastRoutedInString =
      lastRoutedIn > DAYS_FOR_STATS
        ? `routed-in (<--) ${DAYS_FOR_STATS}+? days ago`
        : `routed-in (<--) ${lastRoutedIn.toFixed(1)} days ago`
    const lastRoutedOut = (Date.now() - p.routed_out_last_at) / (1000 * 60 * 60 * 24)
    const lastRoutedOutString =
      lastRoutedOut > DAYS_FOR_STATS
        ? `routed-out (-->) ${DAYS_FOR_STATS}+? days ago`
        : `routed-out (-->) ${lastRoutedOut.toFixed(1)} days ago`

    const issues = []

    if (p.rebalanced_out_msats > 0 && p.rebalanced_in_msats > 0) issues.push('2-WAY-REBALANCE')
    // warning if fee is lower than needed for rebalancing on remote heavy channel with no flow in
    if (
      p.outbound_liquidity < 1e6 &&
      p.routed_in_msats === 0 &&
      rebalanceSuggestionHistory.o.median &&
      rebalanceSuggestionHistory.o.bottom25 > p.fee_rate
    ) {
      issues.push('FEE-STUCK-LOW')
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

    // prettier-ignore
    flowRateSummary += `${('#' + (i + 1)).padStart(4)} ${pretty(score(p))}
      ${' '.repeat(15)}me  ${(p.fee_rate + 'ppm').padStart(7)} [-${local}--|--${remote}-] ${(p.inbound_fee_rate + 'ppm').padEnd(7)} ${p.alias} (./peers/${p.public_key.slice(0, 10)}.json) ${p.balance.toFixed(1)}b ${isNetOutflowing(p) ? 'F_net-->' : ''}${isNetInflowing(p) ? '<--F_net' : ''} ${issuesString}
      ${dim}${routeIn.padStart(26)} <---- routing ----> ${routeOut.padEnd(23)} +${routeOutEarned.padEnd(17)} ${routeInPpm.padStart(5)}|${routeOutPpm.padEnd(10)} ${('#' + p.routed_in_count).padStart(5)}|#${p.routed_out_count.toString().padEnd(5)}${undim}
      ${dim}${rebIn.padStart(26)} <-- rebalancing --> ${rebOut.padEnd(23)} -${rebOutFees.padEnd(17)} ${rebInPpm.padStart(5)}|${rebOutPpm.padEnd(10)} ${('#' + p.rebalanced_in_count).padStart(5)}|#${p.rebalanced_out_count.toString().padEnd(5)}${undim}
      ${dim}${lifeTimeReceivedFlowrate.padStart(26)} <- avg. lifetime -> ${lifetimeSentFlowrate.padEnd(23)} ${capacityUsed.padStart(18)} over ${oldestChannelAge}
      ${dim}${' '.repeat(17)}rebalances-in (<--) used (ppm): ${rebalanceHistory.s}${undim}
      ${dim}${' '.repeat(17)}rebalances-in (<--) est. (ppm): ${rebalanceSuggestionHistory.s}${undim}
      ${dim}${' '.repeat(17)}${lastRoutedInString}, ${lastRoutedOutString}, ${lastPpmChangeString || 'no ppm change data found'}${undim}

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
}

const readRecord = publicKey => {
  const fullPath = PEERS_LOG_PATH + '/' + publicKey.slice(0, 10) + '.json'
  let oldRecord = { rebalance: [] }
  try {
    if (fs.existsSync(fullPath)) {
      oldRecord = JSON.parse(fs.readFileSync(fullPath))
      // get rid of bad data and rediculous suggestions
      const balancingData = oldRecord.rebalance || []

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

// gets peers info including using previous slow to generate snapshot data
// can use await generateSnapshots() instead to get fully updated stats for _all_ peers
const runBotGetPeers = async ({ all = false } = {}) => {
  const getMyFees = await bos.getFees()
  const getPeers = all
    ? await bos.peers({
        is_active: undefined,
        is_public: undefined
        // earnings_days: DAYS_FOR_STATS // too little info
      })
    : await bos.peers()

  // add to default peer data
  const peers = getPeers
    .map(p => {
      p.fee_rate = +getMyFees[p.public_key] || 0
      doBonusPeerCalcs(p)
      return p
    })
    // remove offline peers if not all to be shown
    .filter(p => !p.is_offline || all)
    // sort by local sats by default
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
  p.unbalancedSatsSigned = trunc(p.outbound_liquidity * 0.5 - p.inbound_liquidity * 0.5)
  p.unbalancedSats = abs(p.unbalancedSatsSigned)
}

const isNetOutflowing = p => p.routed_out_msats - p.routed_in_msats > 0
const isNetInflowing = p => p.routed_out_msats - p.routed_in_msats < 0

const getDay = () => new Date().toISOString().slice(0, 10)

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
    top: f(tr(sorted[numbers.length - 1]))
  }

  const { bottom, bottom25, median, avg, top75, top } = result

  // const stringOutput = JSON.stringify(result, fixJSON)
  const stringOutput =
    `(n: ${n}) min: ${bottom}, 1/4th: ${bottom25}, ` + `median: ${median}, avg: ${avg}, 3/4th: ${top75}, max: ${top}`

  // return !obj ? stringOutput : result
  return { s: stringOutput, o: result }
}

// console log colors
const dim = '\x1b[2m'
const undim = '\x1b[0m'
console.boring = (...args) => console.log(`${dim}${args}${undim}`)

const pretty = n => String(trunc(n || 0)).replace(/\B(?=(\d{3})+\b)/g, '_')

const stylingPatterns = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g

const fixJSON = (k, v) => (v === undefined ? null : v)

const getDate = timestamp => (timestamp ? new Date(timestamp) : new Date()).toISOString()

generateSnapshots()
