// gets fee rates towards a node weighted by capacity % that charges same or lower fee rate.
// gets it for my peers and myself

// like capacity-weighted median
// this way small capacity channel fee rates don't skew incoming fee distribution
// by more than their overall capacity allows
// represents what peers charging towards this node by capacity

// need bos.js & package.json with {"type": "module"} in same folder
// runs with: npm link balanceofsatoshis && node getCapacityFees

import bos from './bos.js'
const { log } = console

const run = async () => {
  const peers = await bos.peers({})
  // .filter(p => +p.inbound_liquidity + +p.outbound_liquidity >= 12e6)
  // .filter(p => p.alias.includes('LOOP'))

  // to print out medians for public key
  const calcCapacityMedians = async ({ public_key, alias = '' }) => {
    const policies = Object.values(await bos.getNodePolicy({ public_key })).filter(v => !isNaN(v.remote.fee_rate))

    // sort by fee rate low to high
    policies.sort((a, b) => a.remote.fee_rate - b.remote.fee_rate)
    const n = policies.length

    const inc = policies.map(c => ({ fee_rate: c.remote.fee_rate, capacity: c.capacity }))
    const totalCapacity = inc.reduce((sum, c) => sum + c.capacity, 0)

    // to get fee at specpfic capacity
    const capacityWeightedFee = targetCapacity => {
      let totalSats = 0
      for (let i = 0; i < inc.length; i++) {
        totalSats += inc[i].capacity
        if (totalSats >= targetCapacity) {
          return inc[i].fee_rate
        }
      }
      return inc[inc.length - 1].fee_rate
    }

    const p25 = capacityWeightedFee(totalCapacity * 0.25).toFixed(0)
    const p50 = capacityWeightedFee(totalCapacity * 0.5).toFixed(0)
    const p75 = capacityWeightedFee(totalCapacity * 0.75).toFixed(0)
    const p88 = capacityWeightedFee(totalCapacity * 0.88).toFixed(0)

    // prettier-ignore
    log(
      `${ca(alias).padStart(30)}  25%:${p25.padEnd(7)} 50%:${p50.padEnd(7)} 75%:${p75.padEnd(7)} 88%:${p88.padEnd(7)} (n:${n})`
    )
  }

  // me
  await calcCapacityMedians({ alias: 'me' })
  log('')
  // peers
  for (const p of peers) {
    await calcCapacityMedians({ public_key: p.public_key, alias: p.alias })
  }
}

const ca = alias => alias.replace(/[^\x00-\x7F]/g, '').trim()
run()
