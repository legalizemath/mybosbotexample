// run with: npm link balanceofsatoshis && node visualize
// needs bos.js, the wrapper, in same folder
// then just need to open the page and set settings with query string
// xAxis, yAxis, and rAxis can be set to days', ppm, routed, earned, count (for grouped)
// can combine items into xGroups number of groups along x axis
// ppm, routed, earned will be plotted in log scale, days in linear
// e.g.
// http://localhost:7890/?daysForStats=14&xAxis=ppm&yAxis=earned
// http://localhost:7890/?daysForStats=14&xAxis=ppm&yAxis=earned&xGroups=10
// http://localhost:7890/?daysForStats=14&xAxis=ppm&yAxis=earned&out=aci
// http://localhost:7890/?daysForStats=14&xAxis=ppm&yAxis=earned&from=acinq
// http://localhost:7890/?daysForStats=14&xAxis=days&yAxis=earned
// http://localhost:7890/?daysForStats=14&xAxis=days&yAxis=earned&xGroups=10
// http://localhost:7890/?daysForStats=90&xAxis=days&yAxis=earned&xGroups=10&type=line
// http://localhost:7890/?daysForStats=30&xAxis=ppm&yAxis=earned&rAxis=count&xGroups=15
// http://localhost:7890/?daysForStats=7&xAxis=ppm&yAxis=earned&rAxis=routed
// http://localhost:7890/?daysForStats=7&xAxis=days&yAxis=earned&rAxis=count&xGroups=20
// http://localhost:7890/?daysForStats=30&yAxis=count&xAxis=routed&xGroups=21&type=line

import bos from './bos.js'
import fs from 'fs'

import http from 'http'
import url from 'url'

const HOST = 'localhost'
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
  daysForStats,
  xGroups = 0, // round number of groups along x axis
  rAxis = '', // ppm, earned, routed, count
  xAxis = '', // days, ppm, earned, routed
  yAxis = '', // days, ppm, earned, routed, count
  out = '', // partial alias or public key match
  from = '', // partial alias or public key match
  type = 'bubble' // can also be line
}) => {
  // const out = process.argv.slice(2).join(' ')

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
  const data = peerForwards.map(p => {
    return {
      ppm: (1e6 * p.fee_mtokens) / p.mtokens,
      // days since earliest event
      // days: (p.created_at_ms - maxTime) / 1000 / 60 / 60 / 24,
      days: -(Date.now() - p.created_at_ms) / 1000 / 60 / 60 / 24,
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

  const [xMin, xMax] = getMinMax(data.map(d => d[xAxis]))

  const linSize = abs(xMax - xMin) / xGroups

  const multiple = pow(xMax / xMin, 1 / xGroups)
  const logLevels = []
  for (let i = 0; i <= xGroups + 1; i++) logLevels.push(xMin * pow(multiple, i))
  const gLog = v => logLevels.find(L => L > v) * pow(multiple, -0.5) // move half way down
  const gLinear = (v, size) => ceil(v / size) * size // + 0.5 * size // was wrapped in trunc

  const dataGroups = {}
  if (isGrouped) {
    data.forEach(d => {
      // const group = gLog(d.ppm) // gLinear(d.ppm, xSize)
      const group = logPlots.some(a => a === xAxis) ? gLog(d[xAxis]) : gLinear(d[xAxis], linSize)
      const ppm = xAxis === 'ppm' ? group : d.ppm
      const days = xAxis === 'days' ? group : d.days
      const routed = (dataGroups[String(group)]?.routed || 0) + d.routed
      const earned = (dataGroups[String(group)]?.earned || 0) + d.earned
      const count = (dataGroups[String(group)]?.count || 0) + 1
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

  console.log('showing points:', dataForPlot.length)

  const [xMinPlot, xMaxPlot] = getMinMax(dataForPlot.map(d => d.x))
  const [yMinPlot, yMaxPlot] = getMinMax(dataForPlot.map(d => d.y))

  const dataString1 = JSON.stringify(dataForPlot)

  const outOf = out ? 'out of ' + peerOut?.alias : ''
  const inFrom = from ? 'in from ' + peerIn?.alias : ''

  // annoys me can't see max axis label on some log axis
  const logMaxX = logPlots.some(a => a === xAxis) ? pow(10, ceil(log10(xMaxPlot))) : null
  const logMaxY = logPlots.some(a => a === yAxis) ? pow(10, ceil(log10(yMaxPlot))) : null

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
    // tooltips: {
    //   mode: 'index',
    //   intersect: false
    // },
    // hover: {
    //   mode: 'index',
    //   intersect: false
    // },
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
        type: '${logPlots.some(a => a === xAxis) ? 'logarithmic' : 'linear'}',
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
        type: '${logPlots.some(a => a === yAxis) ? 'logarithmic' : 'linear'}',
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

// serve html on HOST:HTML_PORT
;(async () => {
  const server = http.createServer(async (req, res) => {
    // print request url info
    const q = url.parse(req.url, true).query
    // console.log(url.parse(req.url, true))

    // generate response
    res.setHeader('Content-Type', 'text/html')
    res.writeHead(200)
    const pageSettings = {
      daysForStats: 30,
      ...(q || {})
    }
    console.log({ pageSettings })
    res.end(await generatePage(pageSettings))
  })
  server.listen(HTML_PORT, HOST, () => {
    console.log(`Visualization is available on http://${HOST}:${HTML_PORT}`)
  })
})()
