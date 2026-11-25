// Сведения о сервере: индикаторы в строке состояния и подробная сводка по щелчку.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DiskUsage, ServerStats } from '@shared/types'
import { dockerStatus, formatDecimal, formatPair, formatRate, formatSize, formatUptime, plural } from '../format'
import { copyText } from '../store/actions'
import { useApp } from '../store/app'
import { activeServerTab, closeServerPanel, FULL_MS, refreshServer, toggleServerPanel } from '../store/monitor'
import { Icon } from './Icon'

const tone = (pct: number) => (pct >= 90 ? 'err' : pct >= 75 ? 'warn' : '')
const diskPct = (d: DiskUsage) => (d.used + d.avail > 0 ? (d.used / (d.used + d.avail)) * 100 : 0)
const memUsed = (s: ServerStats) => (s.mem ? s.mem.total - s.mem.available : 0)

const VIRT: Record<string, string> = {
  kvm: 'KVM',
  qemu: 'QEMU',
  openvz: 'OpenVZ',
  lxc: 'LXC',
  'lxc-libvirt': 'LXC',
  vmware: 'VMware',
  microsoft: 'Hyper-V',
  xen: 'Xen',
  oracle: 'VirtualBox',
  docker: 'Docker',
  podman: 'Podman',
  wsl: 'WSL',
  amazon: 'AWS',
  google: 'Google Cloud'
}

/** Корневой диск — его и показываем в строке состояния. */
const rootDisk = (s: ServerStats) => s.disks.find((d) => d.mount === '/') ?? s.disks[0]

function Bar({ pct }: { pct: number }) {
  const p = Math.max(0, Math.min(100, pct))
  return (
    <span className={`gauge ${tone(p)}`}>
      <i style={{ width: `${p}%` }} />
    </span>
  )
}

// ---------- строка состояния ----------

export function ServerMeters({ connId }: { connId: string }) {
  const stats = useApp((s) => s.stats[connId])
  const open = useApp((s) => s.serverPanel)
  if (!stats) return null
  const disk = rootDisk(stats)
  const used = memUsed(stats)
  const tip = [
    stats.cpu !== null ? `Процессор: ${Math.round(stats.cpu)} %` : null,
    stats.mem ? `Память: ${formatPair(used, stats.mem.total)} (доступно ${formatSize(stats.mem.available)})` : null,
    disk ? `Диск ${disk.mount}: свободно ${formatSize(disk.avail)} из ${formatSize(disk.total)}` : null,
    'Щёлкните — подробные сведения о сервере'
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <button className={`st st-btn meters${open ? ' on' : ''}`} title={tip} onClick={toggleServerPanel}>
      {stats.cpu !== null && (
        <span className="meter">
          <span className="m-label">ЦП</span>
          <Bar pct={stats.cpu} />
          <span className="m-val">{Math.round(stats.cpu)}%</span>
        </span>
      )}
      {stats.mem && (
        <span className="meter">
          <span className="m-label">ОЗУ</span>
          <Bar pct={(used / stats.mem.total) * 100} />
          <span className="m-val">{formatPair(used, stats.mem.total)}</span>
        </span>
      )}
      {disk && (
        <span className="meter">
          <span className="m-label">{disk.mount === '/' ? 'Диск' : disk.mount}</span>
          <Bar pct={diskPct(disk)} />
          <span className="m-val">своб. {formatSize(disk.avail)}</span>
        </span>
      )}
    </button>
  )
}

// ---------- сводка ----------

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="srv-sec">
      <div className="srv-sec-head">
        <h5>{title}</h5>
        {aside && <span className="srv-aside">{aside}</span>}
      </div>
      {children}
    </section>
  )
}

function Row({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="srv-row" title={title}>
      <span className="srv-k">{label}</span>
      <span className="srv-v">{children}</span>
    </div>
  )
}

function Meter({ label, pct, value, sub, mono }: { label: string; pct: number; value: string; sub?: string; mono?: boolean }) {
  return (
    <div className="srv-meter">
      <div className="srv-meter-top">
        <span className={`srv-k${mono ? ' mono' : ''}`} title={label}>
          {label}
        </span>
        <span className="srv-v">{value}</span>
        <span className={`srv-pct ${tone(pct)}`}>{Math.round(pct)}%</span>
      </div>
      <Bar pct={pct} />
      {sub && <div className="srv-sub">{sub}</div>}
    </div>
  )
}

/** График загрузки процессора за последние минуты. */
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null
  const w = 100
  const h = 30
  const step = w / (values.length - 1)
  const pts = values.map((v, i) => `${(i * step).toFixed(2)},${(h - (Math.min(100, Math.max(0, v)) / 100) * (h - 2) - 1).toFixed(2)}`)
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <polygon points={`0,${h} ${pts.join(' ')} ${w},${h}`} className="spark-fill" />
      <polyline points={pts.join(' ')} className="spark-line" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function Processes({ stats }: { stats: ServerStats }) {
  const [by, setBy] = useState<'cpu' | 'mem'>('cpu')
  const top = stats.top ?? []
  const sorted = useMemo(
    () => [...top].sort((a, b) => (by === 'cpu' ? (b.cpu ?? -1) - (a.cpu ?? -1) || b.mem - a.mem : b.mem - a.mem)).slice(0, 8),
    [top, by]
  )
  return (
    <Section
      title="Процессы"
      aside={
        <span className="seg mini">
          <button className={by === 'cpu' ? 'on' : ''} onClick={() => setBy('cpu')}>
            по ЦП
          </button>
          <button className={by === 'mem' ? 'on' : ''} onClick={() => setBy('mem')}>
            по памяти
          </button>
        </span>
      }
    >
      <div className="srv-procs">
        {sorted.map((p) => (
          <div key={p.pid} className="srv-proc" title={`PID ${p.pid}`}>
            <span className="pn mono">{p.name}</span>
            <span className={`pc ${by === 'cpu' ? 'strong' : ''}`}>{p.cpu === null ? '—' : `${formatDecimal(p.cpu, 1)}%`}</span>
            <span className={`pm ${by === 'mem' ? 'strong' : ''}`}>{formatSize(p.mem)}</span>
          </div>
        ))}
        {!sorted.length && <div className="srv-muted">Нет сведений</div>}
      </div>
      {stats.processes !== null && (
        <div className="srv-muted small">
          Всего {stats.processes} {plural(stats.processes, 'процесс', 'процесса', 'процессов')} · % ЦП — от одного ядра, как в top
        </div>
      )}
    </Section>
  )
}

function Body({ stats, history }: { stats: ServerStats; history: number[] }) {
  const { info } = stats
  const used = memUsed(stats)
  return (
    <>
      <Section title="Система">
        {info.hostname && <Row label="Имя">{info.hostname}</Row>}
        {info.kernel && (
          <Row label="Ядро">
            {info.kernel}
            {info.arch ? ` · ${info.arch}` : ''}
          </Row>
        )}
        {info.virt && <Row label="Виртуализация">{VIRT[info.virt] ?? info.virt}</Row>}
        {stats.uptime !== null && <Row label="Работает">{formatUptime(stats.uptime)}</Row>}
        {stats.users !== null && stats.users > 0 && <Row label="В системе">{`${stats.users} ${plural(stats.users, 'сеанс', 'сеанса', 'сеансов')}`}</Row>}
      </Section>

      <Section title="Процессор" aside={info.cores ? `${info.cores} ${plural(info.cores, 'ядро', 'ядра', 'ядер')}` : undefined}>
        {info.cpuModel && <div className="srv-model">{info.cpuModel}</div>}
        {stats.cpu !== null ? (
          <Meter label="Загрузка" pct={stats.cpu} value="" />
        ) : (
          <div className="srv-muted">Загрузка считается…</div>
        )}
        <Sparkline values={history} />
        {stats.load && (
          <Row label="Средняя нагрузка" title="Среднее число задач в очереди за 1, 5 и 15 минут. Больше числа ядер — сервер не успевает.">
            {stats.load.map((l) => formatDecimal(l)).join(' · ')}
          </Row>
        )}
      </Section>

      {stats.mem && (
        <Section title="Память">
          <Meter label="ОЗУ" pct={(used / stats.mem.total) * 100} value={formatPair(used, stats.mem.total)} sub={`доступно ${formatSize(stats.mem.available)}`} />
          {stats.swap && (
            <Meter label="Подкачка" pct={((stats.swap.total - stats.swap.free) / stats.swap.total) * 100} value={formatPair(stats.swap.total - stats.swap.free, stats.swap.total)} />
          )}
        </Section>
      )}

      {stats.disks.length > 0 && (
        <Section title="Диски">
          {stats.disks.map((d) => (
            <Meter key={d.mount} label={d.mount} mono pct={diskPct(d)} value={`свободно ${formatSize(d.avail)} из ${formatSize(d.total)}`} />
          ))}
        </Section>
      )}

      {stats.net.length > 0 && (
        <Section title="Сеть">
          {stats.net.map((n) => (
            <div key={n.name} className="srv-net" title={`Всего: принято ${formatSize(n.rxTotal)}, отправлено ${formatSize(n.txTotal)}`}>
              <div className="srv-net-top">
                <b className="mono">{n.name}</b>
                <span className="srv-rate">
                  <Icon name="download" size={12} />
                  {formatRate(n.rxRate)}
                </span>
                <span className="srv-rate">
                  <Icon name="upload" size={12} />
                  {formatRate(n.txRate)}
                </span>
              </div>
              {n.addrs.length > 0 && (
                <div className="srv-addrs">
                  {n.addrs.map((a) => (
                    <button key={a} className="srv-addr mono" title="Скопировать адрес" onClick={() => copyText(a, 'Адрес скопирован')}>
                      {a}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </Section>
      )}

      {stats.top ? <Processes stats={stats} /> : null}

      {stats.docker && (
        <Section title="Docker" aside={`${stats.docker.length} ${plural(stats.docker.length, 'контейнер', 'контейнера', 'контейнеров')}`}>
          {stats.docker.map((c) => {
            const st = dockerStatus(c.status)
            return (
              <div key={c.name} className="srv-ct" title={`${c.image}\n${c.status}`}>
                <i className={`dot ${st.tone}`} />
                <span className="cn">{c.name}</span>
                <span className="cs">{st.text}</span>
              </div>
            )
          })}
          {!stats.docker.length && <div className="srv-muted">Нет запущенных контейнеров</div>}
        </Section>
      )}
    </>
  )
}

export function ServerPanel() {
  const open = useApp((s) => s.serverPanel)
  const tab = useApp(() => activeServerTab())
  const connId = tab?.connId ?? null
  const stats = useApp((s) => (connId ? s.stats[connId] : undefined))
  const error = useApp((s) => (connId ? s.statsErrors[connId] : undefined))
  const history = useApp((s) => (connId ? s.cpuHistory[connId] : undefined))
  const ref = useRef<HTMLDivElement>(null)

  // Нет подключённого сервера на экране — закрываемся.
  useEffect(() => {
    if (open && !tab) closeServerPanel()
  }, [open, tab])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (ref.current?.contains(target) || (target as HTMLElement).closest?.('.meters')) return
      closeServerPanel()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      closeServerPanel()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  if (!open || !tab) return null
  const detailed = stats?.mode === 'full'
  return (
    <div className="srv-pop" ref={ref} role="dialog" aria-label="Сведения о сервере">
      <div className="srv-head">
        <span className="srv-ic">
          <Icon name="server" />
        </span>
        <div className="srv-title">
          <b>{tab.title}</b>
          <span>{stats?.info.os ?? `${tab.username}@${tab.host}`}</span>
        </div>
        <button className="icon-btn" title="Обновить сейчас" onClick={refreshServer}>
          <Icon name="refresh" />
        </button>
        <button className="icon-btn" title="Закрыть (Esc)" onClick={closeServerPanel}>
          <Icon name="x" />
        </button>
      </div>
      <div className="srv-body">
        {error && !stats && (
          <div className="srv-empty">
            <Icon name="warn" size={22} />
            <p>{error}</p>
            <button className="btn sm" onClick={refreshServer}>
              <Icon name="refresh" />
              Повторить
            </button>
          </div>
        )}
        {!error && !stats && (
          <div className="srv-empty">
            <Icon name="refresh" className="spin" size={22} />
            <p>Собираю сведения о сервере…</p>
          </div>
        )}
        {stats && <Body stats={stats} history={history ?? []} />}
        {stats && !detailed && (
          <div className="srv-empty small">
            <Icon name="refresh" className="spin" size={16} />
            <p>Загружаю процессы и адреса…</p>
          </div>
        )}
      </div>
      <div className="srv-foot">
        Обновляется каждые {formatDecimal(FULL_MS / 1000, 1).replace(',0', '')} с · только чтение: /proc, df, ip, docker ps
      </div>
    </div>
  )
}
