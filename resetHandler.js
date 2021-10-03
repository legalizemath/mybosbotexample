// can run at start with npm run start-all and this in package.json to give just this script sudo access
// "scripts": {
//   "start": "npm link balanceofsatoshis && node index.js",
//   "start-all": "sudo -b node resetHandler > /dev/null 2>&1 && sudo -k && npm run start",

import { spawn } from 'child_process'
import fs from 'fs'

const RESET_ACTION_PATH = 'resetDone.json'
const RESET_REQUEST_PATH = 'resetRequest.json'
const LOOP_TIME_MS = 15 * 1000
const MINUTES_FOR_SHELL_TIMEOUT = 15

// handle resetting services by running the following
// const COMMAND_TO_RUN = 'sudo ls -a'
const COMMAND_TO_RUN = 'sudo /home/me/Umbrel/scripts/stop && sleep 10 && sudo /home/me/Umbrel/scripts/start'

// run in background with "sudo -b node resetHandler > /dev/null 2>&1 && sudo -k"
// or in different terminal with "sudo node resetHandler > /dev/null 2>&1 && sudo -k"

// whenever RESET_REQUEST_PATH file appears with '{ "id': <integer> }
// where id is integer like ms timestamp that's higher than the one in RESET_ACTION_PATH
// can run in separate terminal "sudo node resetHandler"
// or to output printouts to file "sudo -b node resetHandler >resetLogs.txt 2>&1 && sudo -k"
// sudo -b lets you put in sudo pass while & at end would not
// sudo priveleges can be granted to just this command and not entire node script

// avoid duplicate handlers
// older handler seeing new handler exists
const idHandler = Date.now()

const triggerCheckLoop = async () => {
  // check
  await runCheck()

  // sleep
  await new Promise(resolve => setTimeout(resolve, LOOP_TIME_MS))

  // relaunch loop again
  triggerCheckLoop()
}

const runCheck = async () => {
  const now = Date.now()
  const nowISO = new Date(now).toISOString()

  // check for last reset, default 0
  let lastReset = 0
  try {
    const file = JSON.parse(fs.readFileSync(RESET_ACTION_PATH))
    lastReset = file.id || lastReset
    if (file.idHandler && idHandler < file.idHandler) process.exit(0)
    if (file.idHandler !== idHandler) {
      fs.writeFileSync(
        RESET_ACTION_PATH,
        JSON.stringify(
          {
            ...file,
            idHandler
          },
          null,
          2
        )
      )
    }
  } catch (e) {
    console.log(`${nowISO} ${idHandler} no last reset action found`)
    fs.writeFileSync(
      RESET_ACTION_PATH,
      JSON.stringify(
        {
          id: 0,
          idHandler
        },
        null,
        2
      )
    )
  }

  // check for last reset request, default 0
  let lastRequest = 0
  try {
    lastRequest = JSON.parse(fs.readFileSync(RESET_REQUEST_PATH)).id
  } catch (e) {
    console.log(
      `${nowISO} ${idHandler} no ${RESET_REQUEST_PATH} found, e.g.: echo {\\"id\\": ${lastReset}} > ${RESET_REQUEST_PATH}`
    )
  }

  // terminate process signal is -1 (just for testing)
  if (lastRequest === -1) {
    console.log(`${nowISO} ${idHandler} request -1 terminate signal found`)
    // get rid of termination request
    fs.unlinkSync(RESET_REQUEST_PATH)
    // update action file
    fs.writeFileSync(
      RESET_ACTION_PATH,
      JSON.stringify(
        {
          // no change to last reset time
          id: lastReset,
          ranAt: now,
          ranAtISO: nowISO,
          idHandler,
          terminated: true
        },
        null,
        2
      )
    )
    // exit script
    process.exit(0)
  }

  console.log(`${nowISO} ${idHandler} lastRequest: ${lastRequest} | lastReset: ${lastReset}`)

  // if there's no new requests
  if (lastReset >= lastRequest) {
    // request file is outdated if exists, get rid of it
    if (fs.existsSync(RESET_REQUEST_PATH)) fs.unlinkSync(RESET_REQUEST_PATH)
    // this attempt done
    return 1
  }
  // new request so take action
  const res = await runShellCommand(COMMAND_TO_RUN, { log: true })
  console.log(res)

  // record execution time
  fs.writeFileSync(
    RESET_ACTION_PATH,
    JSON.stringify(
      {
        // update for this reset
        id: lastRequest,
        ranAt: now,
        ranAtISO: nowISO,
        idHandler,
        res
      },
      null,
      2
    )
  )
  // get rid of request
  fs.unlinkSync(RESET_REQUEST_PATH)
  console.log(`${nowISO} ${idHandler} files updated`)

  return 0
}

// handles shell commands
const runShellCommand = async (command, { log = false, timeout = MINUTES_FOR_SHELL_TIMEOUT * 60 * 1000 } = {}) => {
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
