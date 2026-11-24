/** Pet Home never closes an existing WorkBuddy process. */
import { spawn } from 'node:child_process'
import { debuggerVersion, sleep } from './cdp.js'
import { findExecutable } from './paths.js'

async function capture(command, args) {
  return new Promise(resolve => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore','pipe','ignore'] })
    let text = ''
    let settled = false
    const done = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result) } }
    const timer = setTimeout(() => { child.kill(); done({ ok: false, text }) }, 8000)
    child.stdout.on('data', chunk => { text += chunk })
    child.on('error', e => done({ ok: false, text, error: e.message }))
    child.on('close', code => done({ ok: code === 0, text }))
  })
}
export async function isRunning() {
  const result = await capture('tasklist', ['/FI','IMAGENAME eq WorkBuddy.exe','/FO','CSV','/NH'])
  if (!result.ok) throw Object.assign(new Error('Could not inspect local WorkBuddy processes.'), { code: 'PROCESS_STATE_UNKNOWN' })
  return result.text.toLowerCase().includes('workbuddy.exe')
}
export function restartDecision({ endpointReachable, running, restart = false, autoRestart = true }) {
  if (endpointReachable && !restart) return 'reuse'
  if (running && !restart && !autoRestart) return 'needs-restart'
  return running ? 'force-restart' : 'launch'
}
export async function ensureRunning({ port, launchTimeoutMs = 30000, appPath, restart = false }) {
  const version = await debuggerVersion(port)
  if (version && !restart) return { port, launched: false, restarted: false, version }
  if (restart || await isRunning()) throw Object.assign(new Error('Close WorkBuddy normally before opening Pet Home.'), { code: 'NEEDS_RESTART' })
  const exe = findExecutable(appPath)
  if (!exe) throw Object.assign(new Error('WorkBuddy executable not found.'), { code: 'NO_EXE' })
  const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>name.toUpperCase()!=='ELECTRON_RUN_AS_NODE'))
  const child = spawn(exe, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { env, detached: true, windowsHide: true, stdio: 'ignore' })
  let launchError
  child.on('error', e => { launchError = e })
  child.unref()
  const end = Date.now() + launchTimeoutMs
  while (Date.now() < end) {
    if (launchError) throw launchError
    const ready = await debuggerVersion(port)
    if (ready) return { port, launched: true, restarted: false, how: 'spawn', version: ready }
    await sleep(500)
  }
  throw Object.assign(new Error(`No debug port ${port} after launch.`), { code: 'NO_PORT' })
}
