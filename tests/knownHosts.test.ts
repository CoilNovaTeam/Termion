import { execFileSync } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { describeHostKey, preferredHostKeyOrder } from '../src/main/ssh/hostkey'
import { checkKnownHosts, hostFieldMatches } from '../src/main/ssh/opensshKnownHosts'
import { generateKey } from './helpers/sshServer'

const key = generateKey()
const keyB64 = key.parsed.getPublicSSH().toString('base64')
const other = generateKey().parsed.getPublicSSH().toString('base64')

function hashed(host: string): string {
  const salt = randomBytes(20)
  return `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update(host).digest('base64')}`
}

describe('known_hosts OpenSSH', () => {
  it('сопоставляет хосты: списки, порты, шаблоны, отрицание, хеши', () => {
    expect(hostFieldMatches('example.com,10.0.0.1', 'example.com', 22)).toBe(true)
    expect(hostFieldMatches('example.com', 'example.com', 2222)).toBe(false)
    expect(hostFieldMatches('[example.com]:2222', 'example.com', 2222)).toBe(true)
    expect(hostFieldMatches('*.example.com', 'web.example.com', 22)).toBe(true)
    expect(hostFieldMatches('*.example.com,!db.example.com', 'db.example.com', 22)).toBe(false)
    expect(hostFieldMatches('10.0.0.?', '10.0.0.7', 22)).toBe(true)
    expect(hostFieldMatches('EXAMPLE.com', 'example.COM', 22)).toBe(true)
    expect(hostFieldMatches(hashed('example.com'), 'example.com', 22)).toBe(true)
    expect(hostFieldMatches(hashed('[example.com]:2222'), 'example.com', 2222)).toBe(true)
    expect(hostFieldMatches(hashed('example.com'), 'example.org', 22)).toBe(false)
  })

  it('совпадение, несовпадение, неизвестный и отозванный ключ', () => {
    const file = [
      '# комментарий',
      '',
      `example.com ssh-ed25519 ${keyB64} me@pc`,
      `changed.com ssh-ed25519 ${other}`,
      `rsa-only.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ`,
      `@revoked revoked.com ssh-ed25519 ${keyB64}`,
      `@cert-authority *.example.com ssh-ed25519 ${other}`
    ].join('\r\n')
    expect(checkKnownHosts(file, 'example.com', 22, 'ssh-ed25519', keyB64)).toEqual({ status: 'match' })
    expect(checkKnownHosts(file, 'changed.com', 22, 'ssh-ed25519', keyB64)).toMatchObject({ status: 'mismatch', keyType: 'ssh-ed25519' })
    // известен только ключ другого типа — это не подмена, а новый ключ
    expect(checkKnownHosts(file, 'rsa-only.com', 22, 'ssh-ed25519', keyB64)).toEqual({ status: 'unknown' })
    expect(checkKnownHosts(file, 'revoked.com', 22, 'ssh-ed25519', keyB64)).toEqual({ status: 'revoked' })
    expect(checkKnownHosts(file, 'nowhere.com', 22, 'ssh-ed25519', keyB64)).toEqual({ status: 'unknown' })
  })
})

describe('ключ сервера', () => {
  it('отпечаток совпадает с ssh-keygen', () => {
    const info = describeHostKey(key.parsed.getPublicSSH())
    expect(info.keyType).toBe('ssh-ed25519')
    expect(info.label).toBe('ED25519')
    const keygen = 'C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe'
    if (process.platform !== 'win32' || !existsSync(keygen)) return
    const dir = mkdtempSync(join(tmpdir(), 'termion-fp-'))
    try {
      const pub = join(dir, 'k.pub')
      writeFileSync(pub, `ssh-ed25519 ${keyB64} test\n`)
      const out = execFileSync(keygen, ['-l', '-E', 'sha256', '-f', pub], { encoding: 'utf8' })
      expect(out.split(' ')[1]).toBe(info.fingerprint)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ставит известные типы ключей первыми', () => {
    expect(preferredHostKeyOrder([])).toBeNull()
    expect(preferredHostKeyOrder(['ssh-rsa'])?.slice(0, 4)).toEqual(['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa', 'ssh-ed25519'])
    const order = preferredHostKeyOrder(['ecdsa-sha2-nistp256']) ?? []
    expect(order[0]).toBe('ecdsa-sha2-nistp256')
    expect(new Set(order).size).toBe(order.length)
  })
})
