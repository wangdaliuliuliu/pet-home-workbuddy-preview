import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

function busy(lockPath) {
  return Object.assign(new Error(`Another bridge call owns ${lockPath}. Wait for it to finish; a timeout does not cancel WorkBuddy.`), { code: 'BRIDGE_BUSY' })
}

/** A common on-disk lock serializes UI access across hosts and server processes. */
export async function withLock(lockPath, fn) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  const token = randomUUID()
  try {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error.code === 'EEXIST') throw busy(lockPath)
    throw error
  }
  try { return await fn() } finally {
    try {
      if (JSON.parse(fs.readFileSync(lockPath, 'utf8')).token === token) fs.unlinkSync(lockPath)
    } catch { /* Never remove a lock whose ownership cannot be verified. */ }
  }
}
