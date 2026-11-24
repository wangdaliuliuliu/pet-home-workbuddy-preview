/**
 * The page-side half of the bridge: selectors and the trusted-input gestures
 * that drive WorkBuddy's renderer exactly like a person at the desk would.
 *
 * Every helper opens nothing new; it receives an already-connected CDP
 * connection (see `cdp.js`) and works against the live DOM. Coordinates are CSS
 * viewport pixels, which is what `Input.dispatchMouseEvent` expects.
 */
import { sleep } from './cdp.js'

const HOVER_DWELL_MS = 750
const UI_SETTLE_MS = 320

/** Shared page-side preamble: element visibility and text helpers. */
const PREAMBLE = `
  const visible = (el) => {
    if (!el) return false
    const rect = el.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return false
    const style = getComputedStyle(el)
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05
  }
  const textOf = (el) => (el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : '')
  const center = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } }
  const pick = (selector) => Array.from(document.querySelectorAll(selector)).find(visible)
  const pickAll = (selector) => Array.from(document.querySelectorAll(selector)).filter(visible)
`

async function pageEval(connection, body) {
  return connection.evaluate(`(() => { ${PREAMBLE} ${body} })()`)
}

/** Give the renderer a moment after a click that opens or closes a panel. */
async function settle(ms = UI_SETTLE_MS) {
  await sleep(ms)
}

/** Wait until `probe` (a page expression returning truthy) holds. */
export async function waitForPage(connection, body, { timeoutMs = 8000, intervalMs = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await pageEval(connection, `return (${body})`)
    } catch {
      last = undefined
    }
    if (last) return last
    await sleep(intervalMs)
  }
  throw new Error(`timed out waiting for ${label}`)
}

export const EFFORT_LABELS = {
  off: '关闭',
  disabled: '关闭',
  none: '关闭',
  minimal: '低',
  low: '低',
  低: '低',
  medium: '中',
  中: '中',
  high: '高',
  高: '高',
  xhigh: '超高',
  max: '超高',
  超高: '超高',
}

/**
 * Markers used to tell the screens apart.
 * A conversation shows a message list and its own composer box; the home
 * screen shows quick-action chips and the plain composer.
 */
const VIEW_PROBE = `
  const isSettings = !!document.querySelector('.settings-modal')
  const messageList = !!document.querySelector('.cr-message-list__content')
  const conversationComposer = !!document.querySelector('.conversation-input__box')
  const anyComposer = !!document.querySelector('.cr-input-box [contenteditable="true"], ._editable_1cxd2_1')
  const quickActions = document.querySelectorAll('button.quick-actions__item').length
`

/** What the window currently shows. */
export async function readState(connection) {
  return pageEval(connection, `
    ${VIEW_PROBE}
    const conversation = messageList || conversationComposer
    const homeComposer = anyComposer && !conversation
    const composerModel = textOf(pick('.cr-model-selector__trigger .cr-model-selector__trigger-label') || pick('.cr-model-selector__trigger'))
    const chips = pickAll('.cr-status-chips .cr-chip-base').map(textOf)
    const title = textOf(pick('.workbuddy-topbar-title, .conversation-title, .cb-conversation-header__title, .conversation-header__title'))
    const identity = pick('[data-conversation-input-id]')?.getAttribute('data-conversation-input-id')
    const ctx = textOf(pick('.cr-context-usage'))
    const expertTab = pickAll('button.conversation-list-tab-button').find((el) => textOf(el).startsWith('专家'))
    const banner = textOf(pick('.cr-agent__completion-status'))
    return {
      settings: isSettings,
      view: isSettings ? 'settings' : identity ? (identity.startsWith('__home__:') ? 'home' : 'conversation') : (conversation ? 'conversation' : (homeComposer ? 'home' : 'other')),
      quickActions,
      expertPage: expertTab ? expertTab.getAttribute('aria-selected') === 'true' : false,
      model: composerModel || undefined,
      chips,
      title: title || undefined,
      sessionId: identity && !identity.startsWith('__home__:') ? identity : undefined,
      contextLabel: ctx || undefined,
      completionStatus: banner || undefined,
      sendDisabled: (() => { const btn = pick('.cr-send-button'); return btn ? (btn.hasAttribute('disabled') || btn.className.includes('disabled')) : true })(),
      composerHasText: !!textOf(pick('.conversation-input__box [contenteditable="true"], ._editable_1cxd2_1, [role="textbox"][contenteditable="true"]')),
    }
  `)
}

/** Stable identity belongs to the visible composer, not a sidebar title. */
export async function readIdentity(connection) {
  return pageEval(connection, `
    const ids = [...new Set(pickAll('[data-conversation-input-id]').map(e=>e.getAttribute('data-conversation-input-id')))]
    return { sessionId: ids.length === 1 && !ids[0].startsWith('__home__:') ? ids[0] : null, home: ids.length === 1 && ids[0].startsWith('__home__:'), source: 'data-conversation-input-id', ambiguous: ids.length > 1 }
  `)
}
export async function openSessionById(connection, id, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const identity = await readIdentity(connection)
    if (identity.sessionId === id) return identity
    const point = await pageEval(connection, `
      const target = document.querySelector(${JSON.stringify('.cb-agent-card[data-conversation-id=')} + JSON.stringify(${JSON.stringify(id)}) + ']')
      if (!target) return null
      target.scrollIntoView({block:'center'})
      return visible(target) ? center(target) : null
    `)
    if (point) {
      await connection.click(point.x, point.y)
      return waitForPage(connection, `pickAll('[data-conversation-input-id]').some(e=>e.getAttribute('data-conversation-input-id') === ${JSON.stringify(id)})`, { timeoutMs: 8000, label: `session ${id}` })
    }
    const more = await pageEval(connection, `const button=pick('button.conversation-show-more-button');return button?center(button):null`)
    if (!more) throw new Error(`Session id ${id} not found in the visible sidebar; expand its group in WorkBuddy.`)
    await connection.click(more.x, more.y)
    await settle(400)
  }
  throw new Error(`Timed out opening session ${id}`)
}
export async function stopTurn(connection, id) {
  const identity = await readIdentity(connection)
  if (identity.sessionId !== id) throw new Error(`Cancel target mismatch: expected ${id}, observed ${identity.sessionId ?? 'unknown'}`)
  const point = await pageEval(connection, `
    const icon=pick('.cr-send-button [class*="stop"], .cr-send-button [class*="Stop"]')
    const explicit=pickAll('button,[role="button"]').find(e=>/^(停止|停止生成|停止任务|Stop|Stop generating)$/i.test(e.getAttribute('aria-label')||e.textContent?.trim()||''))
    const button=icon?.closest('button,.cr-send-button') || explicit
    return button && visible(button) ? center(button) : null
  `)
  if (!point) throw new Error('A verified stop control is not visible; no interrupt was sent.')
  await connection.click(point.x, point.y)
  return { requested: true, sessionId: id }
}

/** Click a left-rail tab by its visible label prefix (新建任务, 专家·技能·连接器, ...). */
export async function clickSidebarTab(connection, label) {
  const point = await pageEval(connection, `
    const target = pickAll('button.conversation-list-tab-button').find((el) => textOf(el).startsWith(${JSON.stringify(label)}))
    if (!target) return null
    return center(target)
  `)
  if (point === null) throw new Error(`sidebar tab not found: ${label}`)
  await connection.click(point.x, point.y)
  await settle(500)
}

/** Start a brand new task on the home screen. */
export async function openNewTask(connection) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await readState(connection)
    if (state.view === 'home') return
    await clickSidebarTab(connection, '新建任务')
    try {
      await waitForPage(connection, `!document.querySelector('.cr-message-list__content') && !!document.querySelector('.cr-input-box [contenteditable="true"], ._editable_1cxd2_1')`, {
        label: 'home composer',
        timeoutMs: 5000,
      })
    } catch {
      // Fall through to the next attempt.
    }
    await settle(400)
    const after = await readState(connection)
    if (after.view === 'home') return
  }
  throw new Error('could not return to the new-task home screen')
}

/** The composed conversation title shown in the main pane, if any. */
async function conversationTitle(connection) {
  return pageEval(connection, `
    const candidates = [
      '.conversation-header .conversation-title',
      '.conversation-header__title',
      '.cb-conversation-header__title',
      '[class*="conversationTitle"]',
    ]
    for (const selector of candidates) {
      const value = textOf(pick(selector))
      if (value) return value
    }
    return ''
  `)
}

/**
 * Open a history session by its sidebar card text.
 *
 * Cards live behind 查看更多 when a workspace has many tasks, so expand first.
 */
export async function openSessionByTitle(connection, title, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let expanded = 0
  while (Date.now() < deadline) {
    const point = await pageEval(connection, `
      const cards = pickAll('div.cb-agent-card')
      const wanted = ${JSON.stringify(title)}
      const matches = cards.filter((el) => textOf(el).startsWith(wanted))
      if (matches.length > 1) return { ambiguous: true }
      const match = matches[0]
      return match ? center(match) : null
    `)
    if (point !== null) {
      if (point.ambiguous) throw new Error('Multiple visible session cards match this title; no card was clicked.')
      await connection.click(point.x, point.y)
      await settle(900)
      return conversationTitle(connection)
    }
    const more = await pageEval(connection, `
      const button = pick('button.conversation-show-more-button')
      if (!button) return null
      return center(button)
    `)
    if (more === null) break
    await connection.click(more.x, more.y)
    expanded += 1
    await settle(600)
    if (expanded > 12) break
  }
  throw new Error(`history session not found in the sidebar: ${title}`)
}

/**
 * Open the model dropdown and keep it open.
 *
 * A stale popover left by a previous step makes every later read land on a
 * detached tree, so an already-open menu is closed first and re-opened.
 */
export async function openModelMenu(connection, { timeoutMs = 8000 } = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await pageEval(connection, `return !!document.querySelector('.cr-model-selector__popover')`)) {
      await closeModelMenu(connection)
    }
    const opened = await pageEval(connection, `
      const trigger = pick('.cr-model-selector__trigger')
      if (!trigger) return false
      trigger.click()
      return true
    `)
    if (opened !== true) throw new Error('model selector not found')
    try {
      await waitForPage(connection, `document.querySelectorAll('.cr-model-selector__item').length > 0`, { label: 'model menu', timeoutMs })
    } catch {
      continue
    }
    await settle(420 + attempt * 200)
    if (await pageEval(connection, `return document.querySelectorAll('.cr-model-selector__item').length > 0`)) return
  }
  throw new Error('model menu did not open')
}

/** Open the model dropdown and read every row, then close it again. */
export async function readModelMenu(connection) {
  await openModelMenu(connection)
  const items = await pageEval(connection, `
    const list = document.querySelector('.cr-model-selector__list')
    if (list) list.scrollTop = 0
    return pickAll('.cr-model-selector__item').map((el) => {
      const nameEl = el.querySelector('.cr-model-selector__item-name')
      return {
        name: textOf(nameEl) || textOf(el),
        badge: textOf(el.querySelector('.cr-model-selector__item-badge')) || undefined,
        credits: textOf(el.querySelector('.cr-model-selector__item-credits')) || undefined,
        selected: el.getAttribute('aria-selected') === 'true',
        disabled: el.getAttribute('aria-disabled') === 'true',
        clickable: !el.className.includes('model-selector__item--disabled'),
      }
    })
  `)
  const groups = await pageEval(connection, `
    return pickAll('.cr-model-selector__list [class*="group"], .cr-model-selector__list [class*="section-title"]').map(textOf).filter(Boolean)
  `)
  await closeModelMenu(connection)
  return { items, groups }
}

/** Dismiss the model dropdown and wait until it is really gone. */
async function closeModelMenu(connection) {
  const gone = () => pageEval(connection, `return !document.querySelector('.cr-model-selector__popover')`)
  if (await gone()) return
  await connection.key(['Escape'])
  await sleep(220)
  if (await gone()) return
  await pageEval(connection, `
    const trigger = pick('.cr-model-selector__trigger')
    if (trigger) trigger.click()
    return true
  `)
  await sleep(320)
}

/** Scroll the model list until `name` is visible, returning its center point. */
async function locateModelRow(connection, name) {
  return pageEval(connection, `
    const wanted = ${JSON.stringify(name)}
    const list = document.querySelector('.cr-model-selector__list')
    const rowFor = () => pickAll('.cr-model-selector__item').find((el) => {
      const label = textOf(el.querySelector('.cr-model-selector__item-name')) || textOf(el)
      return label === wanted || label.startsWith(wanted)
    })
    let row = rowFor()
    if (!row && list) {
      const total = list.scrollHeight
      let offset = 0
      while (!row && offset <= total) {
        list.scrollTop = offset
        row = rowFor()
        offset += Math.max(120, list.clientHeight - 60)
      }
      list.scrollTop = 0
      row = rowFor()
    }
    if (!row) return null
    row.scrollIntoView({ block: 'center' })
    const box = row.getBoundingClientRect()
    return {
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + box.height / 2),
      selected: row.getAttribute('aria-selected') === 'true' || row.className.includes('--selected'),
    }
  `)
}

/** Locate a row, retrying while the menu finishes its enter animation. */
async function awaitModelRow(connection, name, { attempts = 10, intervalMs = 200 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const point = await locateModelRow(connection, name)
    if (point !== null) return point
    await sleep(intervalMs)
  }
  return null
}

/** Read the model name currently shown on the composer chip. */
async function readModelLabel(connection) {
  return pageEval(connection, `
    return textOf(pick('.cr-model-selector__trigger .cr-model-selector__trigger-label') || pick('.cr-model-selector__trigger')) || null
  `)
}

/**
 * Choose a model by its display name.
 *
 * The row is clicked from inside the page rather than at screen coordinates:
 * the list re-sorts as soon as a model is picked, so a click delivered by
 * position can land on whichever row slid under the pointer and silently pick
 * a different model.
 */
export async function selectModel(connection, name) {
  let active
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await openModelMenu(connection)
    const row = await awaitModelRow(connection, name)
    if (row === null) {
      await closeModelMenu(connection)
      throw new Error(`model not offered by WorkBuddy: ${name}`)
    }
    if (row.selected !== true) {
      await pageEval(connection, `
        const wanted = ${JSON.stringify(name)}
        const row = pickAll('.cr-model-selector__item').find((el) => {
          const label = textOf(el.querySelector('.cr-model-selector__item-name')) || textOf(el)
          return label === wanted || label.startsWith(wanted)
        })
        if (row) row.click()
        return row !== undefined
      `)
      await settle(480)
    }
    await closeModelMenu(connection)
    active = await readModelLabel(connection)
    if (typeof active === 'string' && (active === name || active.startsWith(name))) break
  }
  return { requested: name, active: active ?? undefined }
}

/**
 * Set the thinking-effort level.
 *
 * Effort lives in the model row's hover submenu: hover the row, click the
 * 思考强度 action, then pick the level row. Rows that expose no effort action
 * (fixed tiers such as 快速/均衡/极致) report that instead of pretending.
 */

/**
 * Move the pointer onto a row the way a hand does: away first, then in.
 *
 * React only opens the hover submenu on a real mouseover, and a dispatch that
 * repeats the previous coordinates is swallowed as "no movement".
 */
async function hoverRow(connection, point, attempt = 0) {
  const anchor = await pageEval(connection, `
    const popover = document.querySelector('.cr-model-selector__popover')
    if (!popover) return null
    const box = popover.getBoundingClientRect()
    return { x: Math.round(box.x + 24), y: Math.round(box.y + 14) }
  `)
  // A dispatch that repeats the previous coordinates is swallowed as "no
  // movement", so repeated hovers get a small jitter and always start from a
  // neutral point inside the popover.
  const jitter = [0, 3, -3][attempt % 3]
  if (anchor !== null) {
    await connection.hover(anchor.x, anchor.y + jitter)
    await sleep(90)
  }
  await connection.hover(point.x - 40, point.y + jitter)
  await sleep(90)
  await connection.hover(point.x + jitter, point.y)
}

/**
 * Hover the active model row and open one of its submenu panels.
 *
 * `needle` is the label of the submenu action to open, e.g. 思考强度 or
 * 上下文窗口. The panel's choices are returned with their click points.
 */
async function openModelSubPanel(connection, needle, { model } = {}) {
  let currentModel = model ?? await readModelLabel(connection)
  const readAction = () => pageEval(connection, `
    const menu = document.querySelector('.cr-model-selector__sub-menu')
    if (!menu) return null
    const target = Array.from(menu.querySelectorAll('.cr-model-selector__sub-menu-action'))
      .find((el) => textOf(el).includes(${JSON.stringify(needle)}))
    if (!target) return null
    return { ...center(target), clickable: target.className.includes('clickable'), text: textOf(target) }
  `)
  let actionPoint = null
  let rowFound = false
  for (let round = 0; round < 4 && actionPoint === null; round += 1) {
    await openModelMenu(connection)
    for (let attempt = 0; attempt < 3 && actionPoint === null; attempt += 1) {
      const row = await awaitModelRow(connection, currentModel, { attempts: 3, intervalMs: 260 })
      if (row === null) {
        await sleep(300)
        continue
      }
      rowFound = true
      if (row.selected !== true) {
        // The picker may have drifted to another model; put the requested one
        // back before reading its own effort/context controls.
        await selectModel(connection, currentModel)
        await openModelMenu(connection)
        await awaitModelRow(connection, currentModel, { attempts: 3, intervalMs: 260 })
      }
      const point = await awaitModelRow(connection, currentModel, { attempts: 3, intervalMs: 260 })
      if (point === null) continue
      await hoverRow(connection, point, attempt + round)
      await sleep(HOVER_DWELL_MS + attempt * 350)
      actionPoint = await readAction()
    }
    if (actionPoint === null) {
      await closeModelMenu(connection)
      await sleep(360)
    }
  }
  if (rowFound !== true) {
    await closeModelMenu(connection)
    throw new Error(`could not locate the active model row: ${currentModel}`)
  }
  if (actionPoint === null) {
    await closeModelMenu(connection)
    throw new Error(`model "${currentModel}" exposes no ${needle} control`)
  }
  if (actionPoint.clickable !== true) {
    await closeModelMenu(connection)
    throw new Error(`model "${currentModel}" has a fixed ${needle} (${actionPoint.text})`)
  }
  const opened = await pageEval(connection, `
    const menu = document.querySelector('.cr-model-selector__sub-menu')
    if (!menu) return false
    const target = Array.from(menu.querySelectorAll('.cr-model-selector__sub-menu-action'))
      .find((el) => textOf(el).includes(${JSON.stringify(needle)}))
    if (!target) return false
    target.click()
    return true
  `)
  if (opened !== true) await connection.click(actionPoint.x, actionPoint.y)
  // React opens this panel through pointer handlers, and a plain .click() is not
  // always enough: fall back to a real mouse event before giving up.
  await sleep(260)
  if ((await pageEval(connection, `return !!document.querySelector('.cr-model-selector__sub-panel')`)) !== true) {
    const again = await readAction()
    if (again !== null) await connection.click(again.x, again.y)
  }
  await waitForPage(connection, `!!document.querySelector('.cr-model-selector__sub-panel')`, { label: `${needle} panel` })
  await settle(260)
  let panel = await readSubPanel(connection)
  if (panel !== null && panel.items.length === 0 && panel.toggleOn === false && panel.togglePoint !== null) {
    // Some models ship with thinking switched off, and only list the effort
    // levels once 思考模式 is on. The switch itself must be clicked, not its
    // container's centre, or the label absorbs the click.
    await pageEval(connection, `
      const input = document.querySelector('.cr-model-selector__sub-panel-toggle input[role="switch"], .cr-model-selector__sub-panel-toggle .wb-switch__input')
      if (input) input.click()
      return input !== null
    `)
    await settle(520)
    panel = await readSubPanel(connection)
  }
  if (panel === null || panel.items.length === 0) {
    await closeModelMenu(connection)
    throw new Error(`the ${needle} panel for "${currentModel}" listed no choices${panel === null ? '' : ` (panel: ${panel.text.slice(0, 120)})`}`)
  }
  return { model: currentModel, panel }
}

/** Click one row of the open sub-panel from inside the page. */
async function clickSubPanelItem(connection, text) {
  const clicked = await pageEval(connection, `
    const panel = document.querySelector('.cr-model-selector__sub-panel')
    if (!panel) return false
    const row = Array.from(panel.querySelectorAll('.cr-model-selector__sub-panel-item'))
      .find((el) => textOf(el).replace(/^✓/, '').trim() === ${JSON.stringify(text)})
    if (!row) return false
    row.click()
    return true
  `)
  return clicked === true
}

/** Read the open model sub-panel: its toggle and its choice rows. */
async function readSubPanel(connection) {
  return pageEval(connection, `
    const panel = document.querySelector('.cr-model-selector__sub-panel')
    if (!panel) return null
    const input = panel.querySelector('.cr-model-selector__sub-panel-toggle input[role="switch"], .cr-model-selector__sub-panel-toggle .wb-switch__input')
    const toggleOn = input ? input.checked === true : undefined
    return {
      toggleOn,
      togglePoint: input ? center(input) : null,
      text: textOf(panel),
      items: Array.from(panel.querySelectorAll('.cr-model-selector__sub-panel-item')).map((el) => ({
        text: textOf(el).replace(/^✓/, '').trim(),
        active: el.className.includes('--active') || !!el.querySelector('.cr-model-selector__sub-panel-check'),
        point: center(el),
      })),
    }
  `)
}

export async function setEffort(connection, level, { model } = {}) {
  const label = EFFORT_LABELS[String(level).toLowerCase()] ?? EFFORT_LABELS[String(level)] ?? String(level)
  const { model: currentModel, panel } = await openModelSubPanel(connection, '思考强度', { model })
  const match = panel.items.find((item) => item.text === label || item.text.includes(label))
  if (match === undefined) {
    await closeModelMenu(connection)
    throw new Error(`effort "${label}" not offered by model "${currentModel}" (available: ${panel.items.map((item) => item.text).join(', ')})`)
  }
  if (match.active !== true) {
    if ((await clickSubPanelItem(connection, match.text)) !== true) {
      await connection.click(match.point.x, match.point.y)
    }
    await settle(380)
  }
  const after = await readSubPanel(connection)
  await closeModelMenu(connection)
  const active = after?.items.find((item) => item.active === true)?.text
  const label2 = await readModelLabel(connection)
  return { model: label2 ?? currentModel, requested: label, active: active || undefined, toggleOn: after?.toggleOn }
}

/** Read the context-window segmented control from the context popover. */
export async function readContextWindow(connection) {
  const available = await pageEval(connection, `return !!pick('.cr-context-usage')`)
  if (!available) return { available: false }
  await pageEval(connection, `
    if (!document.querySelector('.cr-context-usage-popover')) {
      const trigger = pick('.cr-context-usage')
      if (trigger) trigger.click()
    }
    return true
  `)
  await waitForPage(connection, `!!document.querySelector('.cr-context-usage-popover .context-window-segmented')`, { label: 'context popover' })
  await settle(200)
  const info = await pageEval(connection, `
    const popover = document.querySelector('.cr-context-usage-popover')
    const summary = textOf(popover.querySelector('.context-window-segmented__summary'))
    const anchors = Array.from(popover.querySelectorAll('.context-window-segmented__anchor')).map((el) => {
      const box = el.getBoundingClientRect()
      return {
        label: el.getAttribute('aria-label') || textOf(el),
        selected: el.getAttribute('aria-checked') === 'true' || el.className.includes('--selected'),
        point: { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) },
      }
    })
    const legend = Array.from(popover.querySelectorAll('[class*="legend"] li, [class*="legendRow"], [class*="legend"] > div')).map(textOf).filter(Boolean).slice(0, 8)
    return { summary, anchors, legend, header: textOf(popover).slice(0, 240) }
  `)
  await pageEval(connection, `
    const trigger = pick('.cr-context-usage')
    if (document.querySelector('.cr-context-usage-popover') && trigger) trigger.click()
    return true
  `)
  await settle(200)
  return { available: true, ...info }
}

/** Pick a context window size in K (300 / 600 / 960). */
/** Turn "600K" / "1M" / "960K" into a number of K, or undefined. */
function windowSizeInK(text) {
  const match = String(text ?? '').match(/(\d+(?:\.\d+)?)\s*([KM])/i)
  if (match === null) return undefined
  const value = Number(match[1])
  return match[2].toUpperCase() === 'M' ? value * 1000 : value
}

export async function setContextWindow(connection, k, { model } = {}) {
  const requested = Number(k)
  const { model: currentModel, panel } = await openModelSubPanel(connection, '上下文窗口', { model })
  const previous = panel.items.find((item) => item.active === true)?.text
  const sizes = panel.items
    .map((item) => ({ item, size: windowSizeInK(item.text) }))
    .filter((entry) => entry.size !== undefined)
  // Models differ here: one offers 300K/600K/960K, another 300K/600K/1M. Match
  // by size rather than by the literal label, and treat 0 as "the largest".
  let chosen = sizes.find((entry) => entry.size === requested)
  if (chosen === undefined && requested >= 960) {
    chosen = sizes.slice().sort((left, right) => right.size - left.size)[0]
  }
  if (chosen === undefined && requested === 0) {
    chosen = sizes.slice().sort((left, right) => right.size - left.size)[0]
  }
  if (chosen === undefined) {
    await closeModelMenu(connection)
    throw new Error(`context window ${requested}K not offered by model "${currentModel}" (available: ${panel.items.map((item) => item.text).join(', ')})`)
  }
  if (chosen.item.active !== true) {
    if ((await clickSubPanelItem(connection, chosen.item.text)) !== true) {
      await connection.click(chosen.item.point.x, chosen.item.point.y)
    }
    await settle(420)
  }
  const after = await readSubPanel(connection)
  await closeModelMenu(connection)
  const active = after?.items.find((item) => item.active === true)?.text
  return { model: (await readModelLabel(connection)) ?? currentModel, requested: chosen.item.text, previous, active: active || undefined }
}

/** Read the expert marketplace: cards, roles, and whether a summon button exists. */
export async function readExperts(connection, { query } = {}) {
  await clickSidebarTab(connection, '专家·技能·连接器')
  await waitForPage(connection, `document.querySelectorAll('article._card_inx9i_3, button._summonBtn_inx9i_434').length > 0`, {
    label: 'expert list',
    timeoutMs: 12000,
  })
  await settle(600)
  const experts = await pageEval(connection, `
    const cards = Array.from(document.querySelectorAll('article._card_inx9i_3')).map((card) => {
      const summon = card.querySelector('button._summonBtn_inx9i_434')
      const role = textOf(card.querySelector('._role_inx9i_110'))
      const name = (summon?.getAttribute('aria-label') || '').replace('召唤', '').trim() || textOf(card.querySelector('[class*="expertName"]'))
      return { name, role, canSummon: !!summon, text: textOf(card).slice(0, 160) }
    })
    return cards.filter((card) => card.name || card.role)
  `)
  const filtered = query
    ? experts.filter((entry) => `${entry.name} ${entry.role} ${entry.text}`.includes(query))
    : experts
  return { total: experts.length, experts: filtered }
}

/**
 * Summon an expert from the marketplace page.
 *
 * The per-card 召唤 button is hidden until its card is hovered, so it is
 * dispatched with an in-page click (the same thing a keyboard user's Enter on
 * that button does) instead of chasing mouse coordinates that do not exist.
 * Summoning returns to the composer with a sample prompt pre-filled, so the
 * caller is told what got inserted; the send step clears it before typing.
 */
export async function summonExpert(connection, name, { timeoutMs = 20000 } = {}) {
  await clickSidebarTab(connection, '专家·技能·连接器')
  await waitForPage(connection, `document.querySelectorAll('[class*="summonBtn"]').length > 0`, {
    label: 'expert list',
    timeoutMs: 12000,
  })
  await settle(500)
  const deadline = Date.now() + timeoutMs
  const wanted = name
  while (Date.now() < deadline) {
    const clicked = await pageEval(connection, `
      const wanted = ${JSON.stringify(wanted)}
      const buttons = Array.from(document.querySelectorAll('[class*="summonBtn"]'))
      const label = (el) => (el.getAttribute('aria-label') || '').replace('召唤', '').trim()
      const exact = buttons.find((el) => label(el) === wanted)
      const loose = buttons.find((el) => label(el).includes(wanted))
      const target = exact || loose
      if (!target) return null
      const card = target.closest('article, [class*="_card_"]') || target.parentElement
      card?.scrollIntoView({ block: 'center' })
      target.click()
      return label(target)
    `)
    if (clicked !== null) {
      await waitForPage(connection, `!!document.querySelector('.cr-input-box, .cr-status-chips, ._editable_1cxd2_1')`, { label: 'composer after summon', timeoutMs: 10000 })
      await settle(800)
      const state = await readState(connection)
      return { summoned: clicked, chips: state.chips, composerText: state.composerText, model: state.model, view: state.view }
    }
    const scrolled = await pageEval(connection, `
      const scroller = Array.from(document.querySelectorAll('div, main, section'))
        .filter((el) => el.scrollHeight > el.clientHeight + 80 && el.clientHeight > 200)
        .sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
      if (!scroller) return null
      scroller.scrollTop = scroller.scrollTop + Math.max(320, scroller.clientHeight - 120)
      return scroller.scrollTop
    `)
    if (scrolled === null) break
    await settle(500)
  }
  throw new Error(`expert not found on the marketplace page: ${wanted}`)
}

/** The composer editor element (home or conversation view). */
async function composerPoint(connection) {
  return pageEval(connection, `
    const editor = pick('.conversation-input__box [contenteditable="true"]')
      || pick('.cr-input-box [contenteditable="true"]')
      || pick('._editable_1cxd2_1')
      || pick('[role="textbox"][contenteditable="true"]')
    if (!editor) return null
    editor.scrollIntoView({ block: 'center' })
    const box = editor.getBoundingClientRect()
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), hadText: textOf(editor).length > 0 }
  `)
}

/** Replace the composer content with `text` (never append: the editor keeps prefills). */
export async function typeTask(connection, text) {
  const point = await composerPoint(connection)
  if (point === null) throw new Error('composer editor not found')
  await connection.click(point.x, point.y)
  await settle(180)
  await connection.selectAll()
  await settle(120)
  await connection.key(['Backspace'])
  await settle(120)
  await connection.insertText(text)
  await settle(250)
  let state = await pageEval(connection, `
    const editor = pick('.conversation-input__box [contenteditable="true"]')
      || pick('.cr-input-box [contenteditable="true"]')
      || pick('._editable_1cxd2_1')
      || pick('[role="textbox"][contenteditable="true"]')
    return { text: textOf(editor), sendDisabled: (() => { const btn = pick('.cr-send-button'); return btn ? (btn.hasAttribute('disabled') || btn.className.includes('disabled')) : true })() }
  `)
  const normalized = (value) => String(value).replace(/\s+/g, ' ').trim()
  if (normalized(state.text) !== normalized(text)) {
    // One retry: the editor sometimes needs a real keypress before insertText lands.
    await connection.selectAll()
    await connection.key(['Backspace'])
    await connection.insertText(text)
    await settle(250)
    const again = await pageEval(connection, `
      const editor = pick('.conversation-input__box [contenteditable="true"]')
        || pick('.cr-input-box [contenteditable="true"]')
        || pick('._editable_1cxd2_1')
        || pick('[role="textbox"][contenteditable="true"]')
      const btn=pick('.cr-send-button')
      return {text:textOf(editor),sendDisabled:btn ? btn.hasAttribute('disabled')||btn.className.includes('disabled') : true}
    `)
    if (normalized(again.text) !== normalized(text)) {
      throw new Error('Composer did not match the complete requested task after replacing its prefill; no message was sent.')
    }
    state=again
  }
  return { text: state.text, sendDisabled: state.sendDisabled, prefillRemoved:point.hadText, clearedBeforeInsert:true,exactMatchVerified:true }
}

/** Submit whatever the composer holds. */
export async function sendComposer(connection) {
  const point = await pageEval(connection, `
    const button = pick('.cr-send-button')
    if (!button) return null
    if (button.hasAttribute('disabled') || button.className.includes('disabled')) return { disabled: true }
    const box = button.getBoundingClientRect()
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
  `)
  if (point === null) throw new Error('send button not found')
  if (point.disabled === true) throw new Error('send button is disabled: the composer looks empty')
  await connection.click(point.x, point.y)
  await settle(600)
  return { sent: true }
}

/** Read the conversation view: is a turn running, what is the last answer. */
export async function readConversation(connection) {
  return pageEval(connection, `
    const frames = pickAll('.cr-frame')
    const assistant = pickAll('.cr-agent__content .cr-markdown, .cr-agent__content')
    const lastAssistant = assistant.length > 0 ? textOf(assistant[assistant.length - 1]).slice(-4000) : ''
    const statuses = pickAll('.cr-agent__completion-status').map(textOf).filter(Boolean)
    const finished = !!pick('.conversation-finished-footer, .cr-agent__completion-status')
    const sendDisabled = (() => { const btn = pick('.cr-send-button'); return btn ? (btn.hasAttribute('disabled') || btn.className.includes('disabled')) : true })()
    const running = Array.from(document.querySelectorAll('.cr-send-button [class*="stop"], [class*="stopIcon"], [aria-label*="停止"]')).some(visible)
    return {
      frames: frames.length,
      lastAssistant,
      statuses,
      finished,
      running,
      sendDisabled,
      errorBanner: textOf(pick('.cr-error, [class*="errorBanner"]')) || undefined,
    }
  `)
}

async function modalProjectName(connection,name) {
  const point=await pageEval(connection,`const input=pick('.space-editor-modal input[aria-label="分组名称"]');return input?center(input):null`)
  if(!point)throw new Error('Project-name input not found in the native group editor.')
  await pageEval(connection,`const input=pick('.space-editor-modal input[aria-label="分组名称"]');if(!input)throw new Error('Project input not found');input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(name)});input.dispatchEvent(new Event('input',{bubbles:true}));return true`)
  await settle(250)
  const accepted=await pageEval(connection,`return pick('.space-editor-modal input[aria-label="分组名称"]')?.value===${JSON.stringify(name)}`)
  if(!accepted) {
    await pageEval(connection,`const input=pick('.space-editor-modal input[aria-label="分组名称"]');if(input){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(name)});input.dispatchEvent(new Event('input',{bubbles:true}))}return true`)
    await settle(200)
  }
  const save=await waitForPage(connection,`(()=>{
    const modal=document.querySelector('.space-editor-modal')
    const input=modal?.querySelector('input[aria-label="分组名称"]')
    if(input?.value!==${JSON.stringify(name)})return null
    const button=[...modal.querySelectorAll('button')].find(b=>textOf(b)==='保存'&&!b.disabled&&!b.className.includes('--disabled'))
    return button?center(button):null
  })()`,{timeoutMs:8000,label:'project name accepted and save enabled'})
  if(!save)throw new Error('Native project editor did not accept the requested name.')
  await pageEval(connection,`const modal=document.querySelector('.space-editor-modal');const button=[...modal?.querySelectorAll('button')??[]].find(b=>textOf(b)==='保存'&&!b.disabled);if(!button)throw new Error('Project save button unavailable');button.click();return true`)
  await waitForPage(connection,`!document.querySelector('.space-editor-modal')`,{label:'project saved'})
}
export async function createProject(connection,name) {
  const busy=await pageEval(connection,`return !!document.querySelector('.space-editor-modal,[role="dialog"]')`)
  if(busy) {
    const resumable=await pageEval(connection,`const m=document.querySelector('.space-editor-modal');return !!m&&textOf(m.querySelector('.wb-modal__title'))==='新建分组'&&m.querySelector('input')?.value===${JSON.stringify(name)}`)
    if(!resumable)throw new Error('An existing dialog is open; bridge did not overwrite its fields.')
    await modalProjectName(connection,name)
    return {name,resumed:true}
  }
  await connection.key(['Escape'])
  const activated=await pageEval(connection,`const add=document.querySelector('.conversation-section-add-btn');if(!add)return false;add.scrollIntoView({block:'nearest'});add.click();return true`)
  if(!activated)throw new Error('WorkBuddy group/project creation control not found.')
  await waitForPage(connection,`!!pick('.space-editor-modal input[aria-label="分组名称"]')`,{label:'new project editor'})
  await modalProjectName(connection,name)
  return {name}
}
export async function renameProject(connection,id,name) {
  await connection.key(['Escape'])
  const opened=await pageEval(connection,`
    const header=document.querySelector(${JSON.stringify('[data-flat-row-id=')}+JSON.stringify('grouped-sub-space:'+${JSON.stringify(id)}+'::header')+']')
    const button=header?.querySelector('.workspace-more-button')
    if(!button)return false
    header.scrollIntoView({block:'center'});button.click();return true
  `)
  if(!opened)throw new Error(`Project ${id} header not found.`)
  await settle(250)
  const menu=await pageEval(connection,`
    const items=pickAll('button,[role="menuitem"]')
    const button=items.find(e=>['重命名','编辑分组','修改分组','编辑'].includes(textOf(e)))
    return button?center(button):null
  `)
  if(!menu)throw new Error('Project rename/edit action not found; no name was changed.')
  await connection.click(menu.x,menu.y)
  await waitForPage(connection,`!!pick('.space-editor-modal input[aria-label="分组名称"]')`,{label:'rename project editor'})
  await modalProjectName(connection,name)
  return {id,name}
}
export async function openNewProjectTask(connection,id) {
  await connection.key(['Escape'])
  const activated=await pageEval(connection,`
    const header=document.querySelector(${JSON.stringify('[data-flat-row-id=')}+JSON.stringify('grouped-sub-space:'+${JSON.stringify(id)}+'::header')+']')
    const button=header?.querySelector('.workspace-new-task-button')
    if(!button)return false
    header.scrollIntoView({block:'center'});button.click();return true
  `)
  if(!activated)throw new Error(`New-task control for project ${id} not found.`)
  await waitForPage(connection,`pickAll('[data-conversation-input-id]').some(e=>e.getAttribute('data-conversation-input-id')?.startsWith('__home__:'))`,{label:'project task composer'})
}
export async function moveSessionToProject(connection,sessionId,projectName) {
  await connection.key(['Escape'])
  const opened=await pageEval(connection,`
    const card=document.querySelector(${JSON.stringify('.cb-agent-card[data-conversation-id=')}+JSON.stringify(${JSON.stringify(sessionId)})+']')
    const button=card?.querySelector('.agent-card-more-button')
    if(!button)return false
    card.scrollIntoView({block:'center'});button.click();return true
  `)
  if(!opened)throw new Error('Target session card not found for project assignment.')
  await settle(200)
  const group=await pageEval(connection,`const button=pickAll('.conversation-context-menu button').find(e=>textOf(e)==='分组');return button?center(button):null`)
  if(!group)throw new Error('Session group submenu not found.')
  await connection.hover(group.x,group.y)
  await waitForPage(connection,`!!pick('.cb-context-submenu')`,{label:'group submenu'})
  const target=await pageEval(connection,`
    const matches=[...document.querySelectorAll('.cb-context-submenu button')].filter(e=>textOf(e)===${JSON.stringify(projectName)})
    if(matches.length!==1)return null
    matches[0].scrollIntoView({block:'nearest'});return visible(matches[0])?center(matches[0]):null
  `)
  if(!target)throw new Error('Exact unique target project not found in the session group submenu.')
  await connection.click(target.x,target.y)
  await settle(300)
}
