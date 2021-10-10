// needs visualize.js and bos.js, the wrapper, in same folder
// run with: npm link balanceofsatoshis && node visualize
// makes webpage visual available on local machine at e.g. http://localhost:7890
// and local network at e.g. http://192.168.1.123:7890
// umbrel shortcut for local address also works with port specified, e.g.: http://umbrel.local:7890
// then just need to open the page and set settings with query string
// xAxis, yAxis, and rAxis can be set to days', ppm, routed, earned, count (for grouped)
// can combine items into xGroups number of groups along x axis
// ppm, routed, earned will be plotted in log scale, days in linear
// e.g.
// http://192.168.1.123:7890/?daysForStats=14&xAxis=ppm&yAxis=earned
// http://192.168.1.123:7890/?daysForStats=14&xAxis=ppm&yAxis=earned&xGroups=10
// http://192.168.1.123:7890/?daysForStats=14&xAxis=ppm&yAxis=earned&out=aci
// http://192.168.1.123:7890/?daysForStats=14&xAxis=ppm&yAxis=earned&from=acinq
// http://192.168.1.123:7890/?daysForStats=14&xAxis=days&yAxis=earned
// http://192.168.1.123:7890/?daysForStats=14&xAxis=days&yAxis=earned&xGroups=10
// http://192.168.1.123:7890/?daysForStats=90&xAxis=days&yAxis=earned&xGroups=10&type=line
// http://192.168.1.123:7890/?daysForStats=30&xAxis=ppm&yAxis=earned&rAxis=count&xGroups=15
// http://192.168.1.123:7890/?daysForStats=7&xAxis=ppm&yAxis=earned&rAxis=routed
// http://192.168.1.123:7890/?daysForStats=7&xAxis=days&yAxis=earned&rAxis=count&xGroups=20
// http://192.168.1.123:7890/?daysForStats=30&yAxis=count&xAxis=routed&xGroups=21&type=line

import bos from './bos.js'
import fs from 'fs'
import os from 'os'

import http from 'http'
import url from 'url'

let networkLocation = 'localhost' // will try to overwrite with local network address
const HTML_PORT = '7890' // 80 probably taken

// eslint-disable-next-line no-unused-vars
const { max, min, floor, ceil, abs, trunc, log, exp, sqrt, pow, log10 } = Math
// eslint-disable-next-line no-extend-native
Object.defineProperty(Array.prototype, 'fsort', {
  value: function (compare) {
    return [].concat(this).sort(compare)
  }
})

// const xGroups = 300
// const daysForStats = 30
// const radiusLabel = 'Area ∝ earned amt' // 'Area ∝ count'
// const yAxisLabel = 'Count' // 'Earned fees /sats'
// const xAxisLabel = 'Fee /ppm'
// const xAxisLabel = 'Days' // 'Effective fee /ppm'

const logPlots = ['ppm', 'earned', 'routed']

const generatePage = async ({
  daysForStats = 7,
  xGroups = 0, // round number of groups along x axis
  rAxis = '', // ppm, earned, routed, count
  xAxis = 'ppm', // days, ppm, earned, routed
  yAxis = 'routed', // days, ppm, earned, routed, count
  out = '', // partial alias or public key match
  from = '', // partial alias or public key match
  type = 'bubble' // can also be line
}) => {
  // ensure integers where necessary
  if (xGroups) xGroups = +xGroups
  if (daysForStats) daysForStats = +daysForStats

  let peerForwards = []
  const pubkeyToAlias = {}
  let peerOut, peerIn

  const peers = await bos.peers({ is_active: undefined })

  peers.forEach(p => {
    pubkeyToAlias[p.public_key] = p.alias
  })

  const peersForwards = await bos.customGetForwardingEvents({
    days: daysForStats,
    timeArray: true
  })

  // specific peer or all
  if (out || from) {
    // if specific peer try to find alias data
    if (out) {
      peerOut =
        peers.find(p => p.public_key.includes(out.toLowerCase())) ||
        peers.find(p => p.alias.toLowerCase() === out.toLowerCase()) ||
        peers.find(p => p.alias.toLowerCase().includes(out.toLowerCase()))
    }

    if (from) {
      peerIn =
        peers.find(p => p.public_key.includes(from.toLowerCase())) ||
        peers.find(p => p.alias.toLowerCase() === from.toLowerCase()) ||
        peers.find(p => p.alias.toLowerCase().includes(from.toLowerCase()))
    }

    peerForwards = peersForwards
      .filter(p => !out || p.outgoing_peer === peerOut.public_key)
      .filter(p => !from || p.incoming_peer === peerIn.public_key)
  } else {
    // if every peer
    peerForwards = peersForwards
  }

  // console.log(peerForwards[0])
  console.log('loaded forwards, n:', peerForwards.length, out)

  // console.log(Object.keys(peersForwards).length)

  const getMinMax = arr => {
    let myMin = Infinity
    let myMax = 0
    arr.forEach(d => {
      // eslint-disable-next-line no-extra-semi
      ;[myMin, myMax] = [min(d, myMin), max(d, myMax)]
    })
    return [myMin, myMax]
  }

  // eslint-disable-next-line no-unused-vars
  const [minTime, maxTime] = getMinMax(peerForwards.map(f => f.created_at_ms))

  // turn into data
  const now = Date.now()
  const data = peerForwards.map(p => {
    return {
      ppm: (1e6 * p.fee_mtokens) / p.mtokens,
      // days since earliest event
      // days: (p.created_at_ms - maxTime) / 1000 / 60 / 60 / 24,
      days: -(now - p.created_at_ms) / 1000 / 60 / 60 / 24,
      time: new Date(p.created_at_ms).toISOString(),
      // hour: (new Date(p.created_at_ms).getUTCHours() + 24 - 5) % 24, // 24 hours EST time
      routed: p.mtokens / 1000,
      earned: p.fee_mtokens / 1000,
      from: pubkeyToAlias[p.incoming_peer] || p.incoming_peer,
      to: pubkeyToAlias[p.outgoing_peer] || p.outgoing_peer
    }
  })

  // aggregate data

  const isTimeOnX = xAxis === 'days'
  const isGrouped = xGroups !== 0

  const isLogX = logPlots.some(a => a === xAxis)
  const isLogY = logPlots.some(a => a === yAxis)

  // use non-0 values only for log plot
  const [xMin, xMax] = getMinMax(data.map(d => d[xAxis]).filter(d => !isLogX || d > 0))

  const linSize = abs(xMax - xMin) / xGroups

  const multiple = pow(xMax / xMin, 1 / xGroups)
  const logLevels = []
  if (isLogX & isGrouped) {
    for (let i = 0; i < xGroups; i++) logLevels.unshift(xMin * pow(multiple, i))
  }
  // if (isLogX & isGrouped) console.log({ multiple, xMax, xMin, xGroups, logLevels, logLevelsLength: logLevels.length })
  // find highest "rounded" level below data point and then move 1/2 level up for middle of range
  const gLog = v => (logLevels.find(L => L <= v) || logLevels[logLevels.length - 1]) * pow(multiple, 0.5) //
  const gLinear = (v, size) => ceil(v / size) * size // + 0.5 * size // was wrapped in trunc

  const dataGroups = {}
  if (isGrouped) {
    data.forEach(d => {
      // const group = gLog(d.ppm) // gLinear(d.ppm, xSize)
      const group = isLogX ? gLog(d[xAxis]) : gLinear(d[xAxis], linSize)
      // if (group === undefined) console.log(gLinear(d[xAxis], linSize))
      const routed = (dataGroups[String(group)]?.routed || 0) + d.routed
      const earned = (dataGroups[String(group)]?.earned || 0) + d.earned
      const count = (dataGroups[String(group)]?.count || 0) + 1
      // const ppm = xAxis === 'ppm' ? group : (earned / routed) * 1e6
      const ppm = (earned / routed) * 1e6 // actual total effective ppm
      const days = xAxis === 'days' ? group : d.days
      dataGroups[String(group)] = { days, routed, earned, count, ppm, group }
    })
  }

  // if time, the oldest day will be partial and thus show invalid data
  const dataAfterGrouping = isTimeOnX
    ? Object.values(dataGroups)
        .fsort((a, b) => a[xAxis] - b[xAxis])
        .slice(1)
    : Object.values(dataGroups)

  const dataForPlot = (isGrouped ? dataAfterGrouping : data)
    // including everything plus actually define x, y, r
    .map(d => ({ ...d, x: d.group ?? d[xAxis], y: d[yAxis], r: sqrt(d[rAxis] || 1) }))
    // for line plots this helps
    .fsort((a, b) => a.x - b.x)

  // fix radius
  const [rMin, rMax] = getMinMax(dataForPlot.map(d2 => d2.r))
  const scaleFromTo = ({ v, minFrom, maxFrom, minTo, maxTo }) =>
    maxFrom > minFrom ? ((v - minFrom) / (maxFrom - minFrom)) * (maxTo - minTo) + minTo : minTo
  const MIN_RADIUS_PX = 2
  const MAX_RADIUS_PX = 8
  dataForPlot.forEach(d2 => {
    d2.r = scaleFromTo({ v: d2.r, minFrom: rMin, maxFrom: rMax, minTo: MIN_RADIUS_PX, maxTo: MAX_RADIUS_PX })
  })

  const [, xMaxPlot] = getMinMax(dataForPlot.map(d => d.x))
  const [, yMaxPlot] = getMinMax(dataForPlot.map(d => d.y))

  const dataString1 = JSON.stringify(dataForPlot)

  const outOf = out ? 'out of ' + peerOut?.alias : ''
  const inFrom = from ? 'in from ' + peerIn?.alias : ''

  // annoys me can't see max axis label on some log axis
  const logMaxX = isLogX ? pow(10, ceil(log10(xMaxPlot))) : null
  const logMaxY = isLogY ? pow(10, ceil(log10(yMaxPlot))) : null

  // if few enough show what specific events are
  if (!isGrouped && dataForPlot.length < 42) {
    for (const f of dataForPlot) {
      console.log(`from: ${f.from.padEnd(28)} to: ${f.to.padEnd(28)} amt: ${f.routed.toFixed(3).padStart(15)}`)
    }
  }

  console.log('showing points:', dataForPlot.length)
  // console.log(dataForPlot[0])
  // console.log({ logMaxX, logMaxY, xMaxPlot, yMaxPlot })

  // https://cdnjs.com/libraries/Chart.js
  // prettier-ignore
  const myPage = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style type="text/css">
    body {
      background-color: #fff;
    }
    #title {
      font-size: 19pt;
      text-align: center;
      padding: 1.5vh;
      padding-top: 2vh;
    }
  </style>
</head>
<body>

  <div id="title">Peer forwards for past ${daysForStats} days<br>${outOf}${outOf && inFrom ? ', ' : ''}${inFrom}</div>
  <div class="chart-container" style="position: relative; height: 80vh; width: 80vw; margin: 3vh auto;">
  <canvas id="chart" width="400" height="400"></canvas>
  </div>
  <script
    src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/3.5.1/chart.min.js"
    integrity="sha512-Wt1bJGtlnMtGP0dqNFH1xlkLBNpEodaiQ8ZN5JLA5wpc1sUlk/O5uuOMNgvzddzkpvZ9GLyYNa8w2s7rqiTk5Q=="
    crossorigin="anonymous"
    referrerpolicy="no-referrer"
  ></script>
  <script>
  /* eslint-disable */
  const options = {
    plugins: {
      tooltip: {
        callbacks: {
          label: function(context) {
            return Object.keys(context.raw).map(k => k + ': ' + context.raw[k])
          }
        }
      }
    },
    responsive: true,
    maintainAspectRatio: false,
    stacked: false,
    lineTension: 0.5,
    scales: {
      x: {
        type: '${isLogX ? 'logarithmic' : 'linear'}',
        // type: 'linear',
        // min: 100,
        ${logMaxX ? 'max: ' + logMaxX + ',' : ''}
        suggestedMax: 0,
        position: 'bottom',
        grace: '10%',
        title: {
          display: true,
          text: '${xAxis}'
        }
      },
      y: {
        type: '${isLogY ? 'logarithmic' : 'linear'}',
        // min: 100,
        ${logMaxY ? 'max: ' + logMaxY + ',' : ''}
        // suggestedMax: 100e6,
        grace: '10%',
        position: 'left',
        title: {
          display: true,
          text: '${yAxis}'
        }
      }
    }
  }

  Chart.defaults.font.size = 21

  const labelRadius = '${rAxis && type === 'bubble' ? 'area ∝ ' + rAxis + ', ' : ' '}'
  const labelGroups = '${xGroups ? `grouped into ${xGroups} x-axis regions, ` : ' '}'
  const labelCount = 'forwards count: ${peerForwards.length}'
  const data = {
    datasets: [
      {
        label: (labelRadius + labelGroups + labelCount).trim(),
        pointHoverRadius: 3,
        data: ${dataString1},
        backgroundColor: 'rgb(255, 99, 132)',
        yAxisID: 'y'
      }
    ]
  }
  new Chart('chart', {
    type: '${type}',
    options,
    data
  })

  </script>
</body>
</html>
`

  fs.writeFileSync('./visualize.html', myPage)
  return myPage
}

// this gets local network ip
const interfaces = os.networkInterfaces()
for (const k in interfaces) {
  for (const k2 in interfaces[k]) {
    const address = interfaces[k][k2]
    if (address.address.startsWith('192.168')) {
      networkLocation = address.address
      break
    }
  }
}

if (networkLocation === 'localhost') {
  console.log('no local network ip found')
}

// serve html on HOST:HTML_PORT
;(async () => {
  const server = http.createServer(async (req, res) => {
    // print request url info
    const pageSettings = url.parse(req.url, true).query
    // console.log(url.parse(req.url, true))

    // generate response
    res.setHeader('Content-Type', 'text/html')
    console.log({ pageSettings })
    if (!pageSettings || !Object.keys(pageSettings).length) {
      // redirect to page with querry items written out for easier editing

      res.writeHead(301, { Location: '/?daysForStats=7&xGroups=0&xAxis=ppm&yAxis=routed&out=&from=&type=bubble' })
      res.end()
    } else {
      // return the full html page from string
      res.writeHead(200)
      res.end(await generatePage(pageSettings))
    }
  })
  server.listen(HTML_PORT, () => {
    console.log(`Visualization is available on lnd computer at http://localhost:${HTML_PORT}`)
    if (networkLocation !== 'localhost') {
      console.log(`Visualization is available on local network at http://${networkLocation}:${HTML_PORT}`)
      console.log(`If port is closed might need to open. On ubuntu with ufw firewall: sudo ufw allow ${HTML_PORT}`)
    }
  })
})()
