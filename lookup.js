import fs from 'fs'

const BALANCING_LOG_PATH = './peers'
const SNAPSHOTS_PATH = './snapshots'

// e.g. "node lookup aci" ->
// pull data from peer logs & peers snapshot for ACINQ
const initialize = async () => {
  const toMatch = process.argv.slice(2).join('')

  if (!toMatch) console.log('nothing given to match')

  const peers = JSON.parse(fs.readFileSync(`${SNAPSHOTS_PATH}/peers.json`))

  // exact match, then partial
  const peer =
    peers.find(p => p.alias.toLowerCase() === toMatch.toLowerCase()) ||
    peers.find(p => p.alias.toLowerCase().includes(toMatch.toLowerCase()))

  if (!peer) {
    console.log('peer not found')
    return null
  }

  console.log(peer)

  const logFile = BALANCING_LOG_PATH + '/' + peer.public_key.slice(0, 10) + '.json'

  const logFileData = fs.existsSync(logFile) && JSON.parse(fs.readFileSync(logFile))

  if (!logFileData) {
    console.log('balancing log not found')
    return null
  } else {
    console.log(logFile)
  }

  const { ppmTargets, ppmAll, ppmWorked, feeChanges } = logFileData

  console.log({
    'last pass target ppm': JSON.stringify(ppmTargets),
    'done + suggested ppm': JSON.stringify(ppmAll),
    'done rebalances ppm': JSON.stringify(ppmWorked)
  })

  console.log({ ppm_history: JSON.stringify(feeChanges?.map(c => c.ppm)) })
}
initialize()
