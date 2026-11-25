// Интеграционные тесты SSH-сессии с настоящим SSH-сервером на 127.0.0.1.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { ConnInfo, ConnState, NoticeLevel, PromptPayload, PromptResponse, SessionNode } from '../src/shared/types'
import { FLOW_HIGH_WATER, SshSession, type SshDeps, type SshKnownHosts, type SshSecrets } from '../src/main/ssh/session'
import type { KnownKey } from '../src/main/store/knownHosts'
import { TEST_USER, generateKey, startTestServer, type TestServer } from './helpers/sshServer'

const PASSWORD = 'correct horse'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class MemorySecrets implements SshSecrets {
  canStore = true
  passwords = new Map<string, string>()
  passphrases = new Map<string, string>()
  getPassword(id: string) {
    return this.passwords.get(id) ?? null
  }
  async setPassword(id: string, value: string | null) {
    if (value === null) this.passwords.delete(id)
    else this.passwords.set(id, value)
  }
  getPassphrase(path: string) {
    return this.passphrases.get(path) ?? null
  }
  async setPassphrase(path: string, value: string | null) {
    if (value === null) this.passphrases.delete(path)
    else this.passphrases.set(path, value)
  }
}

class MemoryKnownHosts implements SshKnownHosts {
  map = new Map<string, KnownKey[]>()
  lookup(host: string, port: number) {
    return this.map.get(`${host}:${port}`) ?? []
  }
  async remember(host: string, port: number, entry: Omit<KnownKey, 'addedAt'>) {
    const others = this.lookup(host, port).filter((k) => k.keyType !== entry.keyType)
    this.map.set(`${host}:${port}`, [...others, { ...entry, addedAt: 'test' }])
  }
}

type Answer = (p: PromptPayload) => PromptResponse | Promise<PromptResponse>

const acceptAll: Answer = (p) => {
  if (p.kind === 'hostkey-new' || p.kind === 'hostkey-changed') return { kind: 'hostkey', accept: true }
  if (p.kind === 'password') return { kind: 'secret', value: PASSWORD, save: true }
  if (p.kind === 'keyboard-interactive') return { kind: 'answers', values: p.fields.map(() => PASSWORD) }
  return { kind: 'secret', value: null, save: false }
}

interface Harness {
  ssh: SshSession
  states: ConnState[]
  notices: Array<[NoticeLevel, string]>
  prompts: PromptPayload[]
  info: ConnInfo | null
  bytes: number
  /** Последние килобайты вывода (дёшево проверять при большом потоке). */
  tail: string
  output(): string
}

const tempDirs: string[] = []
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'termion-home-'))
  tempDirs.push(dir)
  mkdirSync(join(dir, '.ssh'))
  return dir
}

const servers: TestServer[] = []
const sessions: SshSession[] = []

async function server(opts: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const s = await startTestServer({ password: PASSWORD, ...opts })
  servers.push(s)
  return s
}

function harness(
  srv: { port: number },
  session: Partial<SessionNode> = {},
  opts: {
    secrets?: MemorySecrets
    knownHosts?: MemoryKnownHosts
    answer?: Answer
    autoAck?: boolean
    home?: string
    timeouts?: Partial<SshDeps['timeouts']>
    checkOpenSsh?: SshDeps['checkOpenSsh']
  } = {}
): Harness {
  const chunks: Buffer[] = []
  const answer = opts.answer ?? acceptAll
  const h = { states: [], notices: [], prompts: [], info: null, bytes: 0, tail: '' } as unknown as Harness
  const deps: SshDeps = {
    secrets: opts.secrets ?? new MemorySecrets(),
    knownHosts: opts.knownHosts ?? new MemoryKnownHosts(),
    checkOpenSsh: opts.checkOpenSsh ?? (async () => ({ status: 'unknown' })),
    prompt: async (p) => {
      h.prompts.push(p)
      return answer(p)
    },
    events: {
      data: (chunk) => {
        chunks.push(Buffer.from(chunk))
        h.bytes += chunk.length
        h.tail = (h.tail + chunk.subarray(-4096).toString('latin1')).slice(-4096)
        if (opts.autoAck !== false) setImmediate(() => h.ssh.ack(chunk.length))
      },
      state: (s) => h.states.push(s),
      notice: (level, text) => h.notices.push([level, text]),
      info: (info) => {
        h.info = info
      }
    },
    homeDir: opts.home ?? tempHome(),
    findAgent: () => null,
    timeouts: { connect: 3000, handshake: 8000, ...opts.timeouts }
  }
  const full: SessionNode = {
    type: 'session',
    id: 'sess1',
    name: 'test',
    host: '127.0.0.1',
    port: srv.port,
    username: TEST_USER,
    auth: 'password',
    keyPath: '',
    ...session
  }
  h.ssh = new SshSession('conn1', full, deps, { cols: 100, rows: 30 })
  h.output = () => Buffer.concat(chunks).toString('utf8')
  sessions.push(h.ssh)
  return h
}

async function waitFor(cond: () => boolean, what: string, timeout = 8000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error(`Не дождались: ${what}`)
    await sleep(15)
  }
}

const noticeText = (h: Harness, level?: NoticeLevel) =>
  h.notices
    .filter(([l]) => !level || l === level)
    .map(([, t]) => t)
    .join('\n')

afterEach(async () => {
  for (const s of sessions.splice(0)) s.dispose()
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
})

describe('SshSession', () => {
  it('подключается по паролю: новый ключ сервера, сохранение пароля, оболочка и изменение размера', async () => {
    const srv = await server()
    const secrets = new MemorySecrets()
    const known = new MemoryKnownHosts()
    const h = harness(srv, {}, { secrets, knownHosts: known })
    h.ssh.start()

    await waitFor(() => h.states.includes('connected'), 'подключение')
    expect(h.states).toEqual(['connecting', 'authenticating', 'connected'])
    expect(h.prompts.map((p) => p.kind)).toEqual(['hostkey-new', 'password'])
    const hostPrompt = h.prompts[0] as Extract<PromptPayload, { kind: 'hostkey-new' }>
    expect(hostPrompt.keyType).toBe('ED25519')
    expect(hostPrompt.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
    expect(known.lookup('127.0.0.1', srv.port)[0].key).toBe(srv.hostKeyBase64)
    await waitFor(() => secrets.passwords.get('sess1') === PASSWORD, 'сохранение пароля')
    expect(h.info).toMatchObject({ hostKeyType: 'ED25519', authMethod: 'пароль' })

    await waitFor(() => h.output().includes(`${TEST_USER}@test:~$`), 'приглашение оболочки')
    expect(srv.sizes[0]).toEqual({ cols: 100, rows: 30 })

    h.ssh.write('hello world\r')
    await waitFor(() => h.output().includes('echo: hello world'), 'эхо команды')

    h.ssh.resize(132, 43)
    await waitFor(() => srv.sizes.some((s) => s.cols === 132 && s.rows === 43), 'изменение размера')

    h.ssh.write('exit\r')
    await waitFor(() => h.states.includes('closed'), 'закрытие')
    expect(noticeText(h)).toContain('Соединение закрыто')

    // Повторное подключение: ключ сервера и пароль уже известны — никаких вопросов.
    const again = harness(srv, {}, {
      secrets,
      knownHosts: known,
      answer: () => {
        throw new Error('не должно быть вопросов')
      }
    })
    again.ssh.start()
    await waitFor(() => again.states.includes('connected'), 'повторное подключение')
    expect(again.prompts).toHaveLength(0)
  })

  it('если сохранённый пароль не подошёл — предупреждает и спрашивает заново', async () => {
    const srv = await server()
    const secrets = new MemorySecrets()
    secrets.passwords.set('sess1', 'old password')
    const h = harness(srv, {}, { secrets })
    h.ssh.start()
    await waitFor(() => h.states.includes('connected'), 'подключение')
    const pw = h.prompts.find((p) => p.kind === 'password') as Extract<PromptPayload, { kind: 'password' }>
    expect(pw.retry).toBe(true)
    expect(noticeText(h, 'warn')).toContain('Сохранённый пароль не подошёл')
    await waitFor(() => secrets.passwords.get('sess1') === PASSWORD, 'замена пароля')
  })

  it('после трёх неверных паролей прекращает попытки', async () => {
    const srv = await server()
    const h = harness(srv, {}, {
      answer: (p) => (p.kind === 'password' ? { kind: 'secret', value: 'nope', save: true } : acceptAll(p))
    })
    h.ssh.start()
    await waitFor(() => h.states.includes('failed'), 'отказ')
    expect(h.prompts.filter((p) => p.kind === 'password')).toHaveLength(3)
    expect(noticeText(h, 'error')).toContain('три раза')
  })

  it('отмена ввода пароля завершает подключение', async () => {
    const srv = await server()
    const h = harness(srv, {}, {
      answer: (p) => (p.kind === 'password' ? { kind: 'secret', value: null, save: false } : acceptAll(p))
    })
    h.ssh.start()
    await waitFor(() => h.states.includes('failed'), 'отказ')
    expect(noticeText(h, 'error')).toBe('Вход отменён.')
  })

  it('изменившийся ключ сервера: отказ пользователя обрывает подключение', async () => {
    const srv = await server()
    const known = new MemoryKnownHosts()
    const other = generateKey().parsed.getPublicSSH().toString('base64')
    await known.remember('127.0.0.1', srv.port, { keyType: 'ssh-ed25519', key: other, fingerprint: 'SHA256:old' })
    const h = harness(srv, {}, {
      knownHosts: known,
      answer: (p) => (p.kind === 'hostkey-changed' ? { kind: 'hostkey', accept: false } : acceptAll(p))
    })
    h.ssh.start()
    await waitFor(() => h.states.includes('failed'), 'отказ')
    const prompt = h.prompts[0] as Extract<PromptPayload, { kind: 'hostkey-changed' }>
    expect(prompt.kind).toBe('hostkey-changed')
    expect(prompt.knownFingerprint).toBe('SHA256:old')
    expect(noticeText(h, 'error')).toContain('ключ сервера изменился')
    expect(known.lookup('127.0.0.1', srv.port)[0].key).toBe(other)
  })

  it('изменившийся ключ сервера: после согласия ключ заменяется', async () => {
    const srv = await server()
    const known = new MemoryKnownHosts()
    await known.remember('127.0.0.1', srv.port, {
      keyType: 'ssh-ed25519',
      key: generateKey().parsed.getPublicSSH().toString('base64'),
      fingerprint: 'SHA256:old'
    })
    const h = harness(srv, {}, { knownHosts: known })
    h.ssh.start()
    await waitFor(() => h.states.includes('connected'), 'подключение')
    expect(known.lookup('127.0.0.1', srv.port)[0].key).toBe(srv.hostKeyBase64)
  })

  it('ключ из ~/.ssh/known_hosts OpenSSH принимается без вопроса', async () => {
    const srv = await server()
    const known = new MemoryKnownHosts()
    const h = harness(srv, {}, { knownHosts: known, checkOpenSsh: async () => ({ status: 'match' }) })
    h.ssh.start()
    await waitFor(() => h.states.includes('connected'), 'подключение')
    expect(h.prompts.map((p) => p.kind)).toEqual(['password'])
    expect(known.lookup('127.0.0.1', srv.port)).toHaveLength(1)
  })

  it('входит по ключу с фразой-паролем и сохраняет фразу после успешного входа', async () => {
    const key = generateKey('pass phrase')
    const srv = await server({ clientKeys: [key.parsed], methods: ['publickey'] })
    const home = tempHome()
    writeFileSync(join(home, '.ssh', 'id_ed25519'), key.private)
    const secrets = new MemorySecrets()
    let attempt = 0
    const h = harness(srv, { auth: 'key' }, {
      home,
      secrets,
      answer: (p) => {
        if (p.kind !== 'passphrase') return acceptAll(p)
        attempt++
        return { kind: 'secret', value: attempt === 1 ? 'wrong' : 'pass phrase', save: true }
      }
    })
    h.ssh.start()
    await waitFor(() => h.states.includes('connected'), 'подключение')
    const asked = h.prompts.filter((p) => p.kind === 'passphrase') as Extract<PromptPayload, { kind: 'passphrase' }>[]
    expect(asked.map((p) => p.retry)).toEqual([false, true])
    expect(h.info?.authMethod).toContain('id_ed25519')
    await waitFor(() => secrets.passphrases.size === 1, 'сохранение фразы-пароля')
    expect([...secrets.passphrases.values()]).toEqual(['pass phrase'])
  })

  it('если ключ не подошёл, предлагает войти по паролю', async () => {
    const key = generateKey()
    const srv = await server()
    const home = tempHome()
    writeFileSync(join(home, '.ssh', 'id_ed25519'), key.private)
    const h = harness(srv, { auth: 'key' }, { home })
    h.ssh.start()
    await waitFor(() => h.states.includes('connected'), 'подключение')
    expect(noticeText(h, 'warn')).toContain('не подошёл')
    expect(h.prompts.map((p) => p.kind)).toEqual(['hostkey-new', 'password'])
  })

  it('keyboard-interactive: использует сохранённый пароль', async () => {
    const srv = await server({ methods: ['keyboard-interactive'] })
    const secrets = new MemorySecrets()
    secrets.passwords.set('sess1', PASSWORD)
    const h = harness(srv, {}, { secrets })
    h.ssh.start()
    await waitFor(() => h.states.includes('connected'), 'подключение')
    expect(h.prompts.map((p) => p.kind)).toEqual(['hostkey-new'])
  })

  it('сообщает, что сервер не принимает вход по паролю', async () => {
    const srv = await server({ methods: ['publickey'] })
    const h = harness(srv)
    h.ssh.start()
    await waitFor(() => h.states.includes('failed'), 'отказ')
    expect(noticeText(h, 'error')).toContain('не принимает вход по паролю')
  })

  it('понятная ошибка, если порт закрыт', async () => {
    const probe = net.createServer()
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()))
    const port = (probe.address() as net.AddressInfo).port
    await new Promise<void>((r) => probe.close(() => r()))
    const h = harness({ port })
    h.ssh.start()
    await waitFor(() => h.states.includes('failed'), 'отказ')
    expect(noticeText(h, 'error')).toContain('отклонил подключение')
  })

  it('обрывает подключение, если сервер молчит после TCP', async () => {
    const silent = net.createServer(() => undefined)
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()))
    const port = (silent.address() as net.AddressInfo).port
    try {
      const h = harness({ port }, {}, { timeouts: { handshake: 300 } })
      h.ssh.start()
      await waitFor(() => h.states.includes('failed'), 'таймаут', 3000)
      expect(noticeText(h, 'error')).toContain('не завершил SSH-рукопожатие')
    } finally {
      silent.close()
    }
  })

  it('таймер рукопожатия не срабатывает, пока пользователь думает над вопросом', async () => {
    const srv = await server()
    const h = harness(srv, {}, {
      timeouts: { handshake: 300 },
      answer: async (p) => {
        await sleep(800)
        return acceptAll(p)
      }
    })
    h.ssh.start()
    await waitFor(() => h.states.includes('connected'), 'подключение', 6000)
    expect(h.states).not.toContain('failed')
  })

  it('flow control: без подтверждений поток приостанавливается, после — доходит целиком', async () => {
    const srv = await server()
    const secrets = new MemorySecrets()
    secrets.passwords.set('sess1', PASSWORD)
    const h = harness(srv, {}, { secrets, autoAck: false })
    h.ssh.start()
    await waitFor(() => h.tail.includes('$ '), 'приглашение')
    h.ssh.ack(h.bytes)

    const total = 6 * 1024 * 1024
    const before = h.bytes
    h.ssh.write(`flood ${total}\r`)
    await sleep(1500)
    const delivered = h.bytes - before
    expect(delivered).toBeGreaterThan(FLOW_HIGH_WATER / 2)
    expect(delivered).toBeLessThan(FLOW_HIGH_WATER * 2)

    // Окно «отрисовало» данные — поток продолжается до конца.
    let acked = 0
    const timer = setInterval(() => {
      h.ssh.ack(h.bytes - acked)
      acked = h.bytes
    }, 10)
    try {
      await waitFor(() => h.tail.includes('FLOOD-DONE'), 'конец потока', 15000)
    } finally {
      clearInterval(timer)
    }
    expect(h.bytes - before).toBeGreaterThanOrEqual(total)
  })
})
