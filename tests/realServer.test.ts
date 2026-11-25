// Проверка на настоящем сервере OpenSSH (по умолчанию пропускается).
// Запуск: TERMION_REAL_SSH=root@example.com[:22] npm test
// Используются ключи из ~/.ssh и только чтение ~/.ssh/known_hosts. Если ключ сервера
// не найден в known_hosts, тест не станет ему доверять и упадёт.
// На сервере: echo, чтение списка «/», сведения о сервере (только чтение: /proc, df, ip,
// docker ps) и временная папка /tmp/termion-test-*, которая удаляется в конце.
// На компьютере ничего не меняется.

import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import type { ConnState, NoticeLevel } from '../src/shared/types'
import { checkOpenSshKnownHosts } from '../src/main/ssh/opensshKnownHosts'
import { RemoteFs } from '../src/main/ssh/remoteFs'
import { ServerProbe } from '../src/main/ssh/serverStats'
import { SshSession } from '../src/main/ssh/session'

const target = process.env.TERMION_REAL_SSH ?? ''
const match = target.match(/^([^@]+)@([^:]+)(?::(\d+))?$/)

interface Live {
  ssh: SshSession
  output: () => string
  states: ConnState[]
  wait: (cond: () => boolean, what: string) => Promise<void>
}

async function connect(): Promise<Live> {
  const [, username, host, port] = match as RegExpMatchArray
  const home = homedir()
  const states: ConnState[] = []
  const notices: Array<[NoticeLevel, string]> = []
  let output = ''
  let ssh: SshSession | null = null
  ssh = new SshSession(
    'real',
    { type: 'session', id: 'real', name: 'real', host, port: Number(port ?? 22), username, auth: 'key', keyPath: '' },
    {
      secrets: {
        canStore: false,
        getPassword: () => null,
        setPassword: async () => undefined,
        getPassphrase: () => null,
        setPassphrase: async () => undefined
      },
      knownHosts: { lookup: () => [], remember: async () => undefined },
      checkOpenSsh: (h, p, t, k) => checkOpenSshKnownHosts(home, h, p, t, k),
      prompt: async (p) => {
        throw new Error(`неожиданный вопрос: ${p.kind}`)
      },
      events: {
        data: (chunk) => {
          output += chunk.toString('utf8')
          setImmediate(() => ssh?.ack(chunk.length))
        },
        state: (s) => states.push(s),
        notice: (l, t) => notices.push([l, t]),
        info: () => undefined
      },
      homeDir: home,
      findAgent: () => null
    },
    { cols: 120, rows: 30 }
  )
  const wait = async (cond: () => boolean, what: string) => {
    const start = Date.now()
    while (!cond()) {
      if (Date.now() - start > 20_000 || states.includes('failed')) {
        throw new Error(`${what}: ${notices.map(([, t]) => t).join(' | ')}`)
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  ssh.start()
  await wait(() => states.includes('connected'), 'подключение')
  expect(notices.map(([, t]) => t).join('\n')).toContain('known_hosts')
  return { ssh, output: () => output, states, wait }
}

describe.skipIf(!match)('настоящий сервер OpenSSH', () => {
  it('ключ сервера из ~/.ssh/known_hosts, вход по ключу, выполнение команды', async () => {
    const live = await connect()
    try {
      live.ssh.write('echo TERMION_$((40+2))\r')
      await live.wait(() => live.output().includes('TERMION_42'), 'выполнение команды')
      live.ssh.write('exit\r')
      await live.wait(() => live.states.includes('closed'), 'выход')
    } finally {
      live.ssh.dispose()
    }
  }, 40_000)

  it('сведения о сервере: настоящий Linux разбирается целиком', async () => {
    const live = await connect()
    const client = live.ssh.readyClient
    if (!client) throw new Error('нет подключения')
    try {
      const probe = new ServerProbe(client)
      const light = await probe.sample('light')
      expect(light.info.os).toBeTruthy()
      expect(light.info.kernel).toMatch(/^Linux /)
      expect(light.info.cores).toBeGreaterThan(0)
      expect(light.cpu).not.toBeNull()
      expect(light.cpu as number).toBeGreaterThanOrEqual(0)
      expect(light.mem?.total).toBeGreaterThan(256 * 1024 * 1024)
      expect(light.disks[0]?.mount).toBe('/')
      expect(light.net.length).toBeGreaterThan(0)
      expect(light.uptime).toBeGreaterThan(0)
      const full = await probe.sample('full')
      expect(full.processes).toBeGreaterThan(5)
      expect(full.top?.length).toBeGreaterThan(0)
      expect(full.top?.some((p) => p.name === 'sshd' || p.name.startsWith('sshd'))).toBe(true)
      expect(full.net.some((n) => n.addrs.length > 0)).toBe(true)
      const again = await probe.sample('full')
      expect(again.top?.every((p) => p.cpu !== null)).toBe(true)
    } finally {
      live.ssh.dispose()
    }
  }, 60_000)

  it('SFTP: список папок и атомарное сохранение (во временной папке /tmp)', async () => {
    const live = await connect()
    const client = live.ssh.readyClient
    if (!client) throw new Error('нет подключения')
    const fs = new RemoteFs(client)
    const dir = `/tmp/termion-test-${randomBytes(4).toString('hex')}`
    const file = `${dir}/app.conf`
    try {
      expect(await fs.home()).toMatch(/^\//)
      const root = await fs.list('/')
      expect(root.some((e) => e.name === 'etc' && e.type === 'dir')).toBe(true)

      await fs.mkdir(dir)
      await fs.createFile(file)
      // Права 600 должны пережить атомарное сохранение (временный файл + rename).
      const sftp = await fs.channel()
      await new Promise<void>((resolve, reject) => sftp.chmod(file, 0o600, (err) => (err ? reject(err) : resolve())))
      const opened = await fs.readText(file)
      if (!opened.ok) throw new Error('файл не открылся')

      const saved = await fs.writeText(file, 'line 1\nстрока 2\n', 'utf8', 'lf', opened.meta, false)
      expect(saved.ok).toBe(true)
      if (!saved.ok) return
      expect(saved.atomic).toBe(true) // OpenSSH умеет posix-rename@openssh.com
      expect(saved.meta.mode & 0o777).toBe(0o600)
      expect((await fs.list(dir)).map((e) => e.name)).toEqual(['app.conf']) // временных файлов не осталось

      const back = await fs.readText(file)
      expect(back.ok && back.text).toBe('line 1\nстрока 2\n')

      // Сохранение со старыми сведениями о файле — конфликт, файл не тронут.
      const stale = await fs.writeText(file, 'чужая версия\n', 'utf8', 'lf', opened.meta, false)
      expect(stale).toEqual({ ok: false, conflict: 'changed' })
      const still = await fs.readText(file)
      expect(still.ok && still.text).toBe('line 1\nстрока 2\n')

      // Windows-1251 и CRLF — туда и обратно.
      expect((await fs.writeText(file, 'Привет, мир\n', 'cp1251', 'crlf', null, true)).ok).toBe(true)
      const cp = await fs.readText(file)
      expect(cp.ok && [cp.text, cp.encoding, cp.eol]).toEqual(['Привет, мир\n', 'cp1251', 'crlf'])

      await fs.rename(file, `${dir}/renamed.conf`)
      expect((await fs.list(dir)).map((e) => e.name)).toEqual(['renamed.conf'])
    } finally {
      await fs.remove(dir).catch(() => undefined)
      const gone = await fs.stat(dir).then(
        () => false,
        () => true
      )
      fs.dispose()
      live.ssh.dispose()
      expect(gone).toBe(true)
    }
  }, 60_000)
})
