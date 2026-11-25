// Разбор открытого ключа сервера (формат SSH wire) и отпечаток как у OpenSSH: SHA256:…

import { createHash } from 'node:crypto'

export interface HostKeyInfo {
  /** Тип ключа: ssh-ed25519, ecdsa-sha2-nistp256, ssh-rsa… */
  keyType: string
  /** Человекочитаемое название: ED25519, ECDSA P-256, RSA 4096… */
  label: string
  fingerprint: string
  /** Ключ целиком в base64, как в known_hosts. */
  base64: string
}

function readString(buf: Buffer, offset: number): { value: Buffer; next: number } | null {
  if (offset + 4 > buf.length) return null
  const len = buf.readUInt32BE(offset)
  const start = offset + 4
  if (start + len > buf.length) return null
  return { value: buf.subarray(start, start + len), next: start + len }
}

export function fingerprintOf(blob: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
}

function rsaBits(blob: Buffer): number | null {
  const type = readString(blob, 0)
  const exponent = type && readString(blob, type.next)
  const modulus = exponent && readString(blob, exponent.next)
  if (!modulus) return null
  let n = modulus.value
  let i = 0
  while (i < n.length && n[i] === 0) i++
  n = n.subarray(i)
  if (!n.length) return null
  return (n.length - 1) * 8 + (32 - Math.clz32(n[0]))
}

export function keyTypeLabel(keyType: string, blob?: Buffer): string {
  switch (keyType) {
    case 'ssh-ed25519':
      return 'ED25519'
    case 'ssh-ed448':
      return 'ED448'
    case 'ecdsa-sha2-nistp256':
      return 'ECDSA P-256'
    case 'ecdsa-sha2-nistp384':
      return 'ECDSA P-384'
    case 'ecdsa-sha2-nistp521':
      return 'ECDSA P-521'
    case 'ssh-dss':
      return 'DSA'
    case 'ssh-rsa': {
      const bits = blob ? rsaBits(blob) : null
      return bits ? `RSA ${bits}` : 'RSA'
    }
    default:
      return keyType
  }
}

export function describeHostKey(blob: Buffer): HostKeyInfo {
  const type = readString(blob, 0)
  const keyType = type ? type.value.toString('latin1') : 'unknown'
  return {
    keyType,
    label: keyTypeLabel(keyType, blob),
    fingerprint: fingerprintOf(blob),
    base64: blob.toString('base64')
  }
}

const HOST_KEY_ALGOS: Record<string, string[]> = {
  'ssh-ed25519': ['ssh-ed25519'],
  'ecdsa-sha2-nistp256': ['ecdsa-sha2-nistp256'],
  'ecdsa-sha2-nistp384': ['ecdsa-sha2-nistp384'],
  'ecdsa-sha2-nistp521': ['ecdsa-sha2-nistp521'],
  'ssh-rsa': ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa']
}

const DEFAULT_ORDER = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
  'ssh-rsa'
]

/**
 * Порядок алгоритмов ключа сервера: сначала те типы, ключи которых уже известны.
 * Так сервер предъявит именно сохранённый ключ, и пользователь не увидит лишний вопрос
 * (так же поступает OpenSSH). Возвращает null, если подстраивать порядок не нужно.
 */
export function preferredHostKeyOrder(knownTypes: string[]): string[] | null {
  const first = knownTypes.flatMap((t) => HOST_KEY_ALGOS[t] ?? [])
  if (!first.length) return null
  const order = [...new Set([...first, ...DEFAULT_ORDER])]
  return order
}
