// Script to shut down node by letting current htlcs resolve for X minutes w/o allowing new ones
// run script without sudo for bos auth to work, shell will request it separately if needed

import bos from './bos.js'
import { spawn } from 'child_process'

const SHELL_CMD_NODE_SHUTDOWN = 'sudo /home/me/Umbrel/scripts/stop' // shuts down node

const MINUTES_TO_WAIT_BEFORE_NODE_SHUTDOWN = 11 // this many minutes to wait to resolve old htlcs & block new ones

const NEED_SUDO = true // true = shell will try to ask for sudo ahead of time so its ready later

const run = async () => {
  printout('safe shutdown initiated')

  const auth = await bos.initializeAuth()

  // basically subscribe to new forward requests and reject them all
  printout('blocking new htlcs')
  const subForwardRequests = bos.lnService.subscribeToForwardRequests({ lnd: auth })
  subForwardRequests.on('forward_request', f => {
    // printout('rejected htlc')
    return f.reject()
  })

  // run shell command to shut down node with delay built in
  // if starts root shell with sudo it will ask for permission at start rather than after delay
  // sudo -k removes sudo permission after its not necessary just in case
  const shellCommand = NEED_SUDO
    ? `sudo bash -c 'sleep ${MINUTES_TO_WAIT_BEFORE_NODE_SHUTDOWN}m ; ${SHELL_CMD_NODE_SHUTDOWN}'; sudo -k`
    : `sleep ${MINUTES_TO_WAIT_BEFORE_NODE_SHUTDOWN}m ; ${SHELL_CMD_NODE_SHUTDOWN}`

  printout(`running shell command: "${shellCommand}"`)
  await runShellCommand(shellCommand, {
    log: true,
    timeout: (MINUTES_TO_WAIT_BEFORE_NODE_SHUTDOWN + 21) * 60 * 1000
  })

  printout('done')
  process.exit()
}

const printout = (...args) => {
  // print async when possible
  setImmediate(() => {
    console.log(`${getDate()} ${args.join(' ')}`)
  })
}
const getDate = ts => (ts ? new Date(ts) : new Date()).toISOString()

// handles shell commands
const runShellCommand = async (command, { log = true, timeout = 21 * 60 * 1000 } = {}) => {
  let stdout = []

  return new Promise((resolve, reject) => {
    // run shell command
    const execShell = spawn(command, {
      shell: true,
      stdio: 'inherit', // write out outputs
      timeout
    })
    console.log(`Running "${command}" w/ PID ${execShell.pid} and ${timeout} ms timeout`)

    // record output
    execShell.stdout?.on('data', d => {
      stdout = [...stdout, ...String(d).split('\n').slice(0, -1)]
      log && console.log(`Data :: PID ${execShell.pid} .stdout.on('data', d)=${typeof d}: ${d}`)
    })

    execShell.stderr?.on('data', d => {
      stdout = [...stdout, ...String(d).split('\n').slice(0, -1)]
      log && console.log(`STDERR :: PID ${execShell.pid} .stderr.on('data', d)=${typeof d}: ${d}`)
    })

    execShell.on('close', c => {
      log && console.log(`CLOSE :: PID ${execShell.pid} .on('close', c) closed with code: ${c}`)
      resolve({ status: c, stdout })
    })

    execShell.on('error', d => {
      log && console.log(`ERROR :: PID ${execShell.pid} .stderr.on('error', d)=${typeof d}: ${d}`)
      reject(new Error({ status: d, stdout }))
    })
  })
}

run()
