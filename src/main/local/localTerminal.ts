// Терминал компьютера (PowerShell, CMD, Git Bash, WSL…) через псевдотерминал Windows (ConPTY).
// Для окна он выглядит так же, как SSH-подключение: те же события данных и состояния,
// тот же контроль потока — огромный вывод не подвешивает окно.

import { homedir } from 'node:os'
import type { IPty } from 'node-pty'
import type { ConnState, NoticeLevel } from '@shared/types'
import type { ShellSpec } from './shells'

const HIGH_WATER = 1024 * 1024
const LOW_WATER = 256 * 1024
const MAX_MESSAGE = 256 * 1024

export interface LocalEvents {
  data(chunk: Buffer): void
  state(state: ConnState): void
  notice(level: NoticeLevel, text: string): void
}

type PtyModule = typeof import('node-pty')
let ptyModule: PtyModule | null = null

/** node-pty загружается при первом локальном терминале: SSH он не нужен. */
function pty(): PtyModule {
  ptyModule ??= require('node-pty') as PtyModule
  return ptyModule
}

export class LocalTerminal {
  private proc: IPty | null = null
  private state: ConnState | null = null
  private disposed = false
  private unacked = 0
  private paused = false
  private pending: Buffer[] = []
  private pendingBytes = 0
  private flushScheduled = false

  constructor(
    private readonly shell: ShellSpec,
    private readonly events: LocalEvents,
    private size: { cols: number; rows: number }
  ) {}

  get isActive(): boolean {
    return this.state === 'connected' || this.state === 'connecting'
  }

  start(): void {
    this.setState('connecting')
    try {
      this.proc = pty().spawn(this.shell.file, this.shell.args, {
        name: 'xterm-256color',
        cols: this.size.cols,
        rows: this.size.rows,
        cwd: homedir(),
        env: { ...process.env, ...this.shell.env, TERM_PROGRAM: 'Termion', COLORTERM: 'truecolor' } as Record<string, string>,
        // Свежий ConPTY из комплекта node-pty: лучше поддержка цветов и изменения размера.
        useConptyDll: process.platform === 'win32'
      })
    } catch (err) {
      this.events.notice('error', `Не удалось запустить ${this.shell.name}: ${err instanceof Error ? err.message : String(err)}`)
      this.setState('failed')
      return
    }
    this.proc.onData((text) => this.emitData(Buffer.from(text, 'utf8')))
    this.proc.onExit(({ exitCode }) => this.onExit(exitCode))
    this.setState('connected')
  }

  write(data: string | Buffer): void {
    if (this.disposed || !this.proc || this.state !== 'connected') return
    this.proc.write(typeof data === 'string' ? data : data.toString('latin1'))
  }

  resize(cols: number, rows: number): void {
    this.size = { cols, rows }
    if (this.disposed || !this.proc || this.state !== 'connected') return
    try {
      this.proc.resize(cols, rows)
    } catch {
      // процесс уже завершается
    }
  }

  ack(bytes: number): void {
    this.unacked = Math.max(0, this.unacked - bytes)
    if (this.paused && this.unacked <= LOW_WATER) {
      this.paused = false
      this.proc?.resume()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const proc = this.proc
    this.proc = null
    try {
      proc?.kill()
    } catch {
      // уже завершён
    }
  }

  private setState(state: ConnState): void {
    if (this.state === state) return
    this.state = state
    this.events.state(state)
  }

  private emitData(chunk: Buffer): void {
    if (this.disposed) return
    this.pending.push(chunk)
    this.pendingBytes += chunk.length
    this.unacked += chunk.length
    if (!this.paused && this.proc && this.unacked > HIGH_WATER) {
      this.paused = true
      this.proc.pause()
    }
    if (!this.flushScheduled) {
      this.flushScheduled = true
      setImmediate(() => this.flush())
    }
  }

  private flush(): void {
    this.flushScheduled = false
    if (!this.pendingBytes || this.disposed) {
      this.pending = []
      this.pendingBytes = 0
      return
    }
    const all = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending, this.pendingBytes)
    this.pending = []
    this.pendingBytes = 0
    for (let offset = 0; offset < all.length; offset += MAX_MESSAGE) this.events.data(all.subarray(offset, offset + MAX_MESSAGE))
  }

  private onExit(code: number): void {
    this.flush()
    if (this.disposed) return
    this.proc = null
    this.events.notice('info', code ? `Программа завершилась с кодом ${code}.` : 'Программа завершилась.')
    this.setState('closed')
  }
}
