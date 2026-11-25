// Пути на сервере (POSIX). Все пути абсолютные и уже нормализованные: без «.», «..»,
// двойных и конечных «/» (кроме корня).

export function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`
}

export function parentPath(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

export function baseName(path: string): string {
  return path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1)
}

/** path совпадает с dir или лежит внутри неё. */
export function isWithin(path: string, dir: string): boolean {
  if (dir === '/') return path.startsWith('/')
  return path === dir || path.startsWith(`${dir}/`)
}

/** Путь после переименования папки from в to (для путей внутри неё). */
export function rebase(path: string, from: string, to: string): string {
  if (path === from) return to
  return joinPath(to, path.slice(from === '/' ? 1 : from.length + 1))
}

/** Папки по пути от корня: '/a/b' → ['/a', '/a/b']. */
export function ancestry(path: string): string[] {
  const out: string[] = []
  let acc = ''
  for (const part of path.split('/')) {
    if (!part) continue
    acc += `/${part}`
    out.push(acc)
  }
  return out
}

/** Только верхние пути: если выбраны и папка, и что-то внутри неё — остаётся папка. */
export function topLevel(paths: string[]): string[] {
  const sorted = [...new Set(paths)].sort()
  const out: string[] = []
  for (const p of sorted) if (!out.some((top) => isWithin(p, top))) out.push(p)
  return out
}

/** Можно ли положить paths в папку dir: не в себя, не внутрь себя и не туда, где всё и так лежит. */
export function canMoveInto(paths: string[], dir: string): boolean {
  if (!paths.length || paths.some((p) => isWithin(dir, p))) return false
  return paths.some((p) => parentPath(p) !== dir)
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** Имя файла с сервера, безопасное для Windows: без запрещённых символов, «..» и зарезервированных имён. */
export function safeLocalName(name: string): string {
  let n = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '')
  if (!n || n === '.' || n === '..') n = '_'
  if (RESERVED.test(n)) n = `_${n}`
  return n
}

/** Аргумент для POSIX-оболочки: без кавычек, если они не нужны. */
export function shellQuote(s: string): string {
  if (/^[\w./@%+=:,-]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'\\''`)}'`
}
