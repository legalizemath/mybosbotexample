import fs from 'fs'
import bos from './bos.js'

const LOG_FILES = './logs' // place I backup payments I delete from db (optional)
const DAYS_FOR_STATS = 30 // days back to look
const SHOW_PEERS = false // hide direct peers even if used in non-direct path

const initialize = async () => {
  const me = (await bos.callAPI('getIdentity'))?.public_key

  // get payments
  const paymentEvents = await bos.customGetPaymentEvents({
    days: DAYS_FOR_STATS
  })
  // add in payments from backups
  const res = fs.existsSync(LOG_FILES) ? fs.readdirSync(LOG_FILES) : []
  const paymentLogFiles = res.filter(f => f.match(/_paymentHistory/))
  const isRecent = t => Date.now() - t < DAYS_FOR_STATS * 24 * 60 * 60 * 1000
  console.boring(`${getDate()} ${paymentEvents.length} payment records found in db`)
  for (const fileName of paymentLogFiles) {
    const timestamp = fileName.split('_')[0]
    if (!isRecent(timestamp)) continue // log file older than oldest needed record
    const payments = JSON.parse(fs.readFileSync(`${LOG_FILES}/${fileName}`))
    paymentEvents.push(...payments.filter(p => isRecent(p.created_at_ms)))
    console.boring(`${getDate()} ${paymentEvents.length} payment records after log file`)
  }

  // figure out which payments to use
  const chosenPayments = paymentEvents
    // only payments of significant size so say 1 sat keysends don't count
    .filter(p => +p.mtokens > 100000)
  // select just rebalances, otherwise would be all successful payments
  // .filter(p => p.destination === me)

  const usedNodes = chosenPayments.reduce((soFar, r) => {
    // skipping 1st and last hop bc those would be my channels or recepient w/o next hop
    for (let i = 1; i < r.hops.length - 1; i++) {
      const thisHopKey = r.hops[i]
      const nextHopKey = r.hops[i + 1]
      soFar[thisHopKey] = {
        public_key: r.hops[i],
        alias: '',
        count: 0, // just overall times peer was used
        mtokens: 0, // raw total amount routed through this peer
        mtokensAdj: 0, // weighted amount routed that counts each reuse of path for less
        counts: {}, // counts has keys of next-hop-public-key and values of number of times it was used
        ...(soFar[thisHopKey] ?? {})
      }
      // if we counted this nextHop before add 1, otherwise this is first time (1)
      const thisCount = (soFar[thisHopKey].counts[nextHopKey] || 0) + 1
      // count by each next hop pubkey separately
      soFar[thisHopKey].counts[nextHopKey] = thisCount
      // and basic count (w/o regard for next unique hops)
      soFar[thisHopKey].count++

      // basic sum of amount routed through this peer
      soFar[thisHopKey].mtokens += r.mtokens
      // adjusted count of amount routed thorugh this peer with diminishing returns for
      //    every additoinal time this peer is used
      //    at thisCount = 1, entire amount routed counts, at 2 just half, at 3 a third, so on
      soFar[thisHopKey].mtokensAdj += r.mtokens / thisCount
    }
    return soFar
  }, {})

  // get rid of my node
  delete usedNodes[me]

  // get rid of known direct peers of mine
  const peers = await bos.peers({}) // get all current direct peers
  for (const peer of peers) {
    if (!SHOW_PEERS) {
      delete usedNodes[peer.public_key]
      continue
    }
    // if showing peers, mark them
    if (usedNodes[peer.public_key]) usedNodes[peer.public_key].isPeer = true
  }

  // order to print out results
  const sortedNodes = Object.values(usedNodes).sort(
    // (a, b) => Object.keys(b.counts).length - Object.keys(a.counts).length
    (a, b) => b.mtokensAdj - a.mtokensAdj
  )
  // const sortedNodes = Object.values(usedNodes).sort((a, b) => b.count - a.count)

  for (const node of sortedNodes) {
    try {
      const nodeInfo = await bos.callAPI('getNode', { public_key: node.public_key })
      node.alias = nodeInfo.alias
    } catch (e) {}
  }

  // create array of strings for results per recommendation
  // prettier-ignore
  const resultNodes = sortedNodes
    // remove nodes that were just used via just 1 unique outgoing channel/hop
    .filter(n => Object.keys(n.counts).length > 1)
    // convert to readable string
    .map(
      n => {
        const countUniqueStr = Object.keys(n.counts).length.toFixed(0)
        const countStr = n.count.toFixed(0)
        const aliasStr = ca(n.alias)
        const satsStr = pretty(n.mtokens / 1000)
        const satsAdjStr = pretty(n.mtokensAdj / 1000)
        return [
          satsAdjStr.padStart(15),
          satsStr.padStart(15),
          countStr.padStart(3),
          countUniqueStr.padStart(7),
          aliasStr.padEnd(30),
          n.public_key.padStart(70),
          n.isPeer ? ' *' : '  '
        ]
      }

    )

  // print out results
  console.log(`
Recommended new peer nodes in ${chosenPayments.length} transactions in ${DAYS_FOR_STATS} days back range.
Sorted by sats (adj), which is total sats routed with diminishing new weight each additional time same next-hop is used
${SHOW_PEERS ? 'If SHOW_PEERS, direct peers (used indirectly) are marked by *' : ''}
  `)
  // table headers
  console.log(
    'sats (adj)'.padStart(15),
    'sats'.padStart(15),
    'n'.padStart(3),
    'unique'.padStart(7),
    'alias'.padStart(30),
    'pub key'.padStart(70),
    '\n'
  )
  for (const line of resultNodes) {
    console.log(...line)
  }

  // console.log(sortedNodes[0])
}

console.boring = args => console.log(`\x1b[2m${args}\x1b[0m`)
const getDate = timestamp => (timestamp ? new Date(timestamp) : new Date()).toISOString()
const pretty = n => String(Math.trunc(+n || 0)).replace(/\B(?=(\d{3})+\b)/g, '_')
const ca = alias => (alias || '').replace(/[^\x00-\x7F]/g, '').trim()

initialize()
