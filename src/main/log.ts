// Простой журнал главного процесса: %APPDATA%\Termion\logs\main.log (ротация по размеру).
// В журнал никогда не пишутся пароли и содержимое терминала.

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_SIZE = 1024 * 1024

let logFile: string | null = null

export function initLog(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true })
    logFile = join(dir, 'main.log')
    try {
      if (statSync(logFile).size > MAX_SIZE) renameSync(logFile, join(dir, 'main.old.log'))
    } catch {
      // файла ещё нет
    }
  } catch {
    logFile = null
  }
}

function write(level: string, msg: string, err?: unknown): void {
  const detail = err instanceof Error ? ` | ${err.name}: ${err.message}` : err !== undefined ? ` | ${String(err)}` : ''
  const line = `${new Date().toISOString()} ${level} ${msg}${detail}\n`
  if (level === 'ERROR') console.error(line.trimEnd())
  else if (process.env.ELECTRON_RENDERER_URL) console.log(line.trimEnd())
  if (!logFile) return
  try {
    appendFileSync(logFile, line, 'utf8')
  } catch {
    // журнал не должен ронять приложение
  }
}

export const log = {
  info: (msg: string) => write('INFO', msg),
  warn: (msg: string, err?: unknown) => write('WARN', msg, err),
  error: (msg: string, err?: unknown) => write('ERROR', msg, err)
}
