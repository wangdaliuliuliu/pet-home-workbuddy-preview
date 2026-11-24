/**
 * Minimal Chrome DevTools Protocol client for WorkBuddy's Electron renderer.
 *
 * WorkBuddy is an Electron app, so the reliable way to "use" it is the same
 * channel a browser-debugging tool uses: `--remote-debugging-port`, the
 * HTTP target list, and one WebSocket per window, exactly how the computer-use
 * server drives its browser lane. No npm dependency is used: `fetch` and the
 * WHATWG `WebSocket` are both globals on the Node/Electron runtime this plugin
 * runs on.
 */

export class CdpError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'CdpError'
    this.detail = detail
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export { sleep }

/** Fetch the DevTools HTTP endpoints with a hard timeout so a dead port fails fast. */
async function httpJson(url, timeoutMs = 1500) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new CdpError(`HTTP ${response.status} for ${url}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/** Version banner of a listening debugging port, or undefined when nothing listens. */
export async function debuggerVersion(port, timeoutMs = 1200) {
  try {
    return await httpJson(`http://127.0.0.1:${port}/json/version`, timeoutMs)
  } catch {
    return undefined
  }
}

/** Every inspectable target (pages and service workers) on the port. */
export async function listTargets(port, timeoutMs = 2000) {
  const list = await httpJson(`http://127.0.0.1:${port}/json/list`, timeoutMs)
  return Array.isArray(list) ? list : []
}

/** One CDP WebSocket session bound to a single page target. */
export class CdpConnection {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.closed = false
    socket.addEventListener('message', (event) => this.#onMessage(event))
    socket.addEventListener('close', () => this.#failAll(new CdpError('CDP socket closed')))
    socket.addEventListener('error', () => this.#failAll(new CdpError('CDP socket error')))
  }

  static async connect(wsUrl, timeoutMs = 5000) {
    const socket = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CdpError(`CDP connect timed out: ${wsUrl}`)), timeoutMs)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new CdpError(`CDP connect failed: ${wsUrl}`))
      }, { once: true })
    })
    return new CdpConnection(socket)
  }

  #onMessage(event) {
    let payload
    try {
      payload = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
    } catch {
      return
    }
    if (payload.id === undefined) return
    const entry = this.pending.get(payload.id)
    if (entry === undefined) return
    this.pending.delete(payload.id)
    if (payload.error !== undefined) {
      entry.reject(new CdpError(`${payload.error.message ?? 'CDP error'}${payload.error.data ? ` (${payload.error.data})` : ''}`, payload.error))
    } else {
      entry.resolve(payload.result)
    }
  }

  #failAll(error) {
    this.closed = true
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
  }

  send(method, params = {}, timeoutMs = 15000) {
    if (this.closed) return Promise.reject(new CdpError('CDP connection already closed'))
    const id = this.nextId++
    const message = JSON.stringify({ id, method, params })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpError(`CDP ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        this.socket.send(message)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new CdpError(String(error)))
      }
    })
  }

  /** Run an expression in the page and return its value (no prototype cloning). */
  async evaluate(expression, { awaitPromise = true, timeoutMs = 20000 } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
      includeCommandLineAPI: false,
    }, timeoutMs)
    if (result.exceptionDetails !== undefined) {
      const detail = result.exceptionDetails
      const text = detail.exception?.description ?? detail.text ?? 'evaluation failed'
      throw new CdpError(`page script error: ${text}`, detail)
    }
    return result.result?.value
  }

  /** Trusted mouse click at CSS viewport coordinates (x, y). */
  async click(x, y, { button = 'left', clickCount = 1 } = {}) {
    const base = { x, y, button, clickCount, pointerType: 'mouse' }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse' })
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: button === 'left' ? 1 : 2 })
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 })
  }

  /** Trusted hover at CSS viewport coordinates. */
  async hover(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse' })
  }

  /** Insert text at the caret (appends to selection when one exists). */
  async insertText(text) {
    await this.send('Input.insertText', { text })
  }

  /** Press one key chord such as ['Control', 'a'] or ['Enter']. */
  async key(keys, { modifiers = 0 } = {}) {
    const [head, ...rest] = keys
    const codeMap = {
      Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
      Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
      Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
      Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    }
    if (rest.length > 0) {
      // Ctrl/Cmd chords only: the app's logical key receivers.
      for (const modifier of rest) {
        const meta = modifier === 'Control' || modifier === 'ControlLeft'
        await this.send('Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          modifiers: modifiers | (meta ? 2 : 8),
          key: head.toLowerCase(),
          code: `Key${head.toUpperCase()}`,
          windowsVirtualKeyCode: head.toUpperCase().charCodeAt(0),
        })
        await this.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          modifiers: modifiers | (meta ? 2 : 8),
          key: head.toLowerCase(),
          code: `Key${head.toUpperCase()}`,
          windowsVirtualKeyCode: head.toUpperCase().charCodeAt(0),
        })
      }
      return
    }
    const mapped = codeMap[head]
    if (mapped === undefined) throw new CdpError(`unsupported key: ${head}`)
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, ...mapped })
    if (mapped.text !== undefined) await this.send('Input.dispatchKeyEvent', { type: 'char', modifiers, ...mapped })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...mapped })
  }

  /** Select-all inside the focused editable. */
  async selectAll() {
    await this.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
    })
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
    })
  }

  async screenshot() {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    return Buffer.from(data, 'base64')
  }

  close() {
    if (this.closed) return
    this.closed = true
    try {
      this.socket.close()
    } catch {
      // Already gone: nothing to unwind.
    }
  }
}

/**
 * Connect to WorkBuddy's two windows.
 *
 * The settings dialog is a separate Electron window with its own target, so
 * every action must say which one it means. Targets are classified by asking
 * the page itself instead of guessing from the title, because both windows are
 * titled "WorkBuddy".
 */
export async function openWindows(port) {
  const targets = await listTargets(port)
  const pages = targets.filter((entry) => entry.type === 'page' && typeof entry.webSocketDebuggerUrl === 'string')
  const windows = { main: undefined, settings: undefined, others: [] }
  for (const page of pages) {
    let kind = 'other'
    let connection
    try {
      connection = await CdpConnection.connect(page.webSocketDebuggerUrl, 4000)
      kind = await connection.evaluate(
        `(() => {
          if (document.querySelector('.settings-modal')) return 'settings'
          if (document.querySelector('.codebuddy-menubar, .conversation-list-tab-button, .cr-input-box')) return 'main'
          return 'other'
        })()`,
      )
    } catch {
      kind = 'other'
    } finally {
      connection?.close()
    }
    const record = { kind, wsUrl: page.webSocketDebuggerUrl, url: page.url, title: page.title }
    if (kind === 'settings' && windows.settings === undefined) windows.settings = record
    else if (kind === 'main' && windows.main === undefined) windows.main = record
    else windows.others.push(record)
  }
  return windows
}

/**
 * Wait until a window of the given kind is inspectable.
 *
 * A freshly (re)launched Electron app answers `/json/version` before its
 * renderer has a page target, so the first look can legitimately be empty.
 */
export async function waitForWindows(port, { timeoutMs = 20000, need = 'main' } = {}) {
  let windows = await openWindows(port).catch(() => ({ main: undefined, settings: undefined, others: [] }))
  const deadline = Date.now() + timeoutMs
  while (windows[need] === undefined && Date.now() < deadline) {
    await sleep(500)
    windows = await openWindows(port).catch(() => windows)
  }
  return windows
}

/** Open one window ('main' | 'settings') and hand the connection to `run`. */
export async function withWindow(port, which, run) {
  const windows = await waitForWindows(port, { timeoutMs: 12000, need: which })
  const record = windows[which]
  if (record === undefined) {
    throw new CdpError(`WorkBuddy ${which} window not found (windows: ${JSON.stringify(Object.keys(windows).filter((key) => windows[key] !== undefined))})`)
  }
  const connection = await CdpConnection.connect(record.wsUrl)
  try {
    return await run(connection, record)
  } finally {
    connection.close()
  }
}
