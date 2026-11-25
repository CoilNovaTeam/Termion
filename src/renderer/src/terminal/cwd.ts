// Текущая папка оболочки на сервере. Узнаём её двумя способами:
//  • заголовок окна «user@host: ~/app» — так его по умолчанию ставит bash в Ubuntu/Debian
//    (а «user@host:~/app» — в Fedora/RHEL), похоже делают многие настройки zsh;
//  • последовательность OSC 7 «file://host/path» — её шлют fish, zsh с vte.sh и другие.

import { normalizeRemotePath } from '@shared/validate'

export interface CwdHint {
  /** Абсолютный путь или путь, начинающийся с «~». */
  path: string
  /** Пользователь из заголовка — чтобы понять, чей «~». */
  user: string | null
}

const TITLE = /^([a-z_][\w.-]*\$?)@([\w.-]+):\s?(~[\w.-]*(?:\/.*)?|\/.*)$/i

export function cwdFromTitle(title: string): CwdHint | null {
  const m = TITLE.exec(title.replace(/\s+$/, ''))
  if (!m) return null
  const path = m[3]
  // PROMPT_DIRTRIM сокращает путь до «…/a/b» — по такому заголовку папку не восстановить.
  if (path.includes('/.../') || path.includes('/…/')) return null
  return { path, user: m[1] }
}

export function cwdFromOsc7(data: string): CwdHint | null {
  const m = /^file:\/\/[^/]*(\/[^?#]*)/.exec(data)
  if (!m) return null
  try {
    return { path: decodeURIComponent(m[1]), user: null }
  } catch {
    return null
  }
}

/**
 * Абсолютный путь по подсказке. login — пользователь подключения, home — его домашняя
 * папка по SFTP (null, если ещё неизвестна). Для чужого «~» берём обычное место домашней папки.
 */
export function resolveCwd(hint: CwdHint, login: string, home: string | null): string | null {
  const { path } = hint
  if (path.startsWith('/')) return normalizeRemotePath(path)
  const slash = path.indexOf('/')
  const head = slash < 0 ? path : path.slice(0, slash)
  const rest = slash < 0 ? '' : path.slice(slash)
  const user = head.length > 1 ? head.slice(1) : (hint.user ?? login)
  let base: string | null
  if (user === login) base = home
  else if (user === 'root') base = '/root'
  else base = `/home/${user}`
  return base ? normalizeRemotePath(base + rest) : null
}
