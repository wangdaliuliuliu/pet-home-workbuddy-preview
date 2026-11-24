/**
 * Standalone read-only query helper for WorkBuddy's session database.
 *
 * The plugin prefers `node:sqlite` in-process and falls back to this file run by
 * a plain Node.js binary, which keeps the session list working on runtimes
 * where the built-in SQLite module is still behind a flag.
 *
 * Usage: node db-read.mjs '<json request>'
 *   {"op":"sessions","limit":20,"query":"文字"}
 *   {"op":"session","id":"<uuid>"}
 *   {"op":"latest","since":1794762777296}
 */
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// The caller passes WORKBUDDY_DB; fall back to the default location so the
// helper still works when it is run by hand.
const DB = process.env.WORKBUDDY_DB ?? path.join(os.homedir(), '.workbuddy', 'workbuddy.db')

const request = JSON.parse(process.argv[2] ?? '{}')

function open() {
  return new DatabaseSync(DB, { readOnly: true })
}

const SELECT = `select id, title, custom_title, status, model, expert_id, expert_locale, context_window,
  thought_level, cwd, permission_mode, created_at, updated_at, last_activity_at, deleted_at
  from sessions`

function sessions(db, limit, query) {
  const rows = query
    ? db.prepare(`${SELECT} where deleted_at is null and (title like ? or custom_title like ?)
        order by last_activity_at desc limit ?`).all(`%${query}%`, `%${query}%`, limit)
    : db.prepare(`${SELECT} where deleted_at is null order by last_activity_at desc limit ?`).all(limit)
  let used = new Map()
  try { used = new Map(db.prepare('select session_id, used, size from session_usage').all().map((row) => [row.session_id, row])) } catch { /* Usage is optional. */ }
  return rows.map((row) => {
    const stat = used.get(row.id)
    return { ...row, used: stat?.used ?? null, size: stat?.size ?? null }
  })
}

const db = open()
try {
  let result
  if (request.op === 'sessions') result = sessions(db, Math.max(1, Math.min(Number(request.limit) || 20, 200)), request.query)
  else if (request.op === 'session') result = db.prepare(`${SELECT} where id = ?`).get(request.id) ?? null
  else if (request.op === 'spaces') result = db.prepare('select id, name, status, primary_folder_path from spaces where deleted_at is null or deleted_at <= 0').all()
  else if (request.op === 'session-space') result = db.prepare('select id, space_id, expert_id from sessions where id = ? and deleted_at is null').get(request.id)??null
  else if (request.op === 'title') result = db.prepare(`${SELECT} where deleted_at is null and coalesce(nullif(custom_title, ''), title) = ?`).all(request.title)
  else if (request.op === 'active') result = db.prepare(`${SELECT} where deleted_at is null and lower(status) in ('active', 'working', 'running', 'pending', 'queued')`).all()
  else if (request.op === 'latest') {
    result = db.prepare(`${SELECT} where deleted_at is null and created_at >= ? order by created_at desc limit 200`).all(Number(request.since) || 0)
  } else result = { error: `unknown op: ${String(request.op)}` }
  process.stdout.write(JSON.stringify({ ok: true, result }))
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
} finally {
  db.close()
}
