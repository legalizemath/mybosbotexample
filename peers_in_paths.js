import fs from 'fs'
import bos from './bos.js'

const LOG_FILES = './logs'
const DAYS_FOR_STATS = 14
const SNAPSHOTS_PATH = './snapshots'
const SHOW_PEERS = false

const initialize = async () => {
  const me = (await bos.callAPI('getIdentity')).public_key

  // get payments
  const getPaymentEvents = await bos.customGetPaymentEvents({
    days: DAYS_FOR_STATS
  })
  const res = fs.readdirSync(LOG_FILES) || []
  const paymentLogFiles = res.filter(f => f.match(/_paymentHistory/))
  const isRecent = t => Date.now() - t < DAYS_FOR_STATS * 24 * 60 * 60 * 1000
  console.boring(`${getDate()} ${getPaymentEvents.length} payment records found in db`)
  for (const fileName of paymentLogFiles) {
    const timestamp = fileName.split('_')[0]
    if (!isRecent(timestamp)) continue // log file older than oldest needed record
    const payments = JSON.parse(fs.readFileSync(`${LOG_FILES}/${fileName}`))
    getPaymentEvents.push(...payments.filter(p => isRecent(p.created_at_ms)))
    console.boring(`${getDate()} ${getPaymentEvents.length} payment records after log file`)
  }
  // select just rebalances
  const rebalances = getPaymentEvents.filter(p => p.destination === me)

  const usedNodes = rebalances.reduce((soFar, r) => {
    // for (const [i, hop] of Object.keys(r.hops).entries()) {
    for (let i = 0; i < r.hops.length; i++) {
      const hop = r.hops[i]
      if (i === 0 || i >= r.hops.length - 1) continue
      soFar[hop] = {
        count: (soFar[hop]?.count || 0) + 1,
        public_key: hop,
        alias: ''
      }
    }
    return soFar
  }, {})

  // get rid of my node
  delete usedNodes[me]

  // get rid of known peers
  const peers = JSON.parse(fs.readFileSync(`${SNAPSHOTS_PATH}/peers.json`))
  for (const peer of peers) {
    if (!SHOW_PEERS) {
      delete usedNodes[peer.public_key]
      continue
    }
    if (usedNodes[peer.public_key]) usedNodes[peer.public_key].isPeer = true
  }

  const sortedNodes = Object.values(usedNodes).sort((a, b) => b.count - a.count)

  for (const node of sortedNodes) {
    try {
      const nodeInfo = await bos.callAPI('getNode', { public_key: node.public_key })
      node.alias = nodeInfo.alias
    } catch (e) {}
  }

  const resultNodes = sortedNodes
    .filter(n => n.count > 1)
    .map(n => `${n.count.toFixed(0).padStart(3)} ${n.alias.padEnd(30)} ${n.public_key} ${n.isPeer ? '*' : ''}`)

  console.log(`Nodes by use count in rebalances in ${DAYS_FOR_STATS} days back range. If shown peers are marked by *`)

  for (const line of resultNodes) {
    console.log(line)
  }

  // console.log(sortedNodes[0])
}

console.boring = args => console.log(`\x1b[2m${args}\x1b[0m`)
const getDate = timestamp => (timestamp ? new Date(timestamp) : new Date()).toISOString()

initialize()
