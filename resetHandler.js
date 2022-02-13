// separate script for sudo permisions if necessary

// can run at start with npm run start-all and this in package.json to give just this script sudo access
// "scripts": {
//   "start": "npm link balanceofsatoshis && node index.js",
//   "start-all": "sudo -b node resetHandler > /dev/null 2>&1 && sudo -k && npm run start",
//   "start-all-log": "sudo -b node resetHandler >resetLogs.txt 2>&1 && sudo -k && npm run start"
// },

import { spawn } from 'child_process'
import fs from 'fs'

const RESET_RESULT_PATH = 'resetDone.json' // file has info on last job done
const RESET_HANDLER_ID_PATH = 'resetID.json' // keeps track of latest loop so just 1 runs

const RESET_REQUEST_PATH = 'resetRequest.json' // this file will stop and start node to reset it
const SHUTDOWN_REQUEST_PATH = 'shutdownRequest.json' // this will stop node and will not start it again

const RESET_STOP_PATH = 'resetStop.json' // this file's existence will always terminate this script

const LOOP_TIME_MS = 15 * 1000 // how often to check for request
const MINUTES_FOR_SHELL_TIMEOUT = 20 // minutes before shell process terminates

// handle resetting services by running the following
const COMMAND_TO_RESET_NODE = 'sudo /home/me/Umbrel/scripts/stop && sleep 10 && sudo /home/me/Umbrel/scripts/start'

// this is 1 time graceful shut down for low power scenario
const COMMAND_TO_SHUTDOWN_NODE = 'sudo /home/me/Umbrel/scripts/stop'

// id = timestamp at initialization
// avoid duplicate handlers
// older handler seeing new handler exists
const id = Date.now()
console.log(`${id} resetHandler() starting`)

// run the check in a loop
const triggerCheckLoop = async () => {
  await runCheck()
  await new Promise(resolve => setTimeout(resolve, LOOP_TIME_MS))
  triggerCheckLoop()
}

// checks if reset needed
const runCheck = async () => {
  const now = Date.now()
  const nowISO = new Date(now).toISOString()

  // check if stop file exists
  if (fs.existsSync(RESET_STOP_PATH)) {
    console.log(`${nowISO} ${RESET_STOP_PATH} file observed, terminating`)
    process.exit(0)
  }

  // make sure this is the oldest process
  try {
    const idFile = JSON.parse(fs.readFileSync(RESET_HANDLER_ID_PATH))
    // if this process is older than one in file, terminate to avoid doubles
    if (idFile.id && id < idFile.id) {
      console.log(`${nowISO} ${RESET_HANDLER_ID_PATH} file has newer id, terminating`)
      process.exit(0)
    }
  } catch (e) {}
  // write surviving id to file
  fs.writeFileSync(RESET_HANDLER_ID_PATH, JSON.stringify({ id }))

  // check if requests to reset node exists
  const resetRequestFound = fs.existsSync(RESET_REQUEST_PATH)

  // new request so take action
  if (resetRequestFound) {
    console.log(`${nowISO} reset request file found ${RESET_REQUEST_PATH}`)
    const res = await runShellCommand(COMMAND_TO_RESET_NODE, { log: true })
    // record result
    fs.writeFileSync(RESET_RESULT_PATH, JSON.stringify({ id, now, nowISO, res }, null, 2))
    console.log(`${nowISO} reset done by ${id}`, res)

    // get rid of request to show its done
    fs.unlinkSync(RESET_REQUEST_PATH)
    console.log(`${nowISO} reset request removed by ${id}`)
  }

  // check if requests to reset node exists
  const shutdownRequestFound = fs.existsSync(SHUTDOWN_REQUEST_PATH)

  // new request so take action
  if (shutdownRequestFound) {
    console.log(`${nowISO} shutdown request file found ${SHUTDOWN_REQUEST_PATH}`)
    const res = await runShellCommand(COMMAND_TO_SHUTDOWN_NODE, { log: true })
    // record result
    fs.writeFileSync(RESET_RESULT_PATH, JSON.stringify({ id, now, nowISO, res }, null, 2))
    console.log(`${nowISO} shutdown done by ${id}`, res)

    // get rid of request to show its done
    fs.unlinkSync(SHUTDOWN_REQUEST_PATH)
    console.log(`${nowISO} shutdown request removed by ${id}`)
  }
  return null
}

// handles shell commands
const runShellCommand = async (command, { log = true, timeout = MINUTES_FOR_SHELL_TIMEOUT * 60 * 1000 } = {}) => {
  let stdout = []
  const stderr = []
  return new Promise((resolve, reject) => {
    const execShell = spawn(command, {
      shell: true,
      // stdio: 'inherit', // write out outputs
      timeout
    })

    console.log(`Running "${command}" w/ PID ${execShell.pid} and ${timeout} ms timeout`)

    execShell.stdout.on('data', d => {
      stdout = [...stdout, ...String(d).split('\n').slice(0, -1)]
      log && console.log(`Data :: PID ${execShell.pid} .stdout.on('data', d)=${typeof d}: ${d}`)
    })

    execShell.stderr.on('data', d => {
      // stderr = [...stderr, ...String(d).split('\n').slice(0, -1)]
      stdout = [...stdout, ...String(d).split('\n').slice(0, -1)]
      log && console.log(`STDERR :: PID ${execShell.pid} .stderr.on('data', d)=${typeof d}: ${d}`)
    })

    execShell.on('close', c => {
      log && console.log(`CLOSE :: PID ${execShell.pid} .on('close', c) closed with code: ${c}`)
      resolve({ status: c, stdout, stderr })
    })

    execShell.on('error', d => {
      log && console.log(`ERROR :: PID ${execShell.pid} .stderr.on('error', d)=${typeof d}: ${d}`)
      reject(new Error({ status: d, stdout, stderr }))
    })
  })
}

triggerCheckLoop()
