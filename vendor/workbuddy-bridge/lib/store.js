/**
 * Reading what WorkBuddy wrote down: the session database, the per-session
 * transcript event log, and the workspace folder.
 *
 * These are observation-only channels. Every action still goes through the
 * window over CDP; the database just answers "which sessions exist, what model
 * and effort did this one really run with, and is it finished yet".
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { DB_PATH, transcriptPath } from './paths.js'

const SELECT_COLUMNS = [
  'id', 'title', 'custom_title', 'status', 'model', 'expert_id', 'expert_locale', 'context_window',
  'thought_level', 'cwd', 'permission_mode', 'created_at', 'updated_at', 'last_activity_at', 'deleted_at',
].join(', ')

let sqlitePromise
/** Resolve `node:sqlite` once; undefined when this runtime does not ship it unflagged. */
async function loadSqlite() {
  if (sqlitePromise !== undefined) return sqlitePromise
  sqlitePromise = (async () => {
    try {
      return await import('node:sqlite')
    } catch {
      return undefined
    }
  })()
  return sqlitePromise
}

function nodeCandidates() {
  const configured = process.env.DSH_NODE ?? process.env.WORKBUDDY_NODE
  return [configured, 'node', 'D:\\Node.js\\node.exe', 'C:\\Program Files\\nodejs\\node.exe'].filter(
    (value) => typeof value === 'string' && value.length > 0,
  )
}

function runNode(args, timeoutMs = 15000, env = {}) {
  return new Promise((resolve) => {
    const attempts = nodeCandidates()
    const tryNext = (index) => {
      if (index >= attempts.length) {
        resolve({ ok: false, error: 'no Node.js binary found for the database helper' })
        return
      }
      let child
      try {
        child = spawn(attempts[index], args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
      } catch {
        tryNext(index + 1)
        return
      }
      let out = ''
      let err = ''
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          // Already gone.
        }
      }, timeoutMs)
      child.stdout?.on('data', (chunk) => {
        out += String(chunk)
      })
      child.stderr?.on('data', (chunk) => {
        err += String(chunk)
      })
      child.on('error', () => {
        clearTimeout(timer)
        tryNext(index + 1)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0 && out.trim().length > 0) {
          try {
            resolve(JSON.parse(out))
            return
          } catch {
            resolve({ ok: false, error: `helper returned non-JSON: ${out.slice(0, 200)}` })
            return
          }
        }
        if (index + 1 < attempts.length) tryNext(index + 1)
        else resolve({ ok: false, error: err.trim() || `helper exited with ${code}` })
      })
    }
    tryNext(0)
  })
}

/** Run one read-only query against the session database. */
export async function query(request, { dbPath = DB_PATH, helperPath } = {}) {
  if (!fs.existsSync(dbPath)) return { ok: false, error: `database not found: ${dbPath}` }
  const sqlite = await loadSqlite()
  if (sqlite?.DatabaseSync !== undefined) {
    try {
      const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
      try {
        if (request.op === 'sessions') {
          const limit = Math.max(1, Math.min(Number(request.limit) || 20, 200))
          const rows = request.query
            ? db.prepare(`select ${SELECT_COLUMNS} from sessions where deleted_at is null and (title like ? or custom_title like ?) order by last_activity_at desc limit ?`).all(`%${request.query}%`, `%${request.query}%`, limit)
            : db.prepare(`select ${SELECT_COLUMNS} from sessions where deleted_at is null order by last_activity_at desc limit ?`).all(limit)
          let usage = new Map()
          try { usage = new Map(db.prepare('select session_id, used, size from session_usage').all().map((row) => [row.session_id, row])) } catch { /* Older schemas may omit usage. */ }
          return { ok: true, rows: rows.map((row) => ({ ...row, used: usage.get(row.id)?.used ?? null, size: usage.get(row.id)?.size ?? null })) }
        }
        if (request.op === 'session') {
          return { ok: true, row: db.prepare(`select ${SELECT_COLUMNS} from sessions where id = ?`).get(request.id) ?? null }
        }
        if (request.op === 'spaces') {
          return {ok:true,rows:db.prepare('select id, name, status, primary_folder_path from spaces where deleted_at is null or deleted_at <= 0').all()}
        }
        if (request.op === 'session-space') {
          return {ok:true,row:db.prepare('select id, space_id, expert_id from sessions where id = ? and deleted_at is null').get(request.id)??null}
        }
        if (request.op === 'title') {
          return { ok: true, rows: db.prepare(`select ${SELECT_COLUMNS} from sessions where deleted_at is null and coalesce(nullif(custom_title, ''), title) = ?`).all(request.title) }
        }
        if (request.op === 'active') {
          return { ok: true, rows: db.prepare(`select ${SELECT_COLUMNS} from sessions where deleted_at is null and lower(status) in ('active', 'working', 'running', 'pending', 'queued')`).all() }
        }
        if (request.op === 'latest') {
          return {
            ok: true,
            rows: db.prepare(`select ${SELECT_COLUMNS} from sessions where deleted_at is null and created_at >= ? order by created_at desc limit 200`).all(Number(request.since) || 0),
          }
        }
        return { ok: false, error: `unknown op: ${String(request.op)}` }
      } finally {
        db.close()
      }
    } catch (error) {
      // Fall through to the helper binary instead of failing the whole tool.
      if (helperPath === undefined) return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  if (helperPath === undefined) return { ok: false, error: 'sqlite unavailable and no helper script configured' }
  const result = await runNode([helperPath, JSON.stringify(request)], 15000, { WORKBUDDY_DB: dbPath })
  if (result.ok === true) {
    return { ok: true, via: 'helper', rows: Array.isArray(result.result) ? result.result : undefined, row: Array.isArray(result.result) ? undefined : result.result }
  }
  return { ok: false, via: 'helper', error: result.error ?? 'database helper failed' }
}

/** Convenience: recent sessions, newest activity first. */
export async function listSessions(options = {}) {
  const response = await query({ op: 'sessions', limit: options.limit ?? 20, query: options.query }, options)
  if (response.ok !== true) return response
  return { ok: true, rows: response.rows ?? [] }
}

/** Convenience: one session row by id. */
export async function getSession(id, options = {}) {
  const response = await query({ op: 'session', id }, options)
  if (response.ok !== true) return response
  return { ok: true, row: response.row }
}

/** Newest sessions created at or after `since` (ms) — how a fresh send is identified. */
export async function sessionsSince(since, options = {}) {
  const response = await query({ op: 'latest', since }, options)
  if (response.ok !== true) return response
  return { ok: true, rows: Array.isArray(response.rows) ? response.rows : [] }
}

export async function activeSessions(options = {}) {
  return query({ op: 'active' }, options)
}

export function stripContextPreamble(value) {
  let text = String(value).trimStart()
  for (let i = 0; i < 10; i++) {
    const next = text.replace(/^<(system-reminder|user_info|cwd|context)\b[^>]*>[\s\S]*?<\/\1>\s*/i, '')
    if (next === text) break
    text = next
  }
  const query = text.match(/^<user_query>([\s\S]*)<\/user_query>\s*$/i)
  return query ? query[1] : text
}

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && typeof block.text === 'string')
    .filter((block) => block.type === 'input_text' || block.type === 'output_text' || block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

function pathsFromArgs(args) {
  const found = []
  const visit = (value, depth) => {
    if (depth > 3 || value === null || value === undefined) return
    if (typeof value === 'string') return
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    if (typeof value !== 'object') return
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'string' && ['file_path', 'path', 'filePath', 'notebook_path', 'target_file'].includes(key)) {
        found.push(entry)
      } else {
        visit(entry, depth + 1)
      }
    }
  }
  visit(args, 0)
  return found
}

/**
 * Parse one session transcript.
 * @returns {{ path?:string, title?:string, userTexts:string[], assistantTexts:string[], lastAssistant?:string, files:string[], toolNames:Record<string,number> }}
 */
export function readTranscript(sessionId, cwd, options = {}) {
  const file = transcriptPath(sessionId, cwd, options)
  const empty = { path: undefined, bytes: 0, title: undefined, userTexts: [], assistantTexts: [], userEvents: [], assistantEvents: [], lastAssistant: undefined, files: [], toolNames: {} }
  if (file === undefined) return empty
  let raw = ''
  let startOffset = 0
  let bytes = 0
  try {
    const stat = fs.statSync(file)
    bytes = stat.size
    if (stat.size > 40 * 1024 * 1024) {
      // Only the tail matters for "what did it say last"; read the last 8 MB.
      const handle = fs.openSync(file, 'r')
      try {
        const start = Math.max(0, stat.size - 8 * 1024 * 1024)
        const buffer = Buffer.alloc(stat.size - start)
        fs.readSync(handle, buffer, 0, buffer.length, start)
        raw = buffer.toString('utf8')
        startOffset = start
        const firstBreak = raw.indexOf('\n')
        if (start > 0 && firstBreak >= 0) {
          startOffset += Buffer.byteLength(raw.slice(0, firstBreak + 1))
          raw = raw.slice(firstBreak + 1)
        }
      } finally {
        fs.closeSync(handle)
      }
    } else {
      raw = fs.readFileSync(file, 'utf8')
    }
  } catch {
    return { ...empty, path: file }
  }
  const files = new Set()
  const toolNames = {}
  const userTexts = []
  const assistantTexts = []
  const userEvents = []
  const assistantEvents = []
  let title
  let offset = startOffset
  for (const chunk of raw.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const line = chunk.replace(/\r?\n$/, '')
    const lineOffset = offset
    offset += Buffer.byteLength(chunk)
    if (line.length < 2) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string') title = entry.aiTitle
    else if (entry.type === 'message' && entry.role === 'user') {
      const text = stripContextPreamble(textOfContent(entry.content))
      if (text.length > 0 && !text.startsWith('<conversation_history_summary>')) {
        userTexts.push(text)
        userEvents.push({ text, offset: lineOffset, id: entry.id, timestamp: entry.timestamp })
      }
    } else if (entry.type === 'message' && entry.role === 'assistant') {
      const text = textOfContent(entry.content)
      if (text.length > 0) {
        assistantTexts.push(text)
        assistantEvents.push({ text, offset: lineOffset, id: entry.id, timestamp: entry.timestamp, status: entry.status })
      }
    } else if (entry.type === 'function_call') {
      const name = String(entry.name ?? entry.toolName ?? entry.tool ?? 'unknown')
      toolNames[name] = (toolNames[name] ?? 0) + 1
      const args = entry.arguments ?? entry.input ?? entry.args
      let parsed = args
      if (typeof args === 'string') {
        try {
          parsed = JSON.parse(args)
        } catch {
          parsed = args
        }
      }
      for (const path of pathsFromArgs(parsed)) files.add(path)
    } else if (entry.type === 'file-history-snapshot' && entry.snapshot && typeof entry.snapshot.trackedFileBackups === 'object') {
      for (const key of Object.keys(entry.snapshot.trackedFileBackups ?? {})) {
        if (typeof cwd === 'string' && cwd.length > 0) files.add(path.join(cwd, key))
        else files.add(key)
      }
    }
  }
  return {
    path: file,
    bytes,
    title,
    userTexts,
    assistantTexts,
    userEvents,
    assistantEvents,
    lastAssistant: assistantTexts.length > 0 ? assistantTexts[assistantTexts.length - 1] : undefined,
    files: [...files],
    toolNames,
  }
}

/** Recursively list files under a folder, newest last, capped. */
export function listFiles(root, { maxFiles = 400, maxDepth = 6 } = {}) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > maxDepth || found.length >= maxFiles) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= maxFiles) return
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      try {
        const stat = fs.statSync(full)
        found.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs })
      } catch {
        // Skip vanished files.
      }
    }
  }
  walk(root, 0)
  return found.sort((left, right) => left.mtimeMs - right.mtimeMs)
}
