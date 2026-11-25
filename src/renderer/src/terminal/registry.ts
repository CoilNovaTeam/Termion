// Реестр терминалов. Экземпляры xterm.js живут вне React: компонент вкладки лишь
// встраивает готовый терминал в свой контейнер. Поэтому смена раскладки или
// перерисовка интерфейса не пересоздаёт терминал и не теряет историю.

import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import type { NoticeLevel, Settings } from '@shared/types'
import { api } from '../api'
import type { MenuEntry } from '../store/app'
import { cwdFromOsc7, cwdFromTitle, type CwdHint } from './cwd'
import { ensureFont, terminalOptions } from './themes'

export interface TerminalHost {
  settings(): Settings
  /** Терминал готов и знает свой размер — можно подключаться. */
  connect(tabId: string): void
  reconnect(tabId: string): void
  closeTab(tabId: string): void
  isConnected(tabId: string): boolean
  onResize(tabId: string, cols: number, rows: number): void
  /** Оболочка сообщила текущую папку (заголовком окна или OSC 7). */
  onCwd(tabId: string, hint: CwdHint): void
  showMenu(x: number, y: number, items: MenuEntry[]): void
}

interface Entry {
  tabId: string
  term: Terminal
  fit: FitAddon
  host: HTMLDivElement
  observer: ResizeObserver
  webgl: WebglAddon | null
  opened: boolean
  disposed: boolean
  connId: string | null
  disconnected: boolean
  /** Последний выведенный байт — перевод строки (чтобы служебные строки не слипались с выводом). */
  atLineStart: boolean
  fitFrame: number
  copyTimer: ReturnType<typeof setTimeout> | undefined
}

const entries = new Map<string, Entry>()
const tabByConn = new Map<string, string>()
const pendingAcks = new Map<string, number>()
let ackTimer: ReturnType<typeof setTimeout> | null = null
let host: TerminalHost

export function configure(h: TerminalHost): void {
  host = h
}

// Сброс режимов, которые удалённая программа могла оставить включёнными (альтернативный
// экран vim/htop, мышь, вставка скобками, скрытый курсор), без очистки истории.
const RESET_MODES = '\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[!p\x1b[?25h\x1b[0m'

const NOTICE_STYLE: Record<NoticeLevel, [string, string]> = {
  info: ['\x1b[2m', ''],
  success: ['\x1b[32m', '✓ '],
  warn: ['\x1b[33m', '⚠ '],
  error: ['\x1b[31m', '✖ ']
}

function create(tabId: string): Entry {
  const term = new Terminal(terminalOptions(host.settings()))
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      // Ссылки открываются только по Ctrl+клик, чтобы случайный клик не уводил в браузер.
      if (event.ctrlKey || event.metaKey) void api.app.openExternal(uri)
    })
  )

  const el = document.createElement('div')
  el.className = 'term-host'

  const entry: Entry = {
    tabId,
    term,
    fit,
    host: el,
    observer: new ResizeObserver(() => scheduleFit(entry)),
    webgl: null,
    opened: false,
    disposed: false,
    connId: null,
    disconnected: false,
    atLineStart: true,
    fitFrame: 0,
    copyTimer: undefined
  }

  term.attachCustomKeyEventHandler((ev) => handleKey(entry, ev))
  term.onData((data) => input(entry, data, false))
  term.onBinary((data) => input(entry, data, true))
  term.onResize(({ cols, rows }) => {
    if (entry.connId && !entry.disconnected) api.ssh.resize(entry.connId, cols, rows)
    host.onResize(tabId, cols, rows)
  })
  term.onSelectionChange(() => scheduleCopy(entry))
  term.onTitleChange((title) => {
    const hint = cwdFromTitle(title)
    if (hint) host.onCwd(tabId, hint)
  })
  term.parser.registerOscHandler(7, (data) => {
    const hint = cwdFromOsc7(data)
    if (hint) host.onCwd(tabId, hint)
    return true
  })
  el.addEventListener('contextmenu', (ev) => onContextMenu(entry, ev))
  entry.observer.observe(el)
  entries.set(tabId, entry)
  return entry
}

function enableWebgl(entry: Entry): void {
  try {
    const webgl = new WebglAddon()
    webgl.onContextLoss(() => {
      // Видеодрайвер сбросил контекст — переходим на обычную отрисовку.
      webgl.dispose()
      entry.webgl = null
    })
    entry.term.loadAddon(webgl)
    entry.webgl = webgl
  } catch {
    entry.webgl = null
  }
}

function fitNow(entry: Entry): void {
  if (!entry.opened || entry.disposed) return
  if (entry.host.clientWidth < 40 || entry.host.clientHeight < 30) return
  try {
    entry.fit.fit()
  } catch {
    // размеры ещё не готовы
  }
}

function scheduleFit(entry: Entry): void {
  cancelAnimationFrame(entry.fitFrame)
  entry.fitFrame = requestAnimationFrame(() => fitNow(entry))
}

// ---------- встраивание ----------

export function attach(tabId: string, container: HTMLElement): void {
  const entry = entries.get(tabId) ?? create(tabId)
  if (entry.host.parentElement !== container) container.appendChild(entry.host)
  if (entry.opened) {
    scheduleFit(entry)
    return
  }
  void ensureFont(host.settings().terminal.font).then(() => {
    if (entry.disposed || entry.opened || !entry.host.isConnected) return
    entry.term.open(entry.host)
    entry.opened = true
    enableWebgl(entry)
    fitNow(entry)
    host.onResize(tabId, entry.term.cols, entry.term.rows)
    host.connect(tabId)
  })
}

export function activate(tabId: string): void {
  const entry = entries.get(tabId)
  if (!entry) return
  requestAnimationFrame(() => {
    fitNow(entry)
    if (entry.opened) entry.term.focus()
  })
}

export function focus(tabId: string | null): void {
  if (tabId) activate(tabId)
}

export function size(tabId: string): { cols: number; rows: number } {
  const entry = entries.get(tabId)
  return entry ? { cols: entry.term.cols, rows: entry.term.rows } : { cols: 80, rows: 24 }
}

export function dispose(tabId: string): void {
  const entry = entries.get(tabId)
  if (!entry) return
  entry.disposed = true
  cancelAnimationFrame(entry.fitFrame)
  clearTimeout(entry.copyTimer)
  entry.observer.disconnect()
  if (entry.connId) tabByConn.delete(entry.connId)
  entry.webgl?.dispose()
  entry.term.dispose()
  entry.host.remove()
  entries.delete(tabId)
}

// ---------- подключение ----------

export function bind(tabId: string, connId: string): void {
  const entry = entries.get(tabId)
  if (!entry) return
  if (entry.connId) tabByConn.delete(entry.connId)
  entry.connId = connId
  entry.disconnected = false
  tabByConn.set(connId, tabId)
}

export function write(connId: string, data: Uint8Array): void {
  const tabId = tabByConn.get(connId)
  const entry = tabId ? entries.get(tabId) : undefined
  if (!entry) {
    api.ssh.ack(connId, data.length)
    return
  }
  if (data.length) entry.atLineStart = data[data.length - 1] === 0x0a
  entry.term.write(data, () => queueAck(connId, data.length))
}

function queueAck(connId: string, bytes: number): void {
  pendingAcks.set(connId, (pendingAcks.get(connId) ?? 0) + bytes)
  if (ackTimer) return
  ackTimer = setTimeout(() => {
    ackTimer = null
    for (const [id, n] of pendingAcks) api.ssh.ack(id, n)
    pendingAcks.clear()
  }, 8)
}

function writeLine(entry: Entry, text: string): void {
  const lead = entry.atLineStart ? '' : '\r\n'
  entry.term.write(`${lead}${text}\r\n`)
  entry.atLineStart = true
}

export function notice(tabId: string, level: NoticeLevel, text: string): void {
  const entry = entries.get(tabId)
  if (!entry) return
  const [color, mark] = NOTICE_STYLE[level]
  writeLine(entry, `${color}${mark}${text.replace(/\r?\n/g, '\r\n')}\x1b[0m`)
}

export function setDisconnected(tabId: string, disconnected: boolean): void {
  const entry = entries.get(tabId)
  if (!entry) return
  if (!disconnected) {
    entry.disconnected = false
    return
  }
  if (entry.disconnected) return
  entry.disconnected = true
  entry.term.write(RESET_MODES)
  writeLine(entry, '\x1b[2mНажмите Enter, чтобы подключиться снова.\x1b[0m')
}

export function beginReconnect(tabId: string): void {
  const entry = entries.get(tabId)
  if (!entry) return
  entry.term.write(RESET_MODES)
  writeLine(entry, '')
}

// ---------- ввод, копирование, вставка ----------

function input(entry: Entry, data: string, binary: boolean): void {
  if (entry.disconnected) {
    if (data === '\r') host.reconnect(entry.tabId)
    return
  }
  if (!entry.connId || !host.isConnected(entry.tabId)) return
  api.ssh.write(entry.connId, data, binary)
}

function copySelection(entry: Entry, clear: boolean): void {
  const text = entry.term.getSelection()
  if (text) api.clipboard.writeText(text)
  if (clear) entry.term.clearSelection()
}

async function paste(entry: Entry): Promise<void> {
  if (entry.disconnected || !host.isConnected(entry.tabId)) return
  const text = await api.clipboard.readText()
  if (text) entry.term.paste(text)
}

function scheduleCopy(entry: Entry): void {
  if (!host.settings().terminal.copyOnSelect) return
  clearTimeout(entry.copyTimer)
  entry.copyTimer = setTimeout(() => {
    if (entry.term.hasSelection()) copySelection(entry, false)
  }, 150)
}

function handleKey(entry: Entry, ev: KeyboardEvent): boolean {
  if (ev.type !== 'keydown') return true
  // ev.code — физическая клавиша: сочетания работают и при русской раскладке.
  const ctrlOnly = ev.ctrlKey && !ev.altKey && !ev.metaKey
  // Ctrl+C копирует, только если что-то выделено; иначе это обычное прерывание (^C).
  if (ctrlOnly && ev.code === 'KeyC' && (ev.shiftKey || entry.term.hasSelection())) {
    ev.preventDefault()
    copySelection(entry, true)
    return false
  }
  if (ctrlOnly && ev.code === 'KeyV') {
    ev.preventDefault()
    void paste(entry)
    return false
  }
  if (ev.key === 'Insert' && ev.shiftKey && !ev.ctrlKey) {
    ev.preventDefault()
    void paste(entry)
    return false
  }
  if (ev.key === 'Insert' && ev.ctrlKey && !ev.shiftKey) {
    ev.preventDefault()
    copySelection(entry, false)
    return false
  }
  return true
}

function onContextMenu(entry: Entry, ev: MouseEvent): void {
  ev.preventDefault()
  const { term } = entry
  if (host.settings().terminal.rightClickPaste) {
    if (term.hasSelection()) copySelection(entry, true)
    else void paste(entry)
    return
  }
  const connected = !entry.disconnected && host.isConnected(entry.tabId)
  host.showMenu(ev.clientX, ev.clientY, [
    { label: 'Копировать', icon: 'copy', hint: 'Ctrl+C', disabled: !term.hasSelection(), onSelect: () => copySelection(entry, true) },
    { label: 'Вставить', icon: 'paste', hint: 'Ctrl+V', disabled: !connected, onSelect: () => void paste(entry) },
    { label: 'Выделить всё', icon: 'selectAll', onSelect: () => term.selectAll() },
    { label: 'Очистить экран', icon: 'eraser', onSelect: () => term.clear() },
    'separator',
    { label: 'Переподключиться', icon: 'refresh', hint: 'Ctrl+Shift+R', onSelect: () => host.reconnect(entry.tabId) },
    { label: 'Закрыть вкладку', icon: 'x', hint: 'Ctrl+Shift+W', onSelect: () => host.closeTab(entry.tabId) }
  ])
}

// ---------- настройки ----------

export function applySettings(settings: Settings): void {
  const options = terminalOptions(settings)
  void ensureFont(settings.terminal.font).then(() => {
    for (const entry of entries.values()) {
      if (entry.disposed) continue
      entry.term.options.theme = options.theme
      entry.term.options.fontFamily = options.fontFamily
      entry.term.options.fontWeight = options.fontWeight
      entry.term.options.fontWeightBold = options.fontWeightBold
      entry.term.options.fontSize = options.fontSize
      entry.term.options.lineHeight = options.lineHeight
      entry.term.options.cursorStyle = options.cursorStyle
      entry.term.options.cursorBlink = options.cursorBlink
      entry.term.options.scrollback = options.scrollback
      scheduleFit(entry)
    }
  })
}
