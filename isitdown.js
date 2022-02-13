// need to run npm link balanceofsatoshis in folder & bos.js & package.json with {"type": "module"}
// run for nodes like this: `node isitdown silk node` or `npm link balanceofsatoshis && node isitdown acinq`
// returns something like `2.0% of 49 channels disabled towards Silk Node 🐪`
// node that's down for many might look like this
// `~64.7% of 17 channels disabled towards 0279c1c9df1a7289c14e`

import bos from './bos.js'

const run = async () => {
  const matchString = process.argv.slice(2).join(' ')
  const peers = await bos.peers({})

  let node

  // if me
  if (!matchString) {
    const { public_key, alias } = await bos.callAPI('getWalletInfo')
    node = { public_key, alias }
  }

  // next check peers
  if (!node) {
    node = peers.find(
      p =>
        p.alias.toLowerCase() === matchString.toLowerCase() ||
        p.public_key === matchString ||
        p.alias.toLowerCase().includes(matchString.toLowerCase()) ||
        p.public_key.includes(matchString)
    )
  }

  // maybe it's a node I don't know but graph does
  if (!node) {
    // const res = await bos.getNodeFromGraph({ public_key: matchString })
    const { nodes } = await bos.callAPI('getNetworkGraph')
    if (nodes) {
      node = nodes.find(
        n =>
          // exact matches first
          n.alias.toLowerCase() === matchString.toLowerCase() ||
          n.public_key === matchString ||
          // partial matches next
          n.public_key.includes(matchString) ||
          n.alias.toLowerCase().includes(matchString.toLowerCase())
      )
    }
  }

  // ok give up
  if (!node) return console.log('node not found')
  else console.log(`found ${node.alias} | ${node.public_key}`)

  const count = await bos.getRemoteDisabledCount({ public_key: node.public_key })

  if (!count) return console.log('no clear graph data counts')
  console.log(
    `~${count.remoteDisabledPercent}% or ${count.remoteDisabled}/${count.totalPeers} peers disabled channels towards ${node.alias} from graph data`
  )

  // quick self checks
  const myInboundDisabled = peers.reduce((sum, p) => (p.is_inbound_disabled ? sum + 1 : sum), 0)
  const offlinePeers = peers.reduce((sum, p) => (p.is_offline ? sum + 1 : sum), 0)
  const offlineAndInboundDisabled = peers.reduce((sum, p) => (p.is_offline && p.is_inbound_disabled ? sum + 1 : sum), 0)
  const myPeersCount = peers.length
  console.log('\nself check with bos peers command\n', {
    myPeersCount,
    offlinePeers,
    myInboundDisabled,
    offlineAndInboundDisabled
  })
}
run()
