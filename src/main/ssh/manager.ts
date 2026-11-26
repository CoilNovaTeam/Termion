// Менеджер подключений: создаёт SSH-сессии по запросу окна, пересылает события
// и вопросы пользователю, принимает ответы, даёт доступ к файлам (SFTP) и передачам.
// Все данные из окна проверяются.

import { IPC } from '@shared/ipc'
import type { PromptPayload, PromptResponse, ServerStats, SessionNode, StatsMode } from '@shared/types'
import { newId } from '@shared/tree'
import { LIMITS, isValidId } from '@shared/validate'
import { LocalTerminal } from '../local/localTerminal'
import type { ShellSpec } from '../local/shells'
import { RemoteFs, RemoteFsError } from './remoteFs'
import { ServerProbe } from './serverStats'
import { SshSession, type SshDeps } from './session'
import { TransferManager } from './transfers'

/** Получатель событий — окно (WebContents). Интерфейс упрощён для тестов. */
export interface Owner {
  readonly id: number
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

export interface ManagerDeps extends Omit<SshDeps, 'prompt' | 'events'> {
  findSession(id: string): SessionNode | null
}

/** То, что умеет и SSH-сессия, и терминал компьютера. */
interface Terminal {
  readonly isActive: boolean
  start(): void
  write(data: string | Buffer): void
  resize(cols: number, rows: number): void
  ack(bytes: number): void
  dispose(): void
}

interface Connection {
  term: Terminal
  /** null — терминал компьютера (файлов сервера и сведений о сервере у него нет). */
  ssh: SshSession | null
  owner: Owner
  fs: RemoteFs | null
  transfers: TransferManager | null
  probe: ServerProbe | null
}

interface PendingPrompt {
  connId: string
  owner: Owner
  kind: PromptPayload['kind']
  resolve(response: PromptResponse): void
  reject(err: Error): void
}

const MAX_WRITE = 4 * 1024 * 1024
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

const clampSize = (n: unknown, min: number, max: number, fallback: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback

export class ConnectionManager {
  private readonly conns = new Map<string, Connection>()
  private readonly prompts = new Map<string, PendingPrompt>()

  constructor(private readonly deps: ManagerDeps) {}

  connect(owner: Owner, connId: unknown, sessionId: unknown, cols: unknown, rows: unknown): void {
    if (!isValidId(connId) || this.conns.has(connId)) throw new Error('Некорректный идентификатор подключения.')
    if (!isValidId(sessionId)) throw new Error('Некорректный идентификатор сессии.')
    const session = this.deps.findSession(sessionId)
    if (!session) throw new Error('Сессия не найдена — возможно, её удалили.')

    const send = (channel: string, payload: unknown) => {
      if (!owner.isDestroyed()) owner.send(channel, payload)
    }
    const { findSession: _ignored, ...sshDeps } = this.deps
    const conn: Connection = { term: null as unknown as Terminal, ssh: null, owner, fs: null, transfers: null, probe: null }
    const ssh = new SshSession(
      connId,
      session,
      {
        ...sshDeps,
        prompt: (payload) => this.ask(owner, connId, payload),
        events: {
          data: (chunk) => send(IPC.evSshData, { connId, data: chunk }),
          state: (state) => {
            if (state === 'connected') this.attachFiles(connId, conn, send)
            send(IPC.evSshState, { connId, state })
            if (state === 'closed' || state === 'failed') this.release(connId)
          },
          notice: (level, text) => send(IPC.evSshNotice, { connId, level, text }),
          info: (info) => send(IPC.evSshInfo, { connId, info })
        }
      },
      { cols: clampSize(cols, 2, 2000, 80), rows: clampSize(rows, 1, 1000, 24) }
    )
    conn.ssh = ssh
    conn.term = ssh
    this.conns.set(connId, conn)
    ssh.start()
  }

  /** Терминал компьютера: события те же, что у SSH, поэтому окну всё равно, что внутри. */
  openLocal(owner: Owner, connId: unknown, shell: ShellSpec, cols: unknown, rows: unknown): void {
    if (!isValidId(connId) || this.conns.has(connId)) throw new Error('Некорректный идентификатор подключения.')
    const send = (channel: string, payload: unknown) => {
      if (!owner.isDestroyed()) owner.send(channel, payload)
    }
    const term = new LocalTerminal(
      shell,
      {
        data: (chunk) => send(IPC.evSshData, { connId, data: chunk }),
        state: (state) => {
          send(IPC.evSshState, { connId, state })
          if (state === 'closed' || state === 'failed') this.release(connId)
        },
        notice: (level, text) => send(IPC.evSshNotice, { connId, level, text })
      },
      { cols: clampSize(cols, 2, 2000, 80), rows: clampSize(rows, 1, 1000, 24) }
    )
    this.conns.set(connId, { term, ssh: null, owner, fs: null, transfers: null, probe: null })
    term.start()
  }

  write(ownerId: number, connId: unknown, data: unknown, binary: unknown): void {
    const conn = this.get(ownerId, connId)
    if (!conn || typeof data !== 'string' || !data.length || data.length > MAX_WRITE) return
    conn.term.write(binary === true ? Buffer.from(data, 'latin1') : data)
  }

  resize(ownerId: number, connId: unknown, cols: unknown, rows: unknown): void {
    const conn = this.get(ownerId, connId)
    if (!conn) return
    conn.term.resize(clampSize(cols, 2, 2000, 80), clampSize(rows, 1, 1000, 24))
  }

  ack(ownerId: number, connId: unknown, bytes: unknown): void {
    const conn = this.get(ownerId, connId)
    if (!conn || typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return
    conn.term.ack(bytes)
  }

  disconnect(ownerId: number, connId: unknown): void {
    const conn = this.get(ownerId, connId)
    if (!conn) return
    conn.term.dispose()
    this.release(connId as string)
  }

  /** Закрыть все подключения окна (окно перезагрузилось или закрывается). */
  disposeOwner(ownerId: number): void {
    for (const [connId, conn] of this.conns) {
      if (conn.owner.id !== ownerId) continue
      conn.term.dispose()
      this.release(connId)
    }
  }

  disposeAll(): void {
    for (const [connId, conn] of this.conns) {
      conn.term.dispose()
      this.release(connId)
    }
  }

  /** Сколько открыто SSH-подключений и терминалов компьютера (для вопроса при выходе). */
  activeCount(): { connections: number; locals: number } {
    let connections = 0
    let locals = 0
    for (const conn of this.conns.values()) {
      if (!conn.term.isActive) continue
      if (conn.ssh) connections++
      else locals++
    }
    return { connections, locals }
  }

  /** Файлы сервера для подключения (только для своего окна и только после входа). */
  remoteFs(ownerId: number, connId: unknown): RemoteFs {
    const conn = this.get(ownerId, connId)
    if (!conn?.fs) throw new RemoteFsError('Нет подключения к серверу.', 'failed')
    return conn.fs
  }

  transfers(ownerId: number, connId: unknown): TransferManager {
    const conn = this.get(ownerId, connId)
    if (!conn?.transfers) throw new RemoteFsError('Нет подключения к серверу.', 'failed')
    return conn.transfers
  }

  /** Сведения о сервере (отдельный канал того же подключения, только чтение). */
  stats(ownerId: number, connId: unknown, mode: StatsMode): Promise<ServerStats> {
    const conn = this.get(ownerId, connId)
    const client = conn?.ssh?.readyClient
    if (!conn || !client) return Promise.reject(new Error('Нет подключения к серверу.'))
    conn.probe ??= new ServerProbe(client)
    return conn.probe.sample(mode)
  }

  cancelTransfer(ownerId: number, jobId: unknown): void {
    if (typeof jobId !== 'string') return
    for (const conn of this.conns.values()) {
      if (conn.owner.id === ownerId && conn.transfers?.cancel(jobId)) return
    }
  }

  respond(ownerId: number, promptId: unknown, raw: unknown): void {
    if (typeof promptId !== 'string') return
    const pending = this.prompts.get(promptId)
    if (!pending || pending.owner.id !== ownerId) return
    this.prompts.delete(promptId)
    pending.resolve(sanitizeResponse(pending.kind, raw))
  }

  private attachFiles(connId: string, conn: Connection, send: (channel: string, payload: unknown) => void): void {
    const client = conn.ssh?.readyClient
    if (!client || conn.fs) return
    conn.fs = new RemoteFs(client)
    conn.transfers = new TransferManager(connId, conn.fs, (job) => send(IPC.evTransfer, job))
  }

  private ask(owner: Owner, connId: string, payload: PromptPayload): Promise<PromptResponse> {
    if (owner.isDestroyed() || !this.conns.has(connId)) return Promise.reject(new Error('cancelled'))
    const promptId = newId()
    return new Promise<PromptResponse>((resolve, reject) => {
      this.prompts.set(promptId, { connId, owner, kind: payload.kind, resolve, reject })
      owner.send(IPC.evSshPrompt, { ...payload, promptId, connId })
    })
  }

  private get(ownerId: number, connId: unknown): Connection | null {
    if (typeof connId !== 'string') return null
    const conn = this.conns.get(connId)
    return conn && conn.owner.id === ownerId ? conn : null
  }

  private release(connId: string): void {
    const conn = this.conns.get(connId)
    if (conn) {
      conn.transfers?.cancelAll()
      conn.fs?.dispose()
    }
    this.conns.delete(connId)
    for (const [promptId, pending] of this.prompts) {
      if (pending.connId !== connId) continue
      this.prompts.delete(promptId)
      pending.reject(new Error('cancelled'))
      if (!pending.owner.isDestroyed()) pending.owner.send(IPC.evSshPromptCancel, promptId)
    }
  }
}

function sanitizeResponse(kind: PromptPayload['kind'], raw: unknown): PromptResponse {
  const r = isRecord(raw) ? raw : {}
  const text = (v: unknown): string | null => (typeof v === 'string' && v.length <= LIMITS.passwordLength ? v : null)
  switch (kind) {
    case 'hostkey-new':
    case 'hostkey-changed':
      return { kind: 'hostkey', accept: r.accept === true }
    case 'password':
    case 'passphrase':
      return { kind: 'secret', value: text(r.value), save: r.save === true }
    case 'keyboard-interactive': {
      if (!Array.isArray(r.values) || r.values.length > 32) return { kind: 'answers', values: null }
      const values = r.values.map(text)
      return { kind: 'answers', values: values.every((v) => v !== null) ? (values as string[]) : null }
    }
  }
}
