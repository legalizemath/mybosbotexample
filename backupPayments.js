import fs from 'fs'
import bos from './bos.js'

const LOG_FILES = './logs'
const DAYS_FOR_STATS = 999 // lose any days not backed up

const initialize = async () => {
  if (!fs.existsSync(LOG_FILES)) fs.mkdirSync(LOG_FILES, { recursive: true })

  const payments = await bos.customGetPaymentEvents({ days: DAYS_FOR_STATS })
  fs.writeFileSync(`${LOG_FILES}/${Date.now()}_paymentHistory.json`, JSON.stringify(payments, fixJSON, 2))
  console.log(`${payments.length} payments backed up`)

  const res = await bos.callAPI('deletePayments')
  console.log('all payments deleted from database', res || '')
}

const fixJSON = (k, v) => (v === undefined ? null : v)
initialize()
