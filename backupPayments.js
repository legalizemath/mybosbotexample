import fs from 'fs'
import bos from './bos.js'

const LOG_FILES = './logs'
const DAYS_FOR_STATS = 999 // enough to capture all payments needed before deletion

const initialize = async () => {
  // make folder if necessary
  if (!fs.existsSync(LOG_FILES)) {
    fs.mkdirSync(LOG_FILES, { recursive: true })
  }
  // get payments
  const payments = await bos.customGetPaymentEvents({ days: DAYS_FOR_STATS })
  // put payments into a file with timestamp in name
  fs.writeFileSync(`${LOG_FILES}/${Date.now()}_paymentHistory.json`, JSON.stringify(payments, fixJSON, 2))
  console.log(`${payments.length} payments backed up`)
  // clear payments from database
  const res = await bos.callAPI('deletePayments')
  console.log('all payments deleted from database', res)
}
const fixJSON = (k, v) => (v === undefined ? null : v)
initialize()
