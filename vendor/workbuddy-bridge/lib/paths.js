/**
 * WorkBuddy's on-disk layout.
 *
 * Everything the plugin reads after a run lives here: the session database, the
 * per-session transcript event log, and the workspace folder the agent writes
 * its deliverables into.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const HOME = os.homedir()

/** User data root: `%APPDATA%\WorkBuddy` for Electron storage, `.workbuddy` for the agent runtime. */
export const WORKBUDDY_HOME = process.env.WORKBUDDY_HOME ?? path.join(HOME, '.workbuddy')
export const WORKBUDDY_ROAMING = path.join(process.env.APPDATA ?? path.join(HOME, 'AppData', 'Roaming'), 'WorkBuddy')

/** Default new-task workspace root; every "new task" gets a timestamped folder here. */
export const WORKSPACE_ROOT = path.join(HOME, 'WorkBuddy')

export const DB_PATH = process.env.WORKBUDDY_DB ?? path.join(WORKBUDDY_HOME, 'workbuddy.db')
export const MODELS_JSON = path.join(WORKBUDDY_HOME, 'models.json')

/** Candidate install locations for WorkBuddy.exe, most specific first. */
export const EXE_CANDIDATES = [
  path.join(HOME, 'AppData', 'Local', 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
  path.join(process.env['ProgramFiles'] ?? '', 'WorkBuddy', 'WorkBuddy.exe'),
]

/** First existing WorkBuddy.exe, or undefined. */
export function findExecutable(configured) {
  const candidates = [configured, process.env.WORKBUDDY_EXE, ...EXE_CANDIDATES].filter(
    (value) => typeof value === 'string' && value.length > 0,
  )
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // Unreadable candidate: keep looking.
    }
  }
  return undefined
}

/** The transcript slug WorkBuddy derives from a working directory. */
export function projectSlug(cwd) {
  return String(cwd).replace(/[\\/:]/g, '-').replace(/^-+/, '').replace(/-+$/, '')
}

/** Transcript event log for one session, preferring the path that matches its cwd. */
export function transcriptPath(sessionId, cwd, { dbPath, workbuddyHome } = {}) {
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) return undefined
  const dataHome = workbuddyHome ?? (dbPath ? path.dirname(dbPath) : WORKBUDDY_HOME)
  const roots = [path.join(dataHome, 'projects')]
  // A custom data root must not accidentally read a real user's other account.
  if (dataHome === WORKBUDDY_HOME && !dbPath && !workbuddyHome) roots.push(path.join(HOME, '.codebuddy', 'projects'))
  if (typeof cwd === 'string' && cwd.length > 0) {
    const direct = path.join(dataHome, 'projects', projectSlug(cwd), `${sessionId}.jsonl`)
    if (fs.existsSync(direct)) return direct
  }
  for (const root of roots) {
    let entries = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = path.join(root, entry.name, `${sessionId}.jsonl`)
      try {
        if (fs.existsSync(candidate)) return candidate
      } catch {
        // Ignore an unreadable directory.
      }
    }
  }
  return undefined
}
