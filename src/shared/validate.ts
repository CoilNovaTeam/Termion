// Проверка и нормализация данных. Используется главным процессом при чтении файлов
// и при приёме данных из окна. Строгий режим бросает ошибку, мягкий — пропускает
// повреждённые записи и сообщает о них.

import type {
  AuthMethod,
  CursorStyle,
  FolderNode,
  LayoutId,
  SessionNode,
  Settings,
  TerminalFont,
  ThemeId,
  TreeNode
} from './types'

export const LIMITS = {
  maxDepth: 16,
  maxNodes: 5000,
  nameLength: 120,
  hostLength: 253,
  userLength: 64,
  keyPathLength: 1024,
  passwordLength: 4096
} as const

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
    rightClickPaste: false
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
  return { type: 'session', id: raw.id, name, host, port, username, auth, keyPath }
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
      rightClickPaste: typeof t.rightClickPaste === 'boolean' ? t.rightClickPaste : d.terminal.rightClickPaste
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
