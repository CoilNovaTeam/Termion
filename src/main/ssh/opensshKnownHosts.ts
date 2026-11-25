// Чтение ~/.ssh/known_hosts от OpenSSH (только чтение, файл не изменяется).
// Если сервер уже известен системному ssh, Termion не задаёт лишних вопросов,
// а при несовпадении ключа предупреждает так же, как OpenSSH.
// Поддерживаются: списки хостов через запятую, [host]:port, шаблоны * и ?, отрицание !,
// хешированные записи |1|соль|хеш, маркеры @revoked и @cert-authority.

import { createHmac } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { fingerprintOf } from './hostkey'

export type OpenSshVerdict =
  | { status: 'match' }
  | { status: 'mismatch'; keyType: string; fingerprint: string }
  | { status: 'revoked' }
  | { status: 'unknown' }

const hostToken = (host: string, port: number) => (port === 22 ? host.toLowerCase() : `[${host.toLowerCase()}]:${port}`)

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

function hashedMatches(entry: string, token: string): boolean {
  // |1|base64(salt)|base64(hmac-sha1(salt, host))
  const parts = entry.split('|')
  if (parts.length !== 4 || parts[1] !== '1') return false
  try {
    const salt = Buffer.from(parts[2], 'base64')
    const expected = createHmac('sha1', salt).update(token).digest('base64')
    return expected === parts[3]
  } catch {
    return false
  }
}

/** Совпадает ли поле хостов строки known_hosts с нашим сервером. */
export function hostFieldMatches(field: string, host: string, port: number): boolean {
  const token = hostToken(host, port)
  if (field.startsWith('|')) return hashedMatches(field, token)
  let matched = false
  for (const raw of field.split(',')) {
    if (!raw) continue
    const negated = raw.startsWith('!')
    const pattern = negated ? raw.slice(1) : raw
    if (globToRegExp(pattern).test(token)) {
      if (negated) return false
      matched = true
    }
  }
  return matched
}

/** Проверяет ключ сервера по содержимому файла known_hosts. */
export function checkKnownHosts(content: string, host: string, port: number, keyType: string, keyBase64: string): OpenSshVerdict {
  let mismatch: OpenSshVerdict | null = null
  let matched = false
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const fields = line.split(/\s+/)
    let marker: string | null = null
    if (fields[0].startsWith('@')) marker = fields.shift() ?? null
    if (fields.length < 3) continue
    const [hosts, type, key] = fields
    if (marker === '@cert-authority') continue
    if (!hostFieldMatches(hosts, host, port)) continue
    if (marker === '@revoked') {
      if (key === keyBase64) return { status: 'revoked' }
      continue
    }
    if (type !== keyType) continue
    if (key === keyBase64) matched = true
    else if (!mismatch) {
      let fingerprint = ''
      try {
        fingerprint = fingerprintOf(Buffer.from(key, 'base64'))
      } catch {
        fingerprint = '(не удалось прочитать)'
      }
      mismatch = { status: 'mismatch', keyType: type, fingerprint }
    }
  }
  if (matched) return { status: 'match' }
  return mismatch ?? { status: 'unknown' }
}

export async function checkOpenSshKnownHosts(
  homeDir: string,
  host: string,
  port: number,
  keyType: string,
  keyBase64: string
): Promise<OpenSshVerdict> {
  let content: string
  try {
    content = await fs.readFile(join(homeDir, '.ssh', 'known_hosts'), 'utf8')
  } catch {
    return { status: 'unknown' }
  }
  return checkKnownHosts(content, host, port, keyType, keyBase64)
}
