// Проверка и нормализация данных. Используется главным процессом при чтении файлов
// и при приёме данных из окна. Строгий режим бросает ошибку, мягкий — пропускает
// повреждённые записи и сообщает о них.

import type {
  AuthMethod,
  CursorStyle,
  FolderNode,
  LayoutId,
  Macro,
  MacroScope,
  SessionNode,
  Settings,
  TerminalFont,
  ThemeId,
  TreeNode
} from './types'
import { hotkeyProblem } from './hotkeys'

export const LIMITS = {
  maxDepth: 16,
  maxNodes: 5000,
  nameLength: 120,
  hostLength: 253,
  userLength: 64,
  keyPathLength: 1024,
  passwordLength: 4096,
  maxMacros: 500,
  macroLength: 64 * 1024
} as const

export const MACRO_DELAYS = [0, 300, 500, 1000, 2000, 5000] as const

export const DEFAULT_SETTINGS: Settings = {
  theme: 'graphite',
  layout: 'stacked',
  sidebarWidth: 272,
  terminal: {
    font: 'cascadia',
    fontSize: 14,
    lineHeight: 1.2,
    cursorStyle: 'block',
    cursorBlink: true,
    scrollback: 10_000,
    copyOnSelect: true,
    rightClickPaste: false,
    defaultShell: ''
  },
  files: {
    showHidden: true,
    followTerminal: true,
    confirmMove: true
  },
  editor: {
    wordWrap: false
  },
  monitor: {
    statusBar: true
  },
  macros: {
    showBar: true
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
// Буквы, цифры и знаки, допустимые в имени хоста, IPv4 и IPv6 (включая зону %eth0).
const HOST_RE = /^[A-Za-z0-9._%:-]+$/
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/
const AUTH_METHODS: readonly AuthMethod[] = ['password', 'key', 'agent']

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function isValidId(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v)
}

/** Приводит адрес к виду без скобок IPv6 и пробелов. Возвращает null, если адрес недопустим. */
export function normalizeHost(v: unknown): string | null {
  if (typeof v !== 'string') return null
  let host = v.trim()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (!host || host.length > LIMITS.hostLength || !HOST_RE.test(host)) return null
  return host
}

export function normalizeName(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const name = v.replace(/\s+/g, ' ').trim()
  if (!name || name.length > LIMITS.nameLength || CONTROL_RE.test(name)) return null
  return name
}

export function normalizeUsername(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const user = v.trim()
  if (!user || user.length > LIMITS.userLength || /\s/.test(user) || CONTROL_RE.test(user)) return null
  return user
}

export function normalizePort(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null
}

export function normalizeKeyPath(v: unknown): string | null {
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string') return null
  const p = v.trim()
  if (p.length > LIMITS.keyPathLength || CONTROL_RE.test(p)) return null
  return p
}

/** Проверяет сессию. Возвращает нормализованную копию или текст ошибки. */
export function checkSession(raw: unknown): SessionNode | string {
  if (!isObject(raw) || raw.type !== 'session') return 'не является сессией'
  if (!isValidId(raw.id)) return 'некорректный идентификатор'
  const name = normalizeName(raw.name)
  if (!name) return 'некорректное название'
  const host = normalizeHost(raw.host)
  if (!host) return 'некорректный адрес сервера'
  const port = normalizePort(raw.port)
  if (!port) return 'некорректный порт'
  const username = normalizeUsername(raw.username)
  if (!username) return 'некорректное имя пользователя'
  const auth = AUTH_METHODS.includes(raw.auth as AuthMethod) ? (raw.auth as AuthMethod) : null
  if (!auth) return 'неизвестный способ входа'
  const keyPath = normalizeKeyPath(raw.keyPath)
  if (keyPath === null) return 'некорректный путь к ключу'
  const session: SessionNode = { type: 'session', id: raw.id, name, host, port, username, auth, keyPath }
  if (isValidId(raw.onConnect)) session.onConnect = raw.onConnect
  return session
}

/** Макрос из окна или с диска: текст или null, если запись повреждена. */
export function checkMacro(raw: unknown): Macro | string {
  if (!isObject(raw)) return 'не является макросом'
  if (!isValidId(raw.id)) return 'некорректный идентификатор'
  const name = normalizeName(raw.name)
  if (!name) return 'некорректное название'
  if (typeof raw.commands !== 'string' || !raw.commands.trim() || raw.commands.length > LIMITS.macroLength) return 'нет команд'
  const s = isObject(raw.scope) ? raw.scope : {}
  let scope: MacroScope
  if (s.type === 'folder' || s.type === 'session') {
    if (!isValidId(s.id)) return 'некорректная область'
    scope = { type: s.type, id: s.id }
  } else if (s.type === 'local') {
    scope = { type: 'local' }
  } else {
    scope = { type: 'all' }
  }
  const hotkey = typeof raw.hotkey === 'string' && raw.hotkey && !hotkeyProblem(raw.hotkey) ? raw.hotkey : ''
  const delay = (MACRO_DELAYS as readonly number[]).includes(raw.delay as number) ? (raw.delay as number) : 0
  return { id: raw.id, name, commands: raw.commands.replace(/\r\n?/g, '\n'), enter: raw.enter !== false, delay, scope, hotkey }
}

/**
 * Список макросов. strict — для данных из окна (любая ошибка — исключение),
 * иначе повреждённые записи пропускаются (чтение файла с диска).
 */
export function checkMacros(raw: unknown, strict: boolean): { macros: Macro[]; dropped: string[] } {
  if (!Array.isArray(raw)) {
    if (strict) throw new ValidationError('Список макросов повреждён.')
    return { macros: [], dropped: ['список макросов повреждён'] }
  }
  if (raw.length > LIMITS.maxMacros) {
    if (strict) throw new ValidationError('Слишком много макросов.')
  }
  const macros: Macro[] = []
  const dropped: string[] = []
  const ids = new Set<string>()
  const hotkeys = new Set<string>()
  for (const item of raw.slice(0, LIMITS.maxMacros)) {
    const m = checkMacro(item)
    if (typeof m === 'string' || ids.has(m.id)) {
      const why = typeof m === 'string' ? m : 'повторяющийся идентификатор'
      if (strict) throw new ValidationError(`Макрос: ${why}.`)
      dropped.push(why)
      continue
    }
    if (m.hotkey && hotkeys.has(m.hotkey)) m.hotkey = '' // одна клавиша — один макрос
    if (m.hotkey) hotkeys.add(m.hotkey)
    ids.add(m.id)
    macros.push(m)
  }
  return { macros, dropped }
}

export interface TreeCheckResult {
  tree: TreeNode[]
  /** Описания пропущенных записей (только в мягком режиме). */
  dropped: string[]
}

/**
 * Проверяет дерево сессий.
 * strict = true — любая ошибка бросает ValidationError (для данных из окна).
 * strict = false — повреждённые записи пропускаются (для чтения файла с диска).
 */
export function checkTree(raw: unknown, strict: boolean): TreeCheckResult {
  const dropped: string[] = []
  const seen = new Set<string>()
  let count = 0

  const reject = (what: string): null => {
    if (strict) throw new ValidationError(what)
    dropped.push(what)
    return null
  }

  const walk = (list: unknown, depth: number, where: string): TreeNode[] => {
    if (!Array.isArray(list)) {
      reject(`${where}: ожидался список`)
      return []
    }
    const out: TreeNode[] = []
    for (const item of list) {
      const node = checkNode(item, depth, where)
      if (node) out.push(node)
    }
    return out
  }

  const checkNode = (item: unknown, depth: number, where: string): TreeNode | null => {
    if (++count > LIMITS.maxNodes) return reject('слишком много записей')
    if (!isObject(item)) return reject(`${where}: запись повреждена`)
    const label = typeof item.name === 'string' ? `«${item.name.slice(0, 60)}»` : 'без названия'
    if (isValidId(item.id) && seen.has(item.id)) return reject(`${where}: повтор идентификатора у ${label}`)
    if (item.type === 'session') {
      const s = checkSession(item)
      if (typeof s === 'string') return reject(`${where}: сессия ${label} — ${s}`)
      seen.add(s.id)
      return s
    }
    if (item.type === 'folder') {
      if (!isValidId(item.id)) return reject(`${where}: папка ${label} — некорректный идентификатор`)
      const name = normalizeName(item.name)
      if (!name) return reject(`${where}: папка — некорректное название`)
      if (depth >= LIMITS.maxDepth) return reject(`${where}: папка «${name}» вложена слишком глубоко`)
      seen.add(item.id)
      const folder: FolderNode = {
        type: 'folder',
        id: item.id,
        name,
        expanded: item.expanded !== false,
        children: walk(item.children, depth + 1, `папка «${name}»`)
      }
      return folder
    }
    return reject(`${where}: неизвестный тип записи у ${label}`)
  }

  const tree = walk(raw, 0, 'корень')
  return { tree, dropped }
}

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback

const clampNumber = (v: unknown, min: number, max: number, fallback: number, step = 0): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  let n = Math.min(max, Math.max(min, v))
  if (step) n = Math.round(n / step) * step
  return Number(n.toFixed(4))
}

/** Настройки никогда не бросают ошибку: недопустимые значения заменяются значениями по умолчанию. */
export function normalizeSettings(raw: unknown): Settings {
  const d = DEFAULT_SETTINGS
  const r = isObject(raw) ? raw : {}
  const t = isObject(r.terminal) ? r.terminal : {}
  const f = isObject(r.files) ? r.files : {}
  const e = isObject(r.editor) ? r.editor : {}
  const m = isObject(r.monitor) ? r.monitor : {}
  const mc = isObject(r.macros) ? r.macros : {}
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)
  return {
    theme: pick<ThemeId>(r.theme, ['graphite', 'classic', 'light'], d.theme),
    layout: pick<LayoutId>(r.layout, ['stacked', 'classic', 'ide'], d.layout),
    sidebarWidth: clampNumber(r.sidebarWidth, 200, 520, d.sidebarWidth, 1),
    terminal: {
      font: pick<TerminalFont>(t.font, ['cascadia', 'jetbrains', 'consolas'], d.terminal.font),
      fontSize: clampNumber(t.fontSize, 9, 28, d.terminal.fontSize, 0.5),
      lineHeight: clampNumber(t.lineHeight, 1, 1.8, d.terminal.lineHeight, 0.05),
      cursorStyle: pick<CursorStyle>(t.cursorStyle, ['block', 'bar', 'underline'], d.terminal.cursorStyle),
      cursorBlink: typeof t.cursorBlink === 'boolean' ? t.cursorBlink : d.terminal.cursorBlink,
      scrollback: clampNumber(t.scrollback, 500, 200_000, d.terminal.scrollback, 1),
      copyOnSelect: typeof t.copyOnSelect === 'boolean' ? t.copyOnSelect : d.terminal.copyOnSelect,
      rightClickPaste: typeof t.rightClickPaste === 'boolean' ? t.rightClickPaste : d.terminal.rightClickPaste,
      defaultShell: typeof t.defaultShell === 'string' && t.defaultShell.length <= 200 ? t.defaultShell : d.terminal.defaultShell
    },
    files: {
      showHidden: bool(f.showHidden, d.files.showHidden),
      followTerminal: bool(f.followTerminal, d.files.followTerminal),
      confirmMove: bool(f.confirmMove, d.files.confirmMove)
    },
    editor: {
      wordWrap: bool(e.wordWrap, d.editor.wordWrap)
    },
    monitor: {
      statusBar: bool(m.statusBar, d.monitor.statusBar)
    },
    macros: {
      showBar: bool(mc.showBar, d.macros.showBar)
    }
  }
}

/** Абсолютный путь на сервере (POSIX). Возвращает нормализованный путь или null. */
export function normalizeRemotePath(v: unknown): string | null {
  if (typeof v !== 'string' || !v.startsWith('/') || v.length > 4096 || v.includes('\0')) return null
  const parts: string[] = []
  for (const part of v.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return '/' + parts.join('/')
}

/** Имя нового файла или папки: без «/», не «.» и не «..». */
export function checkFileName(v: unknown): string | null {
  if (typeof v !== 'string') return 'Введите имя'
  const name = v.trim()
  if (!name) return 'Введите имя'
  if (name === '.' || name === '..') return 'Такое имя нельзя использовать'
  if (name.includes('/')) return 'Имя не может содержать «/»'
  if (name.includes('\0') || CONTROL_RE.test(name)) return 'Имя содержит недопустимые символы'
  if (new TextEncoder().encode(name).length > 255) return 'Слишком длинное имя'
  return null
}
