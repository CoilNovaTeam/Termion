// Сведения о сервере: разбор вывода команд и замер через настоящее SSH-подключение
// к тестовому серверу (он отвечает как Linux, см. fakeLinuxOutput в helpers/sshServer.ts).

import { Client } from 'ssh2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildScript,
  cpuPercent,
  parseCpuTimes,
  parseDf,
  parseDocker,
  parseInfo,
  parseIpAddr,
  parseMem,
  parseNetDev,
  parseProcStat,
  parseSections,
  ServerProbe
} from '../src/main/ssh/serverStats'
import { TEST_USER, startTestServer, type TestServer } from './helpers/sshServer'

const PASSWORD = 'stats-secret'

describe('разбор вывода', () => {
  it('разделы по меткам, мусор из .bashrc до первой метки пропускается', () => {
    const sec = parseSections('Добро пожаловать!\n@@TERMION:a\n1\n2\r\n@@TERMION:b\n@@TERMION:end\n')
    expect(sec.get('a')).toEqual(['1', '2'])
    expect(sec.get('b')).toEqual([])
    expect(sec.has('end')).toBe(true)
  })

  it('система: os-release, uname, модель процессора из lscpu и из /proc/cpuinfo', () => {
    const base = new Map<string, string[]>([
      ['host', ['db-1']],
      ['os', ['NAME="Debian GNU/Linux"', 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"']],
      ['uname', ['Linux 6.1.0-25-amd64 x86_64']],
      ['nproc', ['4']],
      ['virt', ['none']],
      ['clk', ['100', '4096']]
    ])
    const fromLscpu = parseInfo(new Map([...base, ['cpumodel', ['Model name:   AMD EPYC 7543 32-Core Processor']]]))
    expect(fromLscpu).toMatchObject({ hostname: 'db-1', os: 'Debian GNU/Linux 12 (bookworm)', kernel: 'Linux 6.1.0-25-amd64', arch: 'x86_64', cores: 4, virt: null })
    expect(fromLscpu.cpuModel).toBe('AMD EPYC 7543 32-Core Processor')
    const fromCpuinfo = parseInfo(new Map([...base, ['cpumodel', ['model name\t: ARMv7 Processor rev 4 (v7l)']]]))
    expect(fromCpuinfo.cpuModel).toBe('ARMv7 Processor rev 4 (v7l)')
    expect(parseInfo(new Map()).os).toBeNull()
  })

  it('загрузка процессора по двум замерам /proc/stat', () => {
    const a = parseCpuTimes(['cpu  100 0 100 700 100 0 0 0 0 0'])
    const b = parseCpuTimes(['cpu  200 0 200 1300 100 0 0 0 0 0'])
    expect(a).toEqual({ total: 1000, idle: 800 })
    expect(cpuPercent(a, b)).toBeCloseTo(25)
    expect(cpuPercent(null, b)).toBeNull()
    expect(cpuPercent(b, b)).toBeNull()
  })

  it('память: с MemAvailable и без него (старые ядра, BusyBox)', () => {
    expect(parseMem(['MemTotal: 1000 kB', 'MemAvailable: 600 kB', 'SwapTotal: 0 kB', 'SwapFree: 0 kB'])).toEqual({
      mem: { total: 1024000, available: 614400 },
      swap: null
    })
    expect(parseMem(['MemTotal: 1000 kB', 'MemFree: 100 kB', 'Buffers: 50 kB', 'Cached: 250 kB', 'SwapTotal: 512 kB', 'SwapFree: 256 kB'])).toEqual({
      mem: { total: 1024000, available: 409600 },
      swap: { total: 524288, free: 262144 }
    })
    expect(parseMem(undefined)).toEqual({ mem: null, swap: null })
  })

  it('диски: без служебных файловых систем, «/» первым, пути с пробелами', () => {
    const disks = parseDf([
      'Filesystem     1024-blocks     Used Available Capacity Mounted on',
      'tmpfs               401236     1100    400136       1% /run',
      '/dev/vdb1         1000 400 600 40% /mnt/my disk',
      '/dev/vda1         4000 1000 3000 25% /',
      '/dev/vda1         4000 1000 3000 25% /srv/bind',
      '/dev/loop3        65536 65536 0 100% /snap/lxd/1',
      'overlay           4000 1000 3000 25% /var/lib/docker/overlay2/x/merged'
    ])
    expect(disks.map((d) => d.mount)).toEqual(['/', '/mnt/my disk'])
    expect(disks[0]).toEqual({ mount: '/', source: '/dev/vda1', total: 4096000, used: 1024000, avail: 3072000 })
  })

  it('сеть: счётчики /proc/net/dev и глобальные адреса из ip -o addr', () => {
    const net = parseNetDev(['Inter-| x', ' face |bytes', '  eth0: 1000 1 0 0 0 0 0 0 2000 1 0 0 0 0 0 0', 'wg0:5 0 0 0 0 0 0 0 7 0 0 0 0 0 0 0'])
    expect(net.get('eth0')).toEqual({ rx: 1000, tx: 2000 })
    expect(net.get('wg0')).toEqual({ rx: 5, tx: 7 })
    const ip = parseIpAddr([
      '2: eth0    inet 203.0.113.10/24 brd 203.0.113.255 scope global eth0\\ valid_lft forever',
      '2: eth0    inet6 fe80::1/64 scope link \\ valid_lft forever',
      '5: veth12@if4    inet6 2001:db8::5/64 scope global \\ valid_lft forever'
    ])
    expect(ip.get('eth0')).toEqual(['203.0.113.10'])
    expect(ip.get('veth12')).toEqual(['2001:db8::5'])
  })

  it('процессы: имена с пробелами и скобками', () => {
    const rest = (ppid: number, utime: number, rss: number) => {
      const r = Array.from({ length: 22 }, () => '0')
      r[1] = String(ppid)
      r[11] = String(utime)
      r[21] = String(rss)
      return r.join(' ')
    }
    const procs = parseProcStat([`42 (my (odd) proc) ${rest(1, 500, 10)}`, `7 (kworker/0:1) ${rest(2, 3, 0)}`, 'мусор'])
    expect(procs.get(42)).toEqual({ name: 'my (odd) proc', ppid: 1, ticks: 500, rss: 10 })
    expect(procs.get(7)?.name).toBe('kworker/0:1')
    expect(procs.size).toBe(2)
  })

  it('Docker: список, нет прав, не установлен', () => {
    expect(parseDocker(['web\tUp 2 hours\tnginx', 'rc=0'])).toEqual([{ name: 'web', status: 'Up 2 hours', image: 'nginx' }])
    expect(parseDocker(['rc=0'])).toEqual([])
    expect(parseDocker(['rc=1'])).toBeNull()
    expect(parseDocker(undefined)).toBeNull()
  })

  it('скрипт: только POSIX sh и без «!» (на случай csh у пользователя)', () => {
    const script = buildScript('full', true, true)
    expect(script).not.toContain('!')
    expect(script).toContain("echo '@@TERMION:end'")
    expect(script).toContain('sleep 0.5')
    expect(buildScript('light', false, false)).not.toContain('procs')
  })
})

describe('замер через подключение', () => {
  let server: TestServer
  let client: Client

  const connect = (port: number) =>
    new Promise<Client>((resolve, reject) => {
      const c = new Client()
      c.on('ready', () => resolve(c))
        .on('error', reject)
        .connect({ host: '127.0.0.1', port, username: TEST_USER, password: PASSWORD, readyTimeout: 5000 })
    })

  beforeAll(async () => {
    server = await startTestServer({ password: PASSWORD })
    client = await connect(server.port)
  })

  afterAll(async () => {
    client.end()
    await server.close()
  })

  it('строка состояния: ЦП, память, диски, сеть — сразу с первого замера', async () => {
    const probe = new ServerProbe(client)
    const s = await probe.sample('light')
    expect(s.info).toMatchObject({ hostname: 'web-1', os: 'Ubuntu 24.04.1 LTS', cores: 2, virt: 'kvm' })
    expect(s.info.cpuModel).toContain('Xeon')
    expect(s.cpu).toBeCloseTo(25, 0)
    expect(s.mem?.total).toBe(4012345 * 1024)
    expect(s.swap).toEqual({ total: 2097148 * 1024, free: 1900000 * 1024 })
    expect(s.disks.map((d) => d.mount)).toEqual(['/', '/boot/efi', '/mnt/data backup'])
    const eth0 = s.net.find((n) => n.name === 'eth0')
    expect(eth0?.rxRate).toBeGreaterThan(40_000)
    expect(eth0?.rxRate).toBeLessThan(60_000)
    expect(s.net.map((n) => n.name)).toEqual(['eth0']) // lo и docker0 не показываются
    expect(s.top).toBeNull()
    expect(s.load).toEqual([0.42, 0.3, 0.25])
  })

  it('подробная сводка: процессы (без самого сбора), адреса, Docker', async () => {
    const probe = new ServerProbe(client)
    const s = await probe.sample('full')
    expect(s.top?.[0]).toMatchObject({ name: 'node', pid: 812 })
    expect(s.top?.[0].cpu).toBeCloseTo(10, 0)
    expect(s.top?.[0].mem).toBe(52000 * 4096)
    expect(s.top?.some((p) => p.name === 'sh' || p.name === 'cat')).toBe(false)
    expect(s.top?.find((p) => p.name === 'nginx: worker')).toBeTruthy()
    expect(s.processes).toBe(3)
    expect(s.net.find((n) => n.name === 'eth0')?.addrs).toEqual(['203.0.113.10', '2001:db8::10'])
    expect(s.docker).toEqual([
      { name: 'web', status: 'Up 3 days', image: 'nginx:1.27' },
      { name: 'db', status: 'Up 3 days (healthy)', image: 'postgres:16' }
    ])
    // Следующий замер считается по разнице с предыдущим, без паузы.
    const started = Date.now()
    const next = await probe.sample('full')
    expect(Date.now() - started).toBeLessThan(400)
    expect(next.top?.[0].name).toBe('node')
  })

  it('сервер без выполнения команд (только SFTP) — понятная ошибка', async () => {
    const sftpOnly = await startTestServer({ password: PASSWORD, denyExec: true })
    const c = await connect(sftpOnly.port)
    try {
      await expect(new ServerProbe(c).sample('light')).rejects.toThrow(/не разрешает выполнять команды/)
    } finally {
      c.end()
      await sftpOnly.close()
    }
  })
})
