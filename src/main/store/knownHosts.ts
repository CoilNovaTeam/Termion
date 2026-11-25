// Ключи серверов, которым пользователь доверяет (аналог ~/.ssh/known_hosts).

import { join } from 'node:path'
import { JsonFile, type LoadResult } from './jsonFile'

export interface KnownKey {
  /** Тип ключа в формате SSH: ssh-ed25519, ecdsa-sha2-nistp256, ssh-rsa… */
  keyType: string
  /** Открытый ключ сервера (base64). */
  key: string
  fingerprint: string
  addedAt: string
}

interface KnownHostsData {
  version: 1
  hosts: Record<string, KnownKey[]>
}

const empty = (): KnownHostsData => ({ version: 1, hosts: {} })

/** [host]:port — однозначная запись и для IPv6-адресов. */
export const hostId = (host: string, port: number) => `[${host.toLowerCase()}]:${port}`

function parseKnownHosts(raw: unknown): { value: KnownHostsData; issues: string[] } {
  if (typeof raw !== 'object' || raw === null) throw new Error('Файл известных серверов повреждён')
  const value = empty()
  const hosts = (raw as { hosts?: unknown }).hosts
  if (typeof hosts === 'object' && hosts !== null) {
    for (const [id, list] of Object.entries(hosts)) {
      if (!Array.isArray(list)) continue
      const keys = list.filter(
        (k): k is KnownKey =>
          typeof k === 'object' &&
          k !== null &&
          typeof k.keyType === 'string' &&
          typeof k.key === 'string' &&
          typeof k.fingerprint === 'string'
      )
      if (keys.length) value.hosts[id] = keys.map((k) => ({ ...k, addedAt: typeof k.addedAt === 'string' ? k.addedAt : '' }))
    }
  }
  return { value, issues: [] }
}

export class KnownHostsStore {
  private readonly file: JsonFile<KnownHostsData>
  private data: KnownHostsData = empty()

  constructor(dir: string) {
    this.file = new JsonFile<KnownHostsData>(join(dir, 'known_hosts.json'), parseKnownHosts, empty)
  }

  async load(): Promise<LoadResult<KnownHostsData>> {
    const result = await this.file.load()
    this.data = result.data
    return result
  }

  lookup(host: string, port: number): KnownKey[] {
    return this.data.hosts[hostId(host, port)] ?? []
  }

  /** Запоминает ключ. Ключ того же типа заменяется (после явного согласия пользователя). */
  async remember(host: string, port: number, entry: Omit<KnownKey, 'addedAt'>): Promise<void> {
    const id = hostId(host, port)
    const others = (this.data.hosts[id] ?? []).filter((k) => k.keyType !== entry.keyType)
    this.data.hosts[id] = [...others, { ...entry, addedAt: new Date().toISOString() }]
    await this.file.save(this.data)
  }

  flush(): Promise<void> {
    return this.file.flush()
  }
}
