// e.g.
// ~46.6% loaded, old Db: 25.402GB, recomp Db: 11.843GB, left est: 33.90 minutes

import fs from 'fs'

const DB_PATH = '/home/me/Umbrel/lnd/data/graph/mainnet/channel.db' // old db
const oldDb = fs.statSync(DB_PATH).size / 1024 / 1024 / 1024 // GB

const DB_PATH2 = '/home/me/Umbrel/lnd/data/graph/mainnet/temp-dont-use.db' // temp file, later new db

let startingPercent
const startingTime = Date.now()
const run = async () => {
  while (fs.existsSync(DB_PATH2)) {
    const newDb = fs.statSync(DB_PATH2).size / 1024 / 1024 / 1024 // GB

    const percent = (newDb / oldDb) * 100
    startingPercent ??= percent
    const rate = (percent - startingPercent) / (Date.now() - startingTime) // percent per msec
    const estLeftMinutes = (100 - percent) / rate / 1000 / 60

    console.log(
      `~${percent.toFixed(1)}% loaded,`,
      `old Db: ${oldDb.toFixed(3)}GB,`,
      `recomp Db: ${newDb.toFixed(3)}GB,`,
      `left est: ${estLeftMinutes.toFixed(2)} minutes`
    )
    await new Promise(resolve => setTimeout(resolve, 30000))
  }
}
run()
