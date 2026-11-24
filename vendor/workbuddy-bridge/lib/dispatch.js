import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim()
export const taskHash = value => crypto.createHash('sha256').update(normalize(value)).digest('hex')
export const BUSY_STATUSES = ['active', 'working', 'running', 'pending', 'queued']
export const isBusy = status => BUSY_STATUSES.includes(String(status).toLowerCase())
const error = (code, text) => Object.assign(new Error(text), { code })
export const dispatchFolder = options => options.dispatchDir ?? path.join(path.dirname(options.dbPath), 'bridge-dispatches')
const ticketPath = (options, id) => {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id ?? '')) throw error('INVALID_DISPATCH', 'Invalid dispatch id.')
  return path.join(dispatchFolder(options), `${id}.json`)
}
export function loadTicket(options, id) {
  try { return JSON.parse(fs.readFileSync(ticketPath(options, id), 'utf8')) }
  catch (e) { if (e.code === 'ENOENT') throw error('DISPATCH_NOT_FOUND', 'Dispatch ticket not found.'); throw e }
}
export function saveTicket(options, ticket) {
  const target = ticketPath(options, ticket.dispatchId)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ ...ticket, updatedAt: Date.now() }), { mode: 0o600, flag: 'wx' })
  fs.renameSync(tmp, target)
  return ticket
}
export function existingRequest(options, requestId) {
  if (!requestId) return undefined
  try { return loadTicket(options, JSON.parse(fs.readFileSync(path.join(dispatchFolder(options), `request-${taskHash(requestId)}.json`))).dispatchId) }
  catch (e) { if (e.code === 'ENOENT') return undefined; throw e }
}
export function createTicket(options, { task, requestId, ...details }) {
  const ticket = { dispatchId: crypto.randomUUID(), state: 'prepared', taskHash: taskHash(task), taskLength: normalize(task).length, since: Date.now(), baselineBytes: 0, observations: [], ...details }
  saveTicket(options, ticket)
  if (requestId) {
    try { fs.writeFileSync(path.join(dispatchFolder(options), `request-${taskHash(requestId)}.json`), JSON.stringify({ dispatchId: ticket.dispatchId }), { flag: 'wx', mode: 0o600 }) }
    catch (e) { if (e.code === 'EEXIST') throw error('DUPLICATE_REQUEST', 'Request already reserved; use recover.'); throw e }
  }
  return ticket
}
export function metadata(row, source = 'session-metadata') {
  return { observedAt: Date.now(), source, model: row?.model, effort: row?.thought_level, context: row?.context_window, status: row?.status, backendModel: 'NOT_INDEPENDENTLY_OBSERVED' }
}
export function observe(ticket, row, phase) {
  const point = { ...metadata(row), phase }
  const last = ticket.observations.at(-1)
  if (!last || ['model','effort','context','status','phase'].some(k => point[k] !== last[k])) ticket.observations.push(point)
  ticket.observations = ticket.observations.slice(-100)
  return ticket
}
export function evidenceOf(ticket) {
  return { dispatchId: ticket.dispatchId, sessionId: ticket.sessionId, since: ticket.since, baselineBytes: ticket.baselineBytes, taskHash: ticket.taskHash, baselineActivityAt: ticket.baselineActivityAt }
}
