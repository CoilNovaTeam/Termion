// Пароли сессий и фразы-пароли ключей. Значения хранятся только в зашифрованном виде.
// В программе шифрует Electron safeStorage (защищённое хранилище Windows, DPAPI),
// поэтому файл secrets.json бесполезен на другом компьютере или под другим пользователем.

import { join, resolve } from 'node:path'
import type { SecretStatus } from '@shared/types'
import { JsonFile, type LoadResult } from './jsonFile'

export interface Cipher {
  available(): boolean
  encrypt(plain: string): string
  decrypt(encrypted: string): string
}

interface SecretsData {
  version: 1
  sessions: Record<string, { password: string }>
  keys: Record<string, { passphrase: string }>
}

const empty = (): SecretsData => ({ version: 1, sessions: {}, keys: {} })

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function parseSecrets(raw: unknown): { value: SecretsData; issues: string[] } {
  if (!isRecord(raw)) throw new Error('Файл паролей повреждён')
  const value = empty()
  if (isRecord(raw.sessions)) {
    for (const [id, entry] of Object.entries(raw.sessions)) {
      if (isRecord(entry) && typeof entry.password === 'string') value.sessions[id] = { password: entry.password }
    }
  }
  if (isRecord(raw.keys)) {
    for (const [path, entry] of Object.entries(raw.keys)) {
      if (isRecord(entry) && typeof entry.passphrase === 'string') value.keys[path] = { passphrase: entry.passphrase }
    }
  }
  return { value, issues: [] }
}

/** Ключ для фразы-пароля: полный путь к файлу ключа без учёта регистра в Windows. */
export function keyPathId(path: string): string {
  const full = resolve(path)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

export class SecretsStore {
  private readonly file: JsonFile<SecretsData>
  private data: SecretsData = empty()

  constructor(
    dir: string,
    private readonly cipher: Cipher,
    private readonly onWarning: (message: string) => void = () => undefined
  ) {
    this.file = new JsonFile<SecretsData>(join(dir, 'secrets.json'), parseSecrets, empty)
  }

  async load(): Promise<LoadResult<SecretsData>> {
    const result = await this.file.load()
    this.data = result.data
    return result
  }

  get canStore(): boolean {
    try {
      return this.cipher.available()
    } catch {
      return false
    }
  }

  status(sessionId: string): SecretStatus {
    return { hasPassword: !!this.data.sessions[sessionId], canStore: this.canStore }
  }

  getPassword(sessionId: string): string | null {
    return this.decrypt(this.data.sessions[sessionId]?.password, `пароль сессии ${sessionId}`)
  }

  async setPassword(sessionId: string, password: string | null): Promise<void> {
    if (password === null) {
      if (!this.data.sessions[sessionId]) return
      delete this.data.sessions[sessionId]
    } else {
      this.data.sessions[sessionId] = { password: this.encrypt(password) }
    }
    await this.file.save(this.data)
  }

  getPassphrase(keyPath: string): string | null {
    return this.decrypt(this.data.keys[keyPathId(keyPath)]?.passphrase, 'фраза-пароль ключа')
  }

  async setPassphrase(keyPath: string, passphrase: string | null): Promise<void> {
    const id = keyPathId(keyPath)
    if (passphrase === null) {
      if (!this.data.keys[id]) return
      delete this.data.keys[id]
    } else {
      this.data.keys[id] = { passphrase: this.encrypt(passphrase) }
    }
    await this.file.save(this.data)
  }

  /** Удаляет пароли сессий, которых больше нет в списке. */
  async pruneSessions(existing: ReadonlySet<string>): Promise<void> {
    let changed = false
    for (const id of Object.keys(this.data.sessions)) {
      if (!existing.has(id)) {
        delete this.data.sessions[id]
        changed = true
      }
    }
    if (changed) await this.file.save(this.data)
  }

  flush(): Promise<void> {
    return this.file.flush()
  }

  private encrypt(plain: string): string {
    if (!this.canStore) throw new Error('Шифрование Windows недоступно — пароль нельзя сохранить')
    return this.cipher.encrypt(plain)
  }

  private decrypt(encrypted: string | undefined, what: string): string | null {
    if (!encrypted) return null
    try {
      return this.cipher.decrypt(encrypted)
    } catch {
      // Например, файл перенесли с другого компьютера: такой пароль просто спросим заново.
      this.onWarning(`Не удалось расшифровать ${what}`)
      return null
    }
  }
}
