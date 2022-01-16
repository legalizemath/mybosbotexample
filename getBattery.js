// for my laptop's battery

import { spawn } from 'child_process'

// returns integer as % out of 100% of battery or null if not found
const getBattery = async () => {
  const COMMAND =
    'upower -i $(upower -e | grep \'/battery\') | grep --color=never -E "state|to full|to empty|percentage"'
  const res = await runShellCommand(COMMAND)
  const length = res?.stdout?.length
  const found = length && res.stdout[length - 1]?.match(/[0-9]+/)?.[0]
  return +found || null
}

// handles shell commands
const runShellCommand = async (command, { log = false, timeout = 10 * 60 * 1000 } = {}) => {
  let stdout = []
  // const stderr = []
  return new Promise((resolve, reject) => {
    const execShell = spawn(command, {
      shell: true,
      // stdio: 'inherit', // write out outputs
      timeout
    })

    log && console.log(`Running "${command}" w/ PID ${execShell.pid} and ${timeout} ms timeout`)

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
      resolve({ status: c, stdout })
    })

    execShell.on('error', d => {
      log && console.log(`ERROR :: PID ${execShell.pid} .stderr.on('error', d)=${typeof d}: ${d}`)
      reject(new Error({ status: d, stdout }))
    })
  })
}

export default getBattery
