// Сведения о сервере: конфигурация, нагрузка, память, диски, сеть, процессы, Docker.
//
// Команды выполняются отдельным каналом того же подключения: `sh -s`, а сам скрипт идёт
// через stdin — поэтому неважно, какая у пользователя оболочка (bash, zsh, fish, csh).
// Только чтение: /proc, df, ip, who, docker ps. Скорость процессора и сети считается по
// разнице двух замеров; при первом замере скрипт сам делает второй через полсекунды.

import type { Client } from 'ssh2'
import type { ContainerInfo, DiskUsage, NetIface, ProcessInfo, ServerInfo, ServerStats, StatsMode } from '@shared/types'

const MARK = '@@TERMION:'
const MAX_OUTPUT = 4 * 1024 * 1024
const TIMEOUT = 15_000

// ---------- скрипт ----------

const section = (name: string, cmd: string) => `echo '${MARK}${name}'\n${cmd}\n`

const STATIC = [
  section('host', 'hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null'),
  section('os', 'cat /etc/os-release 2>/dev/null'),
  section('uname', 'uname -srm 2>/dev/null'),
  section('cpumodel', "(lscpu 2>/dev/null | grep -m 1 -i '^model name') || grep -m 1 -i -E '^(model name|hardware|cpu model)' /proc/cpuinfo 2>/dev/null"),
  section('nproc', 'nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null'),
  section('virt', 'systemd-detect-virt 2>/dev/null'),
  section('clk', 'getconf CLK_TCK 2>/dev/null; getconf PAGESIZE 2>/dev/null')
].join('')

/**
 * Счётчики для расчёта скорости. Время и процессор читаются встроенной командой read —
 * без запуска процессов, чтобы сам замер почти не попадал в загрузку процессора.
 */
const counters = (suffix: string, full: boolean): string[] => [
  full ? section(`procs${suffix}`, 'cat /proc/[0-9]*/stat 2>/dev/null | head -c 3000000') : '',
  section(`net${suffix}`, 'cat /proc/net/dev 2>/dev/null'),
  section(`uptime${suffix}`, 'read -r u 2>/dev/null </proc/uptime && echo "$u"'),
  section(`stat${suffix}`, 'read -r c 2>/dev/null </proc/stat && echo "$c"')
]

const LIGHT = [
  section('load', 'cat /proc/loadavg 2>/dev/null'),
  section('mem', "grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null"),
  section('df', 'df -kP 2>/dev/null')
].join('')

const FULL = [
  section('self', 'echo $$'),
  section('who', 'who 2>/dev/null | wc -l'),
  section('ip', 'ip -o addr show 2>/dev/null'),
  section(
    'docker',
    [
      'if command -v docker >/dev/null 2>&1; then',
      "  if command -v timeout >/dev/null 2>&1; then timeout 4 docker ps --format '{{.Names}}\\t{{.Status}}\\t{{.Image}}' 2>/dev/null",
      "  else docker ps --format '{{.Names}}\\t{{.Status}}\\t{{.Image}}' 2>/dev/null; fi",
      '  echo "rc=$?"',
      'fi'
    ].join('\n')
  )
].join('')

export function buildScript(mode: StatsMode, withStatic: boolean, warmUp: boolean): string {
  const full = mode === 'full'
  return [
    'LC_ALL=C; export LC_ALL',
    withStatic ? STATIC : '',
    LIGHT,
    full ? FULL : '',
    ...counters('', full),
    // Первый замер: второй снимок через полсекунды, чтобы сразу показать загрузку и скорость.
    // Порядок зеркальный: между двумя чтениями процессора — только пауза.
    ...(warmUp ? ['sleep 0.5 2>/dev/null', ...counters('2', full).reverse()] : []),
    `echo '${MARK}end'`
  ].join('\n')
}

// ---------- разбор ----------

/** Вывод по разделам. Всё до первой метки (приветствия из .bashrc и т. п.) пропускается. */
export function parseSections(output: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let current: string[] | null = null
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith(MARK)) {
      current = []
      out.set(line.slice(MARK.length).trim(), current)
    } else if (current) {
      current.push(line)
    }
  }
  return out
}

const num = (s: string | undefined): number | null => {
  if (s === undefined || s.trim() === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

const firstLine = (lines: string[] | undefined): string | null => {
  const l = lines?.find((x) => x.trim())
  return l ? l.trim() : null
}

export function parseInfo(sec: Map<string, string[]>): ServerInfo & { clk: number; page: number } {
  const osRelease = new Map<string, string>()
  for (const line of sec.get('os') ?? []) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
    if (m) osRelease.set(m[1], m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'))
  }
  const uname = firstLine(sec.get('uname'))?.split(/\s+/) ?? []
  const model = firstLine(sec.get('cpumodel'))
  const clk = (sec.get('clk') ?? []).map((l) => num(l)).filter((n): n is number => n !== null)
  const virt = firstLine(sec.get('virt'))
  return {
    hostname: firstLine(sec.get('host')),
    os: osRelease.get('PRETTY_NAME') ?? (osRelease.get('NAME') ? `${osRelease.get('NAME')} ${osRelease.get('VERSION') ?? ''}`.trim() : null),
    kernel: uname.length >= 2 ? `${uname[0]} ${uname[1]}` : (uname[0] ?? null),
    arch: uname[2] ?? null,
    cpuModel: model ? model.slice(model.indexOf(':') + 1).replace(/\s+/g, ' ').trim() || null : null,
    cores: num(firstLine(sec.get('nproc')) ?? undefined),
    virt: virt && virt !== 'none' ? virt : null,
    clk: clk[0] && clk[0] > 0 ? clk[0] : 100,
    page: clk[1] && clk[1] > 0 ? clk[1] : 4096
  }
}

export interface CpuTimes {
  total: number
  idle: number
}

/** Строка «cpu ...» из /proc/stat: всё время и простой (idle + iowait), в тиках. */
export function parseCpuTimes(lines: string[] | undefined): CpuTimes | null {
  const line = lines?.find((l) => l.startsWith('cpu '))
  if (!line) return null
  const v = line.trim().split(/\s+/).slice(1, 9).map(Number)
  if (v.length < 4 || v.some((n) => !Number.isFinite(n))) return null
  const total = v.reduce((a, b) => a + b, 0)
  return { total, idle: v[3] + (v[4] ?? 0) }
}

export function cpuPercent(prev: CpuTimes | null, cur: CpuTimes | null): number | null {
  if (!prev || !cur) return null
  const total = cur.total - prev.total
  const idle = cur.idle - prev.idle
  if (total <= 0) return null
  return Math.min(100, Math.max(0, (1 - idle / total) * 100))
}

export function parseMem(lines: string[] | undefined): Pick<ServerStats, 'mem' | 'swap'> {
  const kv = new Map<string, number>()
  for (const line of lines ?? []) {
    const m = /^(\w+):\s+(\d+)/.exec(line)
    if (m) kv.set(m[1], Number(m[2]) * 1024)
  }
  const total = kv.get('MemTotal')
  if (!total) return { mem: null, swap: null }
  const available = kv.get('MemAvailable') ?? (kv.get('MemFree') ?? 0) + (kv.get('Buffers') ?? 0) + (kv.get('Cached') ?? 0)
  const swapTotal = kv.get('SwapTotal') ?? 0
  return {
    mem: { total, available: Math.min(total, available) },
    swap: swapTotal > 0 ? { total: swapTotal, free: Math.min(swapTotal, kv.get('SwapFree') ?? 0) } : null
  }
}

const PSEUDO_FS = new Set(['tmpfs', 'devtmpfs', 'udev', 'none', 'overlay', 'shm', 'efivarfs', 'squashfs', 'cgroup', 'cgroup2', 'proc', 'sysfs', 'devpts', 'mqueue', 'run', 'rootfs'])
const PSEUDO_MOUNT = /^\/(dev|run|sys|proc|snap)(\/|$)|^\/var\/lib\/(docker|containers)\//

/** Вывод `df -kP`: настоящие диски, без служебных файловых систем; «/» первым. */
export function parseDf(lines: string[] | undefined): DiskUsage[] {
  const out: DiskUsage[] = []
  const seen = new Map<string, DiskUsage>()
  for (const line of (lines ?? []).slice(1)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 6) continue
    const [source, blocks, used, avail] = parts
    const mount = parts.slice(5).join(' ')
    const total = Number(blocks) * 1024
    if (!Number.isFinite(total) || total <= 0) continue
    if (PSEUDO_FS.has(source) || PSEUDO_MOUNT.test(mount) || source.startsWith('/dev/loop')) continue
    const disk: DiskUsage = { mount, source, total, used: Number(used) * 1024, avail: Number(avail) * 1024 }
    // Одно и то же устройство в нескольких местах (bind) — показываем один раз, по короткому пути.
    const prev = seen.get(source)
    if (prev && source.startsWith('/')) {
      if (mount.length < prev.mount.length) out[out.indexOf(prev)] = disk
      continue
    }
    seen.set(source, disk)
    out.push(disk)
  }
  return out.sort((a, b) => (a.mount === '/' ? -1 : b.mount === '/' ? 1 : a.mount.localeCompare(b.mount)))
}

export type NetCounters = Map<string, { rx: number; tx: number }>

export function parseNetDev(lines: string[] | undefined): NetCounters {
  const out: NetCounters = new Map()
  for (const line of lines ?? []) {
    const i = line.indexOf(':')
    if (i < 0) continue
    const name = line.slice(0, i).trim()
    const v = line.slice(i + 1).trim().split(/\s+/).map(Number)
    if (!name || v.length < 9 || !Number.isFinite(v[0]) || !Number.isFinite(v[8])) continue
    out.set(name, { rx: v[0], tx: v[8] })
  }
  return out
}

/** `ip -o addr show`: глобальные адреса по интерфейсам. */
export function parseIpAddr(lines: string[] | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const line of lines ?? []) {
    const t = line.trim().split(/\s+/)
    if (t.length < 4 || (t[2] !== 'inet' && t[2] !== 'inet6')) continue
    const scope = t.indexOf('scope')
    if (scope < 0 || t[scope + 1] !== 'global') continue
    const name = t[1].replace(/@.*$/, '')
    const addr = t[3].replace(/\/\d+$/, '')
    out.set(name, [...(out.get(name) ?? []), addr])
  }
  return out
}

/** Служебные интерфейсы контейнеров и виртуальных мостов — в сводке не нужны. */
const HIDDEN_IFACE = /^(lo|docker\d*|br-|veth|virbr|cni|flannel|cali|vxlan|kube|dummy|tunl0|ip6tnl|sit\d)/

export interface ProcSample {
  name: string
  ppid: number
  ticks: number
  rss: number
}

/** Содержимое /proc/[pid]/stat всех процессов. Имя в скобках может содержать пробелы и скобки. */
export function parseProcStat(lines: string[] | undefined): Map<number, ProcSample> {
  const out = new Map<number, ProcSample>()
  for (const line of lines ?? []) {
    const open = line.indexOf('(')
    const close = line.lastIndexOf(')')
    if (open < 0 || close < open) continue
    const pid = Number(line.slice(0, open).trim())
    const rest = line.slice(close + 2).split(' ')
    if (!Number.isFinite(pid) || rest.length < 22) continue
    out.set(pid, {
      name: line.slice(open + 1, close),
      ppid: Number(rest[1]),
      ticks: Number(rest[11]) + Number(rest[12]),
      rss: Number(rest[21])
    })
  }
  return out
}

export function parseDocker(lines: string[] | undefined): ContainerInfo[] | null {
  if (!lines) return null // docker не установлен
  const rc = lines.find((l) => l.startsWith('rc='))
  if (!rc || rc !== 'rc=0') return null // нет прав или служба не отвечает
  return lines
    .filter((l) => l.includes('\t'))
    .map((l) => {
      const [name, status, image] = l.split('\t')
      return { name, status, image: image ?? '' }
    })
}

// ---------- замеры ----------

interface Prev {
  uptime: number
  cpu: CpuTimes | null
  net: NetCounters
  procs: Map<number, ProcSample> | null
}

export class ServerProbe {
  private info: (ServerInfo & { clk: number; page: number }) | null = null
  private prev: Prev | null = null
  private running: Promise<ServerStats> | null = null

  constructor(private readonly client: Client) {}

  /** Замер; одновременно идёт не больше одного — повторный вызов ждёт текущий. */
  sample(mode: StatsMode): Promise<ServerStats> {
    if (!this.running) this.running = this.measure(mode).finally(() => (this.running = null))
    return this.running
  }

  private async measure(mode: StatsMode): Promise<ServerStats> {
    const full = mode === 'full'
    const warmUp = !this.prev || (full && !this.prev.procs)
    const output = await this.run(buildScript(mode, !this.info, warmUp))
    const sec = parseSections(output)
    if (!sec.has('end') && !sec.has('uptime')) {
      throw new Error('Сервер не выполнил команды (возможно, разрешён только SFTP или это не Linux).')
    }
    if (!this.info) this.info = parseInfo(sec)
    const info = this.info

    // Предыдущий замер: из прошлого вызова или из первой половины этого (разогрев).
    const first: Prev = {
      uptime: num(firstLine(sec.get('uptime'))?.split(/\s+/)[0]) ?? 0,
      cpu: parseCpuTimes(sec.get('stat')),
      net: parseNetDev(sec.get('net')),
      procs: full ? parseProcStat(sec.get('procs')) : null
    }
    const second: Prev | null = sec.has('uptime2')
      ? {
          uptime: num(firstLine(sec.get('uptime2'))?.split(/\s+/)[0]) ?? 0,
          cpu: parseCpuTimes(sec.get('stat2')),
          net: parseNetDev(sec.get('net2')),
          procs: full ? parseProcStat(sec.get('procs2')) : null
        }
      : null
    const cur = second ?? first
    const prev = second ? first : this.prev
    this.prev = cur // без списка процессов (обычный режим) следующий подробный замер начнётся с разогрева
    const elapsed = prev && cur.uptime > prev.uptime ? cur.uptime - prev.uptime : 0

    const load = firstLine(sec.get('load'))?.split(/\s+/).slice(0, 3).map(Number)
    const addrs = parseIpAddr(sec.get('ip'))
    const net: NetIface[] = []
    for (const [name, c] of cur.net) {
      if (HIDDEN_IFACE.test(name)) continue
      const p = prev?.net.get(name)
      const rate = (a: number, b: number | undefined) => (b !== undefined && elapsed > 0 && a >= b ? (a - b) / elapsed : null)
      net.push({ name, addrs: addrs.get(name) ?? [], rxTotal: c.rx, txTotal: c.tx, rxRate: rate(c.rx, p?.rx), txRate: rate(c.tx, p?.tx) })
    }

    let top: ProcessInfo[] | null = null
    let processes: number | null = null
    if (full && cur.procs) {
      const self = num(firstLine(sec.get('self')) ?? undefined)
      const list: ProcessInfo[] = []
      for (const [pid, p] of cur.procs) {
        if (pid === self || p.ppid === self) continue // сам сбор сведений
        const before = prev?.procs?.get(pid)
        const cpu = before && elapsed > 0 && p.ticks >= before.ticks ? ((p.ticks - before.ticks) / info.clk / elapsed) * 100 : null
        list.push({ pid, name: p.name, cpu, mem: p.rss * info.page })
      }
      processes = list.length
      top = list
        .sort((a, b) => (b.cpu ?? -1) - (a.cpu ?? -1) || b.mem - a.mem)
        .slice(0, 40)
    }

    const whoCount = num(firstLine(sec.get('who')) ?? undefined)
    const uptime = num(firstLine(sec.get('uptime2') ?? sec.get('uptime'))?.split(/\s+/)[0])
    return {
      at: Date.now(),
      mode,
      info: { hostname: info.hostname, os: info.os, kernel: info.kernel, arch: info.arch, cpuModel: info.cpuModel, cores: info.cores, virt: info.virt },
      uptime,
      load: load && load.length === 3 && load.every(Number.isFinite) ? [load[0], load[1], load[2]] : null,
      cpu: cpuPercent(prev?.cpu ?? null, cur.cpu),
      ...parseMem(sec.get('mem')),
      disks: parseDf(sec.get('df')),
      net,
      users: full ? whoCount : null,
      processes,
      top,
      docker: full ? parseDocker(sec.get('docker')) : null
    }
  }

  /** Выполнить скрипт отдельным каналом: `sh -s`, скрипт — через stdin. */
  private run(script: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.client.exec('sh -s', (err, stream) => {
        if (err) {
          reject(new Error(`Сервер не разрешает выполнять команды: ${err.message}`))
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        let finished = false
        const done = (fn: () => void) => {
          if (finished) return
          finished = true
          clearTimeout(timer)
          fn()
        }
        const timer = setTimeout(() => {
          done(() => reject(new Error('Сервер не ответил вовремя.')))
          stream.close()
        }, TIMEOUT)
        stream.on('data', (d: Buffer) => {
          size += d.length
          if (size <= MAX_OUTPUT) chunks.push(d)
        })
        stream.stderr.on('data', () => undefined)
        stream.on('error', (e: Error) => done(() => reject(e)))
        stream.on('close', () => done(() => resolve(Buffer.concat(chunks).toString('utf8'))))
        stream.end(script)
      })
    })
  }
}
