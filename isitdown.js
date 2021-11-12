// need to run npm link balanceofsatoshis in folder & bos.js & package.json with {"type": "module"}
// run for peers like this: `node isitdown silk node` or `npm link balanceofsatoshis && node isitdown acinq`
// returns something like `2.0% of 49 channels disabled towards Silk Node 🐪`

import bos from './bos.js'
const matchString = process.argv.slice(2).join(' ')

const run = async () => {
  const peers = await bos.peers({ is_active: undefined, is_public: undefined })

  const peer = peers.find(
    p =>
      p.alias.toLowerCase() === matchString.toLowerCase() ||
      p.public_key === matchString ||
      p.alias.toLowerCase().includes(matchString.toLowerCase()) ||
      p.public_key.includes(matchString)
  )

  if (!peer) console.log('peer not found')

  const policies = await bos.getNodeChannels({ public_key: peer.public_key })

  let disabledCounter = 0
  const totalChannels = Object.keys(policies).length
  for (const channel of Object.values(policies)) {
    if (channel.remote.is_disabled) disabledCounter++
  }
  const percentDisabled = ((disabledCounter / totalChannels) * 100).toFixed(1)
  console.log(`~${percentDisabled}% of ${totalChannels} channels disabled towards ${peer.alias}`)
}
run()
