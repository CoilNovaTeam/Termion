// Приватные ключи: поиск стандартных ключей и разбор с фразой-паролем.
// Поддерживаются форматы OpenSSH (новый и PEM) и PuTTY (.ppk).

import { join } from 'node:path'
import { utils, type ParsedKey } from 'ssh2'

export function expandHome(path: string, homeDir: string): string {
  if (path === '~') return homeDir
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homeDir, path.slice(2))
  return path
}

export function defaultKeyPaths(homeDir: string): string[] {
  return ['id_ed25519', 'id_ecdsa', 'id_rsa'].map((name) => join(homeDir, '.ssh', name))
}

/** Короткая запись пути для сообщений: C:\Users\me\.ssh\id_ed25519 → ~\.ssh\id_ed25519 */
export function displayPath(path: string, homeDir: string): string {
  return path.toLowerCase().startsWith(homeDir.toLowerCase()) ? '~' + path.slice(homeDir.length) : path
}

export type KeyParseResult =
  | { ok: true; key: ParsedKey }
  | { ok: false; reason: 'encrypted' | 'bad-passphrase' | 'public' | 'invalid'; message: string }

export function parsePrivateKey(data: Buffer, passphrase?: string): KeyParseResult {
  let parsed: ParsedKey | ParsedKey[] | Error
  try {
    parsed = utils.parseKey(data, passphrase)
  } catch (err) {
    parsed = err instanceof Error ? err : new Error(String(err))
  }
  if (parsed instanceof Error) {
    const message = parsed.message
    if (/no passphrase given/i.test(message)) return { ok: false, reason: 'encrypted', message }
    if (/bad passphrase/i.test(message)) return { ok: false, reason: 'bad-passphrase', message }
    return { ok: false, reason: 'invalid', message }
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed
  if (!key) return { ok: false, reason: 'invalid', message: 'Файл не содержит ключа' }
  if (!key.isPrivateKey()) return { ok: false, reason: 'public', message: 'Это открытый ключ' }
  return { ok: true, key }
}

export function describeKeyProblem(result: Exclude<KeyParseResult, { ok: true }>): string {
  switch (result.reason) {
    case 'public':
      return 'это открытый ключ (.pub), а нужен приватный'
    case 'encrypted':
      return 'ключ защищён фразой-паролем'
    case 'bad-passphrase':
      return 'неверная фраза-пароль'
    default:
      return 'файл не похож на приватный ключ SSH'
  }
}
