import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const seconds = Number(process.env.WORKBUDDY_BRIDGE_WARM_SECONDS ?? 0)
const warmMs = Number.isFinite(seconds) ? Math.min(300, Math.max(0, seconds)) * 1000 : 0

let current
let nextId = 0

function close(slot) {
  if (current === slot) current = undefined
  clearTimeout(slot.idleTimer)
  const worker = slot.worker
  if (worker.exitCode !== null || worker.signalCode !== null) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(() => worker.kill(), 3000).unref()
    worker.once('exit', () => { clearTimeout(timer); resolve() })
    if (worker.connected) worker.disconnect()
  })
}

function start() {
  const worker = fork(fileURLToPath(new URL('../bin/worker.mjs', import.meta.url)), [], {
    execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  const slot = { worker, pending: new Map() }
  function failed(error) {
    if (current === slot) current = undefined
    clearTimeout(slot.idleTimer)
    for (const { reject } of slot.pending.values()) reject(error)
    slot.pending.clear()
  }
  worker.on('error', failed)
  worker.on('exit', code => failed(new Error(`Bridge worker exited (${code}); recover an existing dispatch or retry with the same requestId.`)))
  worker.on('message', ({ id, result, error }) => {
    const request = slot.pending.get(id)
    if (!request) return
    slot.pending.delete(id)
    if (error) request.reject(new Error(error))
    else request.resolve(result)
    if (slot.pending.size) return
    if (warmMs === 0) void close(slot)
    else slot.idleTimer = setTimeout(() => void close(slot), warmMs).unref()
  })
  return slot
}

export function callWorker(name, args, context) {
  const slot = current ??= start()
  clearTimeout(slot.idleTimer)
  const id = ++nextId
  return new Promise((resolve, reject) => {
    slot.pending.set(id, { resolve, reject })
    try {
      slot.worker.send({ id, name, args, context }, error => {
        if (error && slot.pending.delete(id)) {
          reject(error)
          if (!slot.pending.size) void close(slot)
        }
      })
    }
    catch (error) {
      slot.pending.delete(id)
      if (!slot.pending.size) void close(slot)
      reject(error)
    }
  })
}

export async function closeWorker() {
  if (current) await close(current)
}
