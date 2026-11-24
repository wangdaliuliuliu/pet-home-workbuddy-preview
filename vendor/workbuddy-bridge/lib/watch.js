import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dispatchFolder, loadTicket } from './dispatch.js'

const monitor = fileURLToPath(new URL('../bin/monitor.mjs', import.meta.url))
const watchPath = (options, id) => path.join(dispatchFolder(options), `watch-${id}.json`)

export function readWatch(options, id) {
  try { return JSON.parse(fs.readFileSync(watchPath(options, id), 'utf8')) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

export function writeWatch(options, state) {
  const target = watchPath(options, state.dispatchId)
  const temp = `${target}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify(state), { flag: 'wx', mode: 0o600 })
    fs.renameSync(temp, target)
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp)
  }
}

function display(state, action, dispatchId) {
  if (!state) return { ok: true, dispatchId, status: 'not-started', done: false }
  const { result, ...summary } = state
  if (summary.status === 'monitoring') {
    try { process.kill(summary.pid, 0) }
    catch (error) {
      if (error.code === 'ESRCH') summary.status = 'monitor-exited'
    }
  }
  return { ok: true, ...summary, ...(action === 'result' && result ? { result } : {}) }
}

function startMonitor(options, args) {
  return new Promise((resolve, reject) => {
    const child = fork(monitor, [], { execArgv: [], detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    const timer = setTimeout(() => {
      child.unref()
      if (child.connected) child.disconnect()
      reject(Object.assign(new Error('Monitor startup was not confirmed. Check status with the same dispatchId.'), { code: 'WATCH_START_UNKNOWN' }))
    }, 5000)
    const fail = error => { clearTimeout(timer); reject(error) }
    child.once('error', fail)
    child.once('exit', code => fail(Object.assign(new Error(`Monitor exited during startup (${code}).`), { code: 'WATCH_START_FAILED' })))
    child.once('message', message => {
      clearTimeout(timer)
      child.unref()
      if (message.error) fail(Object.assign(new Error(message.error), { code: message.code }))
      else resolve(message.state)
    })
    child.send({ options, args }, error => { if (error) fail(error) })
  })
}

export async function watch(options, { action = 'start', dispatchId, timeoutSec = 1800 }) {
  // Validate the ticket (including its ID) before using it in a watch path.
  loadTicket(options, dispatchId)
  const state = readWatch(options, dispatchId)
  const shown = display(state, action, dispatchId)
  if (action !== 'start' || ['monitoring', 'completed', 'error', 'cancelled', 'canceled', 'interrupted', 'aborted', 'superseded'].includes(shown.status)) return shown
  return display(await startMonitor(options, { dispatchId, timeoutSec }), action, dispatchId)
}
