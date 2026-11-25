// Форматирование размеров, дат и прав доступа для интерфейса.

import type { RemoteEntry } from '@shared/types'

const UNITS = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  const text = unit === 0 || value >= 100 ? Math.round(value).toString() : value.toFixed(1).replace('.', ',')
  return `${text} ${UNITS[unit]}`
}

const DATE = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

/** Время Unix в секундах → «25.11.2026, 14:05». */
export function formatDate(seconds: number): string {
  return seconds > 0 ? DATE.format(new Date(seconds * 1000)) : '—'
}

/** Права как в ls -l: «drwxr-xr-x». */
export function modeString(entry: Pick<RemoteEntry, 'type' | 'mode'>): string {
  const m = entry.mode
  const kind = entry.type === 'dir' ? 'd' : entry.type === 'link' ? 'l' : '-'
  const bits = (r: number, w: number, x: number, special: number, ch: string) =>
    `${m & r ? 'r' : '-'}${m & w ? 'w' : '-'}${m & special ? (m & x ? ch : ch.toUpperCase()) : m & x ? 'x' : '-'}`
  return kind + bits(0o400, 0o200, 0o100, 0o4000, 's') + bits(0o040, 0o020, 0o010, 0o2000, 's') + bits(0o004, 0o002, 0o001, 0o1000, 't')
}

/** Склонение: plural(3, 'файл', 'файла', 'файлов') → «файла». */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100
  const b = a % 10
  if (a > 10 && a < 20) return many
  if (b > 1 && b < 5) return few
  if (b === 1) return one
  return many
}

/** Время работы: «34 дн 5 ч», «5 ч 12 мин», «12 мин». */
export function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return h ? `${d} дн ${h} ч` : `${d} дн`
  if (h > 0) return m ? `${h} ч ${m} мин` : `${h} ч`
  return `${m} мин`
}

/** Скорость: «48 КБ/с»; null — ещё неизвестна. */
export function formatRate(bytesPerSecond: number | null): string {
  return bytesPerSecond === null ? '—' : `${formatSize(bytesPerSecond)}/с`
}

/** Число с запятой: formatDecimal(0.42) → «0,42». */
export function formatDecimal(n: number, digits = 2): string {
  return n.toFixed(digits).replace('.', ',')
}

/** Два объёма в одних единицах (по большему): «1,2 / 3,8 ГБ». */
export function formatPair(used: number, total: number): string {
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']
  let unit = 0
  let t = Math.max(total, 0)
  while (t >= 1024 && unit < units.length - 1) {
    t /= 1024
    unit++
  }
  const scale = 1024 ** unit
  const fmt = (v: number) => {
    const x = v / scale
    return unit === 0 || x >= 100 ? Math.round(x).toString() : x.toFixed(1).replace('.', ',')
  }
  return `${fmt(used)} / ${fmt(total)} ${units[unit]}`
}

/** Состояние контейнера Docker по-русски: «Up 3 days (healthy)» → «работает 3 дн · исправен». */
export function dockerStatus(status: string): { text: string; tone: 'ok' | 'warn' | 'off' } {
  const dur = (d: string) =>
    d
      .replace(/^About an? (hour|minute)$/i, (_m, u: string) => (u.toLowerCase() === 'hour' ? '≈1 ч' : '≈1 мин'))
      .replace(/^Less than a second$/i, '<1 с')
      .replace(/^(\d+) (second|minute|hour|day|week|month|year)s?$/i, (_m, n: string, u: string) => {
        const short: Record<string, string> = { second: 'с', minute: 'мин', hour: 'ч', day: 'дн', week: 'нед', month: 'мес', year: 'г' }
        return `${n} ${short[u.toLowerCase()]}`
      })
  const health = (h: string | undefined) => {
    if (!h) return ''
    if (/unhealthy/i.test(h)) return ' · неисправен'
    if (/healthy/i.test(h)) return ' · исправен'
    if (/starting/i.test(h)) return ' · проверяется'
    if (/paused/i.test(h)) return ' · на паузе'
    return ` · ${h}`
  }
  let m = /^Up (.+?)(?: \((.+)\))?$/i.exec(status)
  if (m) return { text: `работает ${dur(m[1])}${health(m[2])}`, tone: /unhealthy|paused/i.test(m[2] ?? '') ? 'warn' : 'ok' }
  m = /^Exited \((-?\d+)\) (.+) ago$/i.exec(status)
  if (m) return { text: `остановлен ${dur(m[2])} назад, код ${m[1]}`, tone: 'off' }
  m = /^Restarting \((-?\d+)\) (.+) ago$/i.exec(status)
  if (m) return { text: 'перезапускается', tone: 'warn' }
  if (/^Created$/i.test(status)) return { text: 'создан', tone: 'off' }
  return { text: status, tone: 'off' }
}
