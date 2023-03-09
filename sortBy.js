// prints out channels sorted by performance like % of capacity moved per week on average over lifetime
// to find best and worst performing channels

import fs from 'node:fs'
const { log } = console
const { max, ceil, trunc } = Math

// by year-mm-dd input or most recent
const param = process.argv.slice(2).join(' ')

const run = async () => {
  const peersNow = JSON.parse(fs.readFileSync('_peers.json'))

  const peers = param ? JSON.parse(fs.readFileSync(`./logs/${param}_peers.json`)) : peersNow

  const select = []

  let totalMoved = 0
  let mostDays = 1

  for (const p of peers) {
    const lifetimeSent = p.ids.reduce((sum, c) => c.sent + sum, 0)
    const lifeTimeReceived = p.ids.reduce((sum, c) => c.received + sum, 0)
    // const capacityTotal = p.capacity
    const oldestChannelDays = p.ids.reduce((oldest, c) => max(ceil(c.channel_age_days), oldest), 0)

    p.satsMovedPerDay = (lifetimeSent + lifeTimeReceived) / oldestChannelDays || 0
    p.oldestChannelDays = oldestChannelDays
    p.capPercentPerWeek = (p.satsMovedPerDay / p.capacity) * 100 * 7 || 0

    // at least 1 channel older than 2 weeks
    if (p.capacity && p.oldestChannelDays >= 14) select.push(p)

    totalMoved += lifetimeSent + lifeTimeReceived
    if (oldestChannelDays) mostDays = max(mostDays, oldestChannelDays)
  }

  // select.sort((a, b) => b.satsMovedPerDay - a.satsMovedPerDay)
  select.sort((a, b) => b.capPercentPerWeek - a.capPercentPerWeek)

  log(
    '\ntotal moved in existing channels:',
    pretty(totalMoved),
    'sats or',
    pretty(totalMoved * 1e-8),
    'BTC, about',
    pretty(totalMoved / mostDays),
    'moved sats / day \n'
  )

  log(
    [
      '#'.padEnd(5),
      'alias'.padStart(30),
      'capacity'.padStart(9),
      'oldest'.padStart(9),
      'sats moved / day'.padStart(20),
      'cap % / week'.padStart(20),
      '(ppm out)'.padStart(10),
      '(ppm in)'.padStart(10),
      'still peer? (then balance now)'.padStart(14)
    ].join(' ')
  )

  for (let i = 0; i < select.length; i++) {
    const s = select[i]
    const bal = s.balance.toFixed(1)
    log(
      [
        (i + 1).toFixed(0).padEnd(5),
        ca(s.alias).padStart(30),
        (s.capacity / 1e6).toFixed(2).padStart(8) + 'M',
        s.oldestChannelDays.toFixed(0).padStart(8) + 'd',
        s.satsMovedPerDay.toFixed(1).padStart(20),
        ((s.satsMovedPerDay / s.capacity) * 100 * 7).toFixed(1).padStart(20),
        `(${s.fee_rate})`.padStart(10),
        `(${s.inbound_fee_rate})`.padStart(10),
        (peersNow.find(p => p.public_key === s.public_key) ? bal : '').padStart(14)
      ].join(' ')
    )
  }
}

const ca = alias => (alias || '').replace(/[^\x00-\x7F]/g, '').trim()
const pretty = n => String(trunc(+n || 0)).replace(/\B(?=(\d{3})+\b)/g, ' ')

run()
