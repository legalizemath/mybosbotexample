// needs bos.js and package.json with {"type": "module"} in same folder
// run with "npm link balanceofsatoshis && node getFees

import bos from './bos.js'

const run = async () => {
  const peers = await bos.peers() // active peers
  const getFeeRates = await bos.getNodeChannels({ byPublicKey: true })
  for (const peer of peers) {
    getFeeRates[peer.public_key].forEach(channel => {
      const outgoingFeeRate = channel.local.fee_rate + '  ppm'
      const outgoingBaseFee = channel.local.base_fee_mtokens + ' msats'
      const incFeeRate = channel.remote.fee_rate + '  ppm'
      const incBaseFee = channel.remote.base_fee_mtokens + ' msats'
      console.log(peer.alias, peer.public_key, channel.id)
      console.log(`local:  ${outgoingFeeRate.padStart(10)}  ${outgoingBaseFee.padStart(10)}`)
      console.log(`remote: ${incFeeRate.padStart(10)}  ${incBaseFee.padStart(10)}`)
    })
  }
}
run()
