// Локальный SSH-сервер для тестов (на базе ssh2.Server). Слушает 127.0.0.1 на свободном порту.
// Умеет: вход по паролю/ключу/keyboard-interactive, простую оболочку и SFTP поверх настоящей
// временной папки на диске (её корень — «/» сервера, домашняя папка — /home/tester).

import { timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import { join, posix } from 'node:path'
import ssh2 from 'ssh2'
import type { Attributes, Connection, ParsedKey, ServerChannel, SFTPWrapper } from 'ssh2'

// ssh2 — CommonJS-пакет; так модуль работает и в vitest, и в node (scripts/e2e.mjs).
const { Server, utils } = ssh2
const { STATUS_CODE, flagsToString } = utils.sftp

export const TEST_USER = 'tester'
export const TEST_HOME = '/home/tester'

export interface TestServerOptions {
  /** Пароль, который принимает сервер (для password и keyboard-interactive). */
  password?: string
  /** Открытые ключи клиентов, которым разрешён вход. */
  clientKeys?: ParsedKey[]
  /** Какие способы входа сервер объявляет. По умолчанию: publickey, password. */
  methods?: Array<'password' | 'publickey' | 'keyboard-interactive'>
  /** Приватный ключ сервера (OpenSSH). По умолчанию генерируется ed25519. */
  hostKey?: string
  /** Папка на диске, которая станет файловой системой сервера (включает SFTP). */
  sftpRoot?: string
  /** Владелец (uid) файлов по пути; по умолчанию 0. Новые файлы всегда получают uid 0. */
  ownerOf?: (path: string) => number
  /** Сколько имён отдавать за один ответ READDIR (OpenSSH — около 100). Infinity — все сразу. */
  readdirBatch?: number
  /** Отказывать в выполнении команд (как сервер, где разрешён только SFTP). */
  denyExec?: boolean
  /** Запрещать смену владельца (как у обычного пользователя без прав root). */
  denyChown?: boolean
}

export interface TestServer {
  port: number
  hostKey: ParsedKey
  hostKeyBase64: string
  /** Размеры терминала, которые присылал клиент (pty и window-change). */
  sizes: Array<{ cols: number; rows: number }>
  /** Строки, которые клиент ввёл в оболочку. */
  lines: string[]
  /** Путь на диске для пути сервера (только при sftpRoot). */
  real(path: string): string
  close(): Promise<void>
}

/**
 * Пара ключей ed25519. Генератор ssh2 примерно в одном случае из 256 теряет ведущий нулевой
 * байт ключа, и такой ключ потом не читает сам ssh2 (ключи из ssh-keygen этим не страдают) —
 * поэтому негодную пару просто создаём заново.
 */
function ed25519Pair(passphrase?: string): { private: string; public: string } {
  for (let attempt = 0; ; attempt++) {
    const pair = passphrase
      ? utils.generateKeyPairSync('ed25519', { passphrase, cipher: 'aes256-ctr', rounds: 4 })
      : utils.generateKeyPairSync('ed25519')
    let parsed: unknown
    try {
      parsed = utils.parseKey(pair.private, passphrase)
    } catch (err) {
      parsed = err
    }
    if (!(parsed instanceof Error) || attempt >= 20) return pair
  }
}

export function generateKey(passphrase?: string): { private: string; public: string; parsed: ParsedKey } {
  const pair = ed25519Pair(passphrase)
  const parsed = utils.parseKey(pair.public)
  if (parsed instanceof Error) throw parsed
  return { private: pair.private, public: pair.public, parsed: Array.isArray(parsed) ? parsed[0] : parsed }
}

const sameBuffer = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b)

// ---------- «Linux» для сбора сведений о сервере ----------
// Ответ «Linux-сервера» на скрипт сбора сведений (src/main/ssh/serverStats.ts).
// Счётчики растут со временем: загрузка ЦП ≈ 25 %, сеть ≈ 50 КБ/с вниз и 2 КБ/с вверх,
// процесс node ≈ 10 % ядра. Все данные выдуманные (адреса — из документационных диапазонов).

const MARK = '@@TERMION:'
const started = Date.now()

function content(name: string, extraSeconds: number): string[] {
  const t = (Date.now() - started) / 1000 + extraSeconds
  const up = 1000 + t
  switch (name) {
    case 'host':
      return ['web-1']
    case 'os':
      return ['PRETTY_NAME="Ubuntu 24.04.1 LTS"', 'NAME="Ubuntu"', 'VERSION_ID="24.04"']
    case 'uname':
      return ['Linux 6.8.0-45-generic x86_64']
    case 'cpumodel':
      return ['Model name:                      Intel(R) Xeon(R) Gold 6140 CPU @ 2.30GHz']
    case 'nproc':
      return ['2']
    case 'virt':
      return ['kvm']
    case 'clk':
      return ['100', '4096']
    case 'load':
      return ['0.42 0.30 0.25 2/187 12345']
    case 'mem':
      return [
        'MemTotal:        4012345 kB',
        'MemFree:          512000 kB',
        'MemAvailable:    2800000 kB',
        'Buffers:          100000 kB',
        'Cached:          1500000 kB',
        'SwapTotal:       2097148 kB',
        'SwapFree:        1900000 kB'
      ]
    case 'df':
      return [
        'Filesystem     1024-blocks     Used Available Capacity Mounted on',
        'tmpfs               401236     1100    400136       1% /run',
        '/dev/vda1         40470732 18234567  20145678      48% /',
        'tmpfs              2006172        0   2006172       0% /dev/shm',
        '/dev/vda15          106858     6186    100672       6% /boot/efi',
        '/dev/loop0           65536    65536         0     100% /snap/core20/2318',
        'overlay           40470732 18234567  20145678      48% /var/lib/docker/overlay2/abc/merged',
        '/dev/vdb1         103080224 41231089  56590000      43% /mnt/data backup'
      ]
    case 'uptime':
    case 'uptime2':
      return [`${up.toFixed(2)} ${(up * 1.7).toFixed(2)}`]
    case 'stat':
    case 'stat2': {
      const total = Math.round(up * 200) // 2 ядра × 100 тиков в секунду
      const idle = Math.round(total * 0.75)
      const user = total - idle
      return [`cpu  ${user} 0 0 ${idle} 0 0 0 0 0 0`]
    }
    case 'net':
    case 'net2':
      return [
        'Inter-|   Receive                                                |  Transmit',
        ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
        `    lo: ${Math.round(up * 100)} 10 0 0 0 0 0 0 ${Math.round(up * 100)} 10 0 0 0 0 0 0`,
        `  eth0: ${Math.round(up * 50000)} 900 0 0 0 0 0 0 ${Math.round(up * 2000)} 800 0 0 0 0 0 0`,
        `docker0: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`
      ]
    case 'procs':
    case 'procs2': {
      const proc = (pid: number, name: string, ppid: number, ticks: number, rssPages: number) => {
        const rest = Array.from({ length: 22 }, () => '0')
        rest[0] = 'S'
        rest[1] = String(ppid)
        rest[11] = String(Math.round(ticks))
        rest[12] = '0'
        rest[21] = String(rssPages)
        return `${pid} (${name}) ${rest.join(' ')}`
      }
      return [
        proc(1, 'systemd', 0, up * 0.1, 3000),
        proc(812, 'node', 1, up * 10, 52000), // 10 % ядра, ~200 МБ
        proc(913, 'nginx: worker', 1, up * 2, 4000), // имя с пробелом и двоеточием
        proc(999, 'sh', 1, up * 50, 100), // сам скрипт сбора — в список не попадает
        proc(1000, 'cat', 999, up * 50, 100)
      ]
    }
    case 'self':
      return ['999']
    case 'who':
      return ['1']
    case 'ip':
      return [
        '1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever',
        '2: eth0    inet 203.0.113.10/24 brd 203.0.113.255 scope global eth0\\       valid_lft forever preferred_lft forever',
        '2: eth0    inet6 2001:db8::10/64 scope global \\       valid_lft forever preferred_lft forever',
        '2: eth0    inet6 fe80::1/64 scope link \\       valid_lft forever preferred_lft forever',
        '3: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\\       valid_lft forever preferred_lft forever'
      ]
    case 'docker':
      return ['web\tUp 3 days\tnginx:1.27', 'db\tUp 3 days (healthy)\tpostgres:16', 'rc=0']
    default:
      return []
  }
}

/** Вывод, который вернул бы настоящий Linux на этот скрипт. Перед ним — «мусор» из .bashrc. */
export function fakeLinuxOutput(script: string): string {
  const out = ['Welcome! (вывод .bashrc, который нужно пропустить)']
  let afterSleep = false
  for (const line of script.split('\n')) {
    if (line.startsWith('sleep ')) afterSleep = true
    const m = /^echo '@@TERMION:([\w]+)'$/.exec(line.trim())
    if (!m) continue
    out.push(`${MARK}${m[1]}`, ...content(m[1], afterSleep ? 0.5 : 0))
  }
  return out.join('\n') + '\n'
}

/** Простейшая оболочка: приглашение, эхо, cd и несколько команд для тестов. */
function runShell(
  stream: ServerChannel,
  server: TestServer,
  getSize: () => { cols: number; rows: number },
  hasFs: boolean
): void {
  let cwd = TEST_HOME
  const pretty = () => (cwd === TEST_HOME ? '~' : cwd.startsWith(TEST_HOME + '/') ? '~' + cwd.slice(TEST_HOME.length) : cwd)
  // Как Ubuntu: заголовок окна «user@host: папка» — по нему Termion узнаёт текущую папку.
  const prompt = () => stream.write(`\x1b]0;${TEST_USER}@test: ${pretty()}\x07${TEST_USER}@test:${pretty()}$ `)
  stream.write('Welcome to the Termion test server\r\n')
  prompt()
  let line = ''
  stream.on('data', (data: Buffer) => {
    for (const ch of data.toString('utf8')) {
      if (ch === '\r' || ch === '\n') {
        stream.write('\r\n')
        const cmd = line.trim()
        line = ''
        server.lines.push(cmd)
        if (cmd === 'exit') {
          stream.write('logout\r\n')
          stream.exit(0)
          stream.end()
          return
        }
        if (cmd.startsWith('flood ')) {
          const total = Number(cmd.slice(6))
          const chunk = Buffer.alloc(64 * 1024, 0x61)
          let sent = 0
          const pump = () => {
            while (sent < total) {
              const part = chunk.subarray(0, Math.min(chunk.length, total - sent))
              sent += part.length
              if (!stream.write(part)) {
                stream.once('drain', pump)
                return
              }
            }
            stream.write('\r\nFLOOD-DONE\r\n')
            prompt()
          }
          pump()
          return
        }
        if (cmd === 'size') {
          const s = getSize()
          stream.write(`${s.cols}x${s.rows}\r\n`)
        } else if (cmd === 'cd' || cmd.startsWith('cd ')) {
          let arg = cmd.slice(2).trim().replace(/^--\s+/, '').replace(/^'(.*)'$/, '$1')
          if (!arg || arg === '~') arg = TEST_HOME
          const target = posix.resolve(cwd, arg.replace(/^~(?=\/|$)/, TEST_HOME))
          let ok = !hasFs
          try {
            ok = ok || fs.statSync(server.real(target)).isDirectory()
          } catch {
            ok = false
          }
          if (ok) cwd = target
          else stream.write(`bash: cd: ${arg}: No such file or directory\r\n`)
        } else if (cmd === 'pwd') {
          stream.write(`${cwd}\r\n`)
        } else if (cmd) {
          stream.write(`echo: ${cmd}\r\n`)
        }
        prompt()
      } else if (ch === '\u007f') {
        line = line.slice(0, -1)
      } else {
        line += ch
        stream.write(ch)
      }
    }
  })
}

/** SFTP-подсистема поверх папки на диске. posix-rename обрабатывается, но сервер ssh2 его не объявляет. */
function serveSftp(sftp: SFTPWrapper, server: TestServer, opts: TestServerOptions): void {
  const handles = new Map<string, { kind: 'file'; fd: number; path: string } | { kind: 'dir'; path: string; done: boolean; offset: number }>()
  let seq = 0
  const newHandle = (value: Parameters<typeof handles.set>[1]) => {
    const h = Buffer.alloc(4)
    h.writeUInt32BE(++seq)
    handles.set(h.toString('hex'), value)
    return h
  }
  const owners = new Map<string, number>() // uid, выставленный через setstat
  const attrs = (path: string, st: fs.Stats): Attributes => ({
    mode: st.mode,
    uid: owners.get(path) ?? opts.ownerOf?.(path) ?? 0,
    gid: owners.get(path) ?? opts.ownerOf?.(path) ?? 0,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000)
  })
  const fail = (reqid: number, err: unknown) => {
    const code = (err as { code?: string }).code
    if (code === 'ENOENT') return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
    if (code === 'EACCES' || code === 'EPERM') return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED)
    return sftp.status(reqid, STATUS_CODE.FAILURE)
  }
  const guard = (reqid: number, fn: () => void) => {
    try {
      fn()
    } catch (err) {
      fail(reqid, err)
    }
  }
  const applyAttrs = (path: string, a: Attributes | undefined): boolean => {
    if (a && typeof a.uid === 'number') {
      if (opts.denyChown) return false
      owners.set(path, a.uid)
    }
    return true
  }

  sftp.on('OPEN', (reqid, filename, flags) =>
    guard(reqid, () => {
      const mode = flagsToString(flags)
      if (!mode) return sftp.status(reqid, STATUS_CODE.FAILURE)
      const fd = fs.openSync(server.real(filename), mode)
      owners.delete(posix.normalize(filename))
      sftp.handle(reqid, newHandle({ kind: 'file', fd, path: posix.normalize(filename) }))
    })
  )
  sftp.on('READ', (reqid, handle, offset, length) =>
    guard(reqid, () => {
      const h = handles.get(handle.toString('hex'))
      if (h?.kind !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
      const buf = Buffer.alloc(length)
      const n = fs.readSync(h.fd, buf, 0, length, offset)
      if (!n) return sftp.status(reqid, STATUS_CODE.EOF)
      sftp.data(reqid, buf.subarray(0, n))
    })
  )
  sftp.on('WRITE', (reqid, handle, offset, data) =>
    guard(reqid, () => {
      const h = handles.get(handle.toString('hex'))
      if (h?.kind !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
      fs.writeSync(h.fd, data, 0, data.length, offset)
      sftp.status(reqid, STATUS_CODE.OK)
    })
  )
  sftp.on('FSTAT', (reqid, handle) =>
    guard(reqid, () => {
      const h = handles.get(handle.toString('hex'))
      if (h?.kind !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
      sftp.attrs(reqid, attrs(h.path, fs.fstatSync(h.fd)))
    })
  )
  sftp.on('FSETSTAT', (reqid, handle, a) =>
    guard(reqid, () => {
      const h = handles.get(handle.toString('hex'))
      if (h?.kind !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
      sftp.status(reqid, applyAttrs(h.path, a) ? STATUS_CODE.OK : STATUS_CODE.PERMISSION_DENIED)
    })
  )
  sftp.on('CLOSE', (reqid, handle) =>
    guard(reqid, () => {
      const key = handle.toString('hex')
      const h = handles.get(key)
      if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE)
      if (h.kind === 'file') fs.closeSync(h.fd)
      handles.delete(key)
      sftp.status(reqid, STATUS_CODE.OK)
    })
  )
  sftp.on('OPENDIR', (reqid, path) =>
    guard(reqid, () => {
      if (!fs.statSync(server.real(path)).isDirectory()) return sftp.status(reqid, STATUS_CODE.FAILURE)
      sftp.handle(reqid, newHandle({ kind: 'dir', path: posix.normalize(path), done: false, offset: 0 }))
    })
  )
  sftp.on('READDIR', (reqid, handle) =>
    guard(reqid, () => {
      const h = handles.get(handle.toString('hex'))
      if (h?.kind !== 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE)
      if (h.done) return sftp.status(reqid, STATUS_CODE.EOF)
      const all = fs.readdirSync(server.real(h.path))
      const batch = opts.readdirBatch ?? 100
      const part = all.slice(h.offset, h.offset + batch)
      h.offset += part.length
      if (h.offset >= all.length) h.done = true
      if (!part.length) return sftp.status(reqid, STATUS_CODE.EOF)
      const names = part.map((filename) => {
        const p = posix.join(h.path, filename)
        return { filename, longname: filename, attrs: attrs(p, fs.lstatSync(server.real(p))) }
      })
      sftp.name(reqid, names)
    })
  )
  const statHandler = (follow: boolean) => (reqid: number, path: string) =>
    guard(reqid, () => {
      const real = server.real(path)
      sftp.attrs(reqid, attrs(posix.normalize(path), follow ? fs.statSync(real) : fs.lstatSync(real)))
    })
  sftp.on('STAT', statHandler(true))
  sftp.on('LSTAT', statHandler(false))
  sftp.on('SETSTAT', (reqid, path, a) =>
    guard(reqid, () => {
      fs.statSync(server.real(path))
      sftp.status(reqid, applyAttrs(posix.normalize(path), a) ? STATUS_CODE.OK : STATUS_CODE.PERMISSION_DENIED)
    })
  )
  sftp.on('REMOVE', (reqid, path) =>
    guard(reqid, () => {
      fs.unlinkSync(server.real(path))
      sftp.status(reqid, STATUS_CODE.OK)
    })
  )
  sftp.on('RMDIR', (reqid, path) =>
    guard(reqid, () => {
      fs.rmdirSync(server.real(path))
      sftp.status(reqid, STATUS_CODE.OK)
    })
  )
  sftp.on('MKDIR', (reqid, path) =>
    guard(reqid, () => {
      fs.mkdirSync(server.real(path))
      sftp.status(reqid, STATUS_CODE.OK)
    })
  )
  sftp.on('REALPATH', (reqid, path) =>
    guard(reqid, () => {
      const abs = posix.resolve(TEST_HOME, path || '.')
      sftp.name(reqid, [{ filename: abs, longname: abs, attrs: {} as Attributes }])
    })
  )
  sftp.on('READLINK', (reqid) => sftp.status(reqid, STATUS_CODE.FAILURE))
  sftp.on('RENAME', (reqid, from, to) =>
    guard(reqid, () => {
      // Как OpenSSH (SFTP v3): если цель существует — ошибка.
      if (fs.existsSync(server.real(to))) return sftp.status(reqid, STATUS_CODE.FAILURE)
      fs.renameSync(server.real(from), server.real(to))
      sftp.status(reqid, STATUS_CODE.OK)
    })
  )
  sftp.on('EXTENDED', (reqid, name, data) =>
    guard(reqid, () => {
      if (name === 'posix-rename@openssh.com' && data) {
        const fromLen = data.readUInt32BE(0)
        const from = data.subarray(4, 4 + fromLen).toString('utf8')
        const toLen = data.readUInt32BE(4 + fromLen)
        const to = data.subarray(8 + fromLen, 8 + fromLen + toLen).toString('utf8')
        fs.renameSync(server.real(from), server.real(to))
        const owner = owners.get(posix.normalize(from))
        owners.delete(posix.normalize(from))
        if (owner !== undefined) owners.set(posix.normalize(to), owner)
        else owners.set(posix.normalize(to), 0)
        return sftp.status(reqid, STATUS_CODE.OK)
      }
      if (name === 'fsync@openssh.com') return sftp.status(reqid, STATUS_CODE.OK)
      sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED)
    })
  )
}

export async function startTestServer(opts: TestServerOptions = {}): Promise<TestServer> {
  const hostPrivate = opts.hostKey ?? ed25519Pair().private
  const parsedHost = utils.parseKey(hostPrivate)
  if (parsedHost instanceof Error) throw parsedHost
  const hostKey = Array.isArray(parsedHost) ? parsedHost[0] : parsedHost
  const methods = opts.methods ?? ['publickey', 'password']
  const connections = new Set<Connection>()
  const root = opts.sftpRoot

  if (root) fs.mkdirSync(join(root, 'home', TEST_USER), { recursive: true })

  const state: TestServer = {
    port: 0,
    hostKey,
    hostKeyBase64: hostKey.getPublicSSH().toString('base64'),
    sizes: [],
    lines: [],
    real: (path) => {
      if (!root) throw new Error('SFTP не включён')
      return join(root, ...posix.normalize('/' + path).split('/').filter(Boolean))
    },
    close: async () => undefined
  }

  const server = new Server({ hostKeys: [hostPrivate] }, (client) => {
    connections.add(client)
    client.on('close', () => connections.delete(client))
    client.on('error', () => undefined)
    client.on('authentication', (ctx) => {
      if (ctx.username !== TEST_USER) return ctx.reject(methods)
      if (ctx.method === 'password' && methods.includes('password') && opts.password !== undefined && ctx.password === opts.password) {
        return ctx.accept()
      }
      if (ctx.method === 'keyboard-interactive' && methods.includes('keyboard-interactive')) {
        return ctx.prompt([{ prompt: 'Password: ', echo: false }], 'Вход', 'Введите пароль', (answers) => {
          if (answers[0] === opts.password) ctx.accept()
          else ctx.reject(methods)
        })
      }
      if (ctx.method === 'publickey' && methods.includes('publickey')) {
        const allowed = (opts.clientKeys ?? []).find(
          (k) => k.type === ctx.key.algo && sameBuffer(k.getPublicSSH(), ctx.key.data)
        )
        if (allowed) {
          if (!ctx.signature) return ctx.accept()
          if (ctx.blob && allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true) return ctx.accept()
        }
      }
      return ctx.reject(methods)
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        let size = { cols: 80, rows: 24 }
        const session = accept()
        session.on('pty', (acceptPty, _reject, info) => {
          size = { cols: info.cols, rows: info.rows }
          state.sizes.push(size)
          acceptPty?.()
        })
        session.on('window-change', (acceptWc, _reject, info) => {
          size = { cols: info.cols, rows: info.rows }
          state.sizes.push(size)
          acceptWc?.()
        })
        session.on('shell', (acceptShell) => runShell(acceptShell(), state, () => size, !!root))
        // Сбор сведений о сервере: `sh -s`, скрипт приходит через stdin.
        session.on('exec', (acceptExec, rejectExec, info) => {
          if (opts.denyExec || info.command !== 'sh -s') return rejectExec?.()
          const stream = acceptExec()
          const chunks: Buffer[] = []
          stream.on('data', (d: Buffer) => chunks.push(d))
          stream.on('end', () => {
            stream.write(fakeLinuxOutput(Buffer.concat(chunks).toString('utf8')))
            stream.exit(0)
            stream.end()
          })
        })
        session.on('sftp', (acceptSftp, rejectSftp) => {
          if (!root) return rejectSftp?.()
          serveSftp(acceptSftp(), state, opts)
        })
      })
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  state.port = (server.address() as { port: number }).port
  state.close = () =>
    new Promise<void>((resolve) => {
      for (const c of connections) c.end()
      server.close(() => resolve())
    })
  return state
}
