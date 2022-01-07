// rejects all new htlcs

import { subscribeToForwardRequests } from 'balanceofsatoshis/node_modules/ln-service/index.js'
import bos from './bos.js'

const initialize = async (showLogs = true) => {
  showLogs && printout('started')
  const auth = await bos.initializeAuth()

  const subForwardRequests = subscribeToForwardRequests({ lnd: auth })

  subForwardRequests.on('forward_request', f => {
    showLogs && printout('rejecting: ' + JSON.stringify(f, null, 2))
    return f.reject()
  })

}

// -------- helpers ----------
const printout = (...args) => {
  // print async when possible
  setImmediate(() => {
    console.log(`${getDate()} htlcLimiter(): ${args.join(' ')}`)
  })
}
const getDate = timestamp => (timestamp ? new Date(timestamp) : new Date()).toISOString()

initialize(true)
