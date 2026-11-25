// Одно SSH-подключение с интерактивной оболочкой.
//
// Модуль не зависит от Electron: всё внешнее (секреты, известные ключи, вопросы
// пользователю, события) передаётся через SshDeps. Поэтому он целиком покрыт
// интеграционными тестами с настоящим SSH-сервером.
//
// Основные свойства:
//  • таймаут TCP-подключения и SSH-рукопожатия — свои, и они ставятся на паузу,
//    пока пользователь отвечает на вопрос (ключ сервера, пароль);
//  • ключ сервера проверяется по сохранённым ключам Termion и ~/.ssh/known_hosts;
//  • порядок входа: агент / ключи → сохранённый пароль → запрос пароля (до 3 попыток);
//  • пароль и фраза-пароль сохраняются только после успешного входа;
//  • вывод терминала пачкуется и ограничивается по объёму неподтверждённых данных
//    (flow control), чтобы огромный вывод не подвешивал окно.

import { promises as fs } from 'node:fs'
import net from 'node:net'
import {
  Client,
  type AnyAuthMethod,
  type AuthenticationType,
  type ClientChannel,
  type ConnectConfig,
  type ParsedKey,
  type Prompt
} from 'ssh2'
import type { ConnInfo, ConnState, NoticeLevel, PromptPayload, PromptResponse, SessionNode } from '@shared/types'
import { ConnectError, describeError } from './errors'
import { describeHostKey, keyTypeLabel, preferredHostKeyOrder, type HostKeyInfo } from './hostkey'
import { defaultKeyPaths, describeKeyProblem, displayPath, expandHome, parsePrivateKey } from './keys'
import type { OpenSshVerdict } from './opensshKnownHosts'
import type { KnownKey } from '../store/knownHosts'

export interface SshSecrets {
  readonly canStore: boolean
  getPassword(sessionId: string): string | null
  setPassword(sessionId: string, password: string | null): Promise<void>
  getPassphrase(keyPath: string): string | null
  setPassphrase(keyPath: string, passphrase: string | null): Promise<void>
}

export interface SshKnownHosts {
  lookup(host: string, port: number): KnownKey[]
  remember(host: string, port: number, entry: Omit<KnownKey, 'addedAt'>): Promise<void>
}

export interface SshEvents {
  data(chunk: Buffer): void
  state(state: ConnState): void
  notice(level: NoticeLevel, text: string): void
  info(info: ConnInfo): void
}

export interface SshTimeouts {
  connect: number
  handshake: number
  keepaliveInterval: number
  keepaliveCountMax: number
}

export interface SshDeps {
  secrets: SshSecrets
  knownHosts: SshKnownHosts
  checkOpenSsh(host: string, port: number, keyType: string, keyBase64: string): Promise<OpenSshVerdict>
  /** Задать вопрос пользователю. Промис отклоняется, если подключение закрыли. */
  prompt(payload: PromptPayload): Promise<PromptResponse>
  events: SshEvents
  homeDir: string
  /** Путь к ssh-agent или null, если агент не запущен. */
  findAgent(): string | null
  timeouts?: Partial<SshTimeouts>
}

export const DEFAULT_TIMEOUTS: SshTimeouts = {
  connect: 15_000,
  handshake: 30_000,
  keepaliveInterval: 15_000,
  keepaliveCountMax: 4
}

/** Сколько байт может уйти в окно без подтверждения, прежде чем чтение с сервера приостановится. */
export const FLOW_HIGH_WATER = 1024 * 1024
export const FLOW_LOW_WATER = 256 * 1024
const MAX_MESSAGE = 256 * 1024
const MAX_PASSWORD_PROMPTS = 3
const MAX_PASSPHRASE_PROMPTS = 3

type AuthStep =
  | { method: 'none' }
  | { method: 'agent' }
  | { method: 'publickey'; keyPath: string; passphraseToSave: string | null }
  | { method: 'password' | 'keyboard-interactive'; password: string; save: boolean; fromStore: boolean }

interface KeyCandidate {
  path: string
  key: ParsedKey
  passphraseToSave: string | null
}

const stopAuth = false as unknown as AuthenticationType

export class SshSession {
  private readonly t: SshTimeouts
  private client: Client | null = null
  private sock: net.Socket | null = null
  private stream: ClientChannel | null = null
  private state: ConnState | null = null
  private disposed = false
  private ready = false
  private finished = false

  private cols: number
  private rows: number

  // вывод и flow control
  private pending: Buffer[] = []
  private pendingBytes = 0
  private flushScheduled = false
  private unacked = 0
  private paused = false

  // сторожевой таймер подключения
  private watchdog: NodeJS.Timeout | null = null
  private watchdogPhase: 'connect' | 'handshake' | null = null
  private watchdogPauses = 0

  // вход
  private triedNone = false
  private agentTried = false
  private keyQueue: KeyCandidate[] | null = null
  private savedPasswordTried = false
  private passwordPrompts = 0
  private passwordFailed = false
  private lastStep: AuthStep | null = null
  private failure: ConnectError | null = null
  private hostKey: HostKeyInfo | null = null

  constructor(
    readonly connId: string,
    private readonly session: SessionNode,
    private readonly deps: SshDeps,
    size: { cols: number; rows: number }
  ) {
    this.t = { ...DEFAULT_TIMEOUTS, ...deps.timeouts }
    this.cols = size.cols
    this.rows = size.rows
  }

  get currentState(): ConnState {
    return this.state ?? 'connecting'
  }

  get isActive(): boolean {
    return !this.finished && !this.disposed
  }

  /** Клиент ssh2 после успешного входа — через него открываются SFTP-каналы. */
  get readyClient(): Client | null {
    return this.ready && !this.finished && !this.disposed ? this.client : null
  }

  start(): void {
    const { host, port, username } = this.session
    this.setState('connecting')
    this.notice('info', `Подключение к ${formatTarget(host, port)} как ${username}…`)
    this.armWatchdog('connect')
    const sock = net.connect({ host, port })
    this.sock = sock
    sock.setNoDelay(true)
    sock.once('connect', () => {
      if (this.disposed || this.finished) return
      sock.setKeepAlive(true, 30_000)
      this.armWatchdog('handshake')
      this.startSsh(sock)
    })
    sock.once('error', (err) => {
      // После передачи сокета в ssh2 ошибки приходят через клиент.
      if (!this.client) this.fail(err)
    })
  }

  write(data: string | Buffer): void {
    if (this.stream && this.state === 'connected') this.stream.write(data)
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    if (this.stream && this.state === 'connected') this.stream.setWindow(rows, cols, 0, 0)
  }

  /** Окно подтверждает, что отрисовало bytes байт. */
  ack(bytes: number): void {
    this.unacked = Math.max(0, this.unacked - bytes)
    if (this.paused && this.unacked <= FLOW_LOW_WATER) {
      this.paused = false
      this.stream?.resume()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearWatchdog()
    const client = this.client
    if (client) {
      try {
        client.end()
      } catch {
        // уже закрыт
      }
      setTimeout(() => client.destroy(), 1500).unref()
    } else {
      this.sock?.destroy()
    }
  }

  // ---------- подключение ----------

  private startSsh(sock: net.Socket): void {
    const { host, port, username } = this.session
    const client = new Client()
    this.client = client
    const order = preferredHostKeyOrder(this.deps.knownHosts.lookup(host, port).map((k) => k.keyType))
    const config: ConnectConfig = {
      sock,
      username,
      readyTimeout: 0, // свой сторожевой таймер (см. armWatchdog)
      keepaliveInterval: this.t.keepaliveInterval,
      keepaliveCountMax: this.t.keepaliveCountMax,
      hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
        this.verifyHostKey(key).then(verify, (err) => {
          this.failure ??= err instanceof ConnectError ? err : null
          verify(false)
        })
      },
      authHandler: (methodsLeft, partial, next) => {
        this.nextAuth(methodsLeft as AuthenticationType[] | null, !!partial).then(next, (err) => {
          this.failure ??= err instanceof ConnectError ? err : new ConnectError('Вход отменён.', 'cancelled')
          next(stopAuth)
        })
      }
    }
    if (order) config.algorithms = { serverHostKey: order as NonNullable<ConnectConfig['algorithms']>['serverHostKey'] }

    client.on('banner', (message: string) => {
      const text = message.replace(/\r?\n$/, '')
      if (text) this.emitData(Buffer.from(text.replace(/\r?\n/g, '\r\n') + '\r\n', 'utf8'))
    })
    client.on('ready', () => this.onReady())
    client.on('error', (err) => this.fail(err))
    client.on('close', () => this.onClose())
    try {
      client.connect(config)
    } catch (err) {
      this.fail(err)
    }
  }

  private async verifyHostKey(blob: Buffer): Promise<boolean> {
    const { host, port } = this.session
    const info = describeHostKey(blob)
    this.hostKey = info
    this.touchWatchdog()
    const entry = { keyType: info.keyType, key: info.base64, fingerprint: info.fingerprint }
    const known = this.deps.knownHosts.lookup(host, port).find((k) => k.keyType === info.keyType)

    if (known && known.key === info.base64) return true

    if (known) {
      return this.confirmChangedKey(info, keyTypeLabel(known.keyType), known.fingerprint, 'termion', entry)
    }

    const system = await this.deps.checkOpenSsh(host, port, info.keyType, info.base64)
    if (system.status === 'match') {
      await this.deps.knownHosts.remember(host, port, entry)
      this.notice('info', `Ключ сервера найден в ~/.ssh/known_hosts (${info.label})`)
      return true
    }
    if (system.status === 'revoked') {
      throw new ConnectError('Ключ сервера отозван в ~/.ssh/known_hosts — подключение запрещено.', 'hostkey-rejected')
    }
    if (system.status === 'mismatch') {
      return this.confirmChangedKey(info, keyTypeLabel(system.keyType), system.fingerprint, 'openssh', entry)
    }

    const answer = await this.ask({ kind: 'hostkey-new', host, port, keyType: info.label, fingerprint: info.fingerprint })
    if (answer.kind !== 'hostkey' || !answer.accept) {
      throw new ConnectError('Подключение отменено: ключ сервера не подтверждён.', 'hostkey-rejected')
    }
    await this.deps.knownHosts.remember(host, port, entry)
    this.notice('info', `Ключ сервера сохранён: ${info.label} ${info.fingerprint}`)
    return true
  }

  private async confirmChangedKey(
    info: HostKeyInfo,
    knownLabel: string,
    knownFingerprint: string,
    source: 'termion' | 'openssh',
    entry: Omit<KnownKey, 'addedAt'>
  ): Promise<boolean> {
    const { host, port } = this.session
    this.notice('warn', 'Внимание: ключ сервера отличается от сохранённого!')
    const answer = await this.ask({
      kind: 'hostkey-changed',
      host,
      port,
      keyType: info.label,
      fingerprint: info.fingerprint,
      knownKeyType: knownLabel,
      knownFingerprint,
      source
    })
    if (answer.kind !== 'hostkey' || !answer.accept) {
      throw new ConnectError('Подключение отменено: ключ сервера изменился и не был подтверждён.', 'hostkey-rejected')
    }
    await this.deps.knownHosts.remember(host, port, entry)
    this.notice('warn', `Новый ключ сервера сохранён: ${info.label} ${info.fingerprint}`)
    return true
  }

  // ---------- вход ----------

  private async nextAuth(methodsLeft: AuthenticationType[] | null, partial: boolean): Promise<AnyAuthMethod> {
    this.touchWatchdog()
    const { username } = this.session
    // При частичном успехе (двухфакторный вход) предыдущий шаг сработал — сервер просит ещё один.
    if (partial) this.lastStep = null
    else this.reportFailedStep()

    if (!this.triedNone) {
      // Пустая попытка: сервер в ответ сообщает, какие способы входа он принимает.
      this.triedNone = true
      this.setState('authenticating')
      this.lastStep = { method: 'none' }
      return { type: 'none', username }
    }
    const allowed = new Set(methodsLeft ?? [])

    if (this.session.auth === 'agent' && !this.agentTried && allowed.has('publickey')) {
      this.agentTried = true
      const agent = this.deps.findAgent()
      if (agent) {
        this.lastStep = { method: 'agent' }
        return { type: 'agent', username, agent }
      }
      this.notice('warn', 'ssh-agent не запущен (служба «OpenSSH Authentication Agent»).')
    }

    if (this.session.auth === 'key' && allowed.has('publickey')) {
      this.keyQueue ??= await this.loadKeys()
      const candidate = this.keyQueue.shift()
      if (candidate) {
        this.lastStep = { method: 'publickey', keyPath: candidate.path, passphraseToSave: candidate.passphraseToSave }
        return { type: 'publickey', username, key: candidate.key }
      }
    }

    const canPassword = allowed.has('password')
    const canKeyboard = allowed.has('keyboard-interactive')
    if (canPassword || canKeyboard) {
      const secret = await this.obtainPassword()
      if (!secret) throw new ConnectError('Вход отменён.', 'cancelled')
      const method = canPassword ? 'password' : 'keyboard-interactive'
      this.lastStep = { method, ...secret }
      if (canPassword) return { type: 'password', username, password: secret.password }
      let usedPassword = false
      return {
        type: 'keyboard-interactive',
        username,
        prompt: (title: string, instructions: string, _lang: string, prompts: Prompt[], finish: (a: string[]) => void) => {
          this.answerKeyboard(title, instructions, prompts, usedPassword ? null : secret.password).then(
            (answers) => {
              usedPassword = true
              finish(answers)
            },
            () => {
              this.failure ??= new ConnectError('Вход отменён.', 'cancelled')
              this.client?.end()
            }
          )
        }
      }
    }

    if (allowed.size && !allowed.has('publickey') && this.session.auth !== 'password') {
      throw new ConnectError('Сервер не принимает вход по ключу, а другие способы недоступны.', 'no-methods')
    }
    if (allowed.size && !canPassword && !canKeyboard && this.session.auth === 'password') {
      throw new ConnectError('Сервер не принимает вход по паролю — нужен SSH-ключ.', 'no-methods')
    }
    throw new ConnectError(this.noMoreMethodsMessage(), 'no-methods')
  }

  private noMoreMethodsMessage(): string {
    if (this.session.auth === 'key') return 'Не удалось войти: сервер не принял ключ, а вход по паролю отключён.'
    if (this.session.auth === 'agent') return 'Не удалось войти: сервер не принял ключи из ssh-agent.'
    return 'Не удалось войти: сервер не принял ни один способ входа.'
  }

  /** Сообщает о неудаче предыдущего шага (если он был). */
  private reportFailedStep(): void {
    const step = this.lastStep
    if (!step) return
    this.lastStep = null
    switch (step.method) {
      case 'publickey':
        this.notice('warn', `Ключ ${displayPath(step.keyPath, this.deps.homeDir)} не подошёл.`)
        break
      case 'agent':
        this.notice('warn', 'Ключи из ssh-agent не подошли.')
        break
      case 'password':
      case 'keyboard-interactive':
        this.passwordFailed = true
        this.notice('warn', step.fromStore ? 'Сохранённый пароль не подошёл.' : 'Неверный пароль.')
        break
    }
  }

  private async obtainPassword(): Promise<{ password: string; save: boolean; fromStore: boolean } | null> {
    if (!this.savedPasswordTried) {
      this.savedPasswordTried = true
      const saved = this.deps.secrets.getPassword(this.session.id)
      if (saved !== null) return { password: saved, save: false, fromStore: true }
    }
    if (this.passwordPrompts >= MAX_PASSWORD_PROMPTS) {
      throw new ConnectError('Не удалось войти: пароль не подошёл три раза подряд.', 'no-methods')
    }
    this.passwordPrompts++
    const { host, port, username } = this.session
    const answer = await this.ask({
      kind: 'password',
      host,
      port,
      username,
      retry: this.passwordFailed,
      canSave: this.deps.secrets.canStore
    })
    if (answer.kind !== 'secret' || answer.value === null) return null
    return { password: answer.value, save: answer.save && this.deps.secrets.canStore, fromStore: false }
  }

  private async answerKeyboard(title: string, instructions: string, prompts: Prompt[], password: string | null): Promise<string[]> {
    if (!prompts.length) return []
    const looksLikePassword = (p: Prompt) => !p.echo && /pass|парол/i.test(p.prompt)
    if (password !== null && prompts.length === 1 && looksLikePassword(prompts[0])) return [password]
    const { host, username } = this.session
    const answer = await this.ask({
      kind: 'keyboard-interactive',
      host,
      username,
      title: title.trim(),
      instructions: instructions.trim(),
      fields: prompts.map((p) => ({ label: p.prompt.trim(), echo: !!p.echo }))
    })
    if (answer.kind !== 'answers' || !answer.values) throw new ConnectError('Вход отменён.', 'cancelled')
    return prompts.map((_, i) => answer.values?.[i] ?? '')
  }

  private async loadKeys(): Promise<KeyCandidate[]> {
    const home = this.deps.homeDir
    const explicit = this.session.keyPath ? expandHome(this.session.keyPath, home) : null
    const paths = explicit ? [explicit] : defaultKeyPaths(home)
    const out: KeyCandidate[] = []
    for (const path of paths) {
      let data: Buffer
      try {
        data = await fs.readFile(path)
      } catch {
        if (explicit) this.notice('error', `Не удалось прочитать файл ключа ${path}.`)
        continue
      }
      let result = parsePrivateKey(data)
      let passphraseToSave: string | null = null
      if (!result.ok && result.reason === 'encrypted') {
        const saved = this.deps.secrets.getPassphrase(path)
        if (saved !== null) result = parsePrivateKey(data, saved)
        let prompts = 0
        while (!result.ok && (result.reason === 'encrypted' || result.reason === 'bad-passphrase') && prompts < MAX_PASSPHRASE_PROMPTS) {
          prompts++
          const answer = await this.ask({
            kind: 'passphrase',
            keyPath: displayPath(path, home),
            retry: result.reason === 'bad-passphrase',
            canSave: this.deps.secrets.canStore
          })
          if (answer.kind !== 'secret' || answer.value === null) break
          result = parsePrivateKey(data, answer.value)
          if (result.ok && answer.save && this.deps.secrets.canStore) passphraseToSave = answer.value
        }
      }
      if (!result.ok) {
        this.notice('warn', `Ключ ${displayPath(path, home)} пропущен: ${describeKeyProblem(result)}.`)
        continue
      }
      out.push({ path, key: result.key, passphraseToSave })
    }
    if (!out.length && !explicit) this.notice('warn', 'В ~/.ssh нет ключей id_ed25519, id_ecdsa или id_rsa.')
    return out
  }

  // ---------- работа ----------

  private onReady(): void {
    this.clearWatchdog()
    this.ready = true
    const step = this.lastStep
    this.lastStep = null
    this.persistSecrets(step)
    this.deps.events.info({
      hostKeyType: this.hostKey?.label ?? '',
      fingerprint: this.hostKey?.fingerprint ?? '',
      authMethod: describeStep(step, this.deps.homeDir)
    })
    this.notice('success', `Вход выполнен: ${describeStep(step, this.deps.homeDir)}`)
    const client = this.client
    if (!client) return
    client.shell({ term: 'xterm-256color', cols: this.cols, rows: this.rows, width: 0, height: 0 }, (err, stream) => {
      if (err) {
        this.fail(err)
        return
      }
      if (this.disposed) {
        stream.close()
        return
      }
      this.stream = stream
      this.setState('connected')
      stream.on('data', (chunk: Buffer) => this.emitData(chunk))
      stream.stderr.on('data', (chunk: Buffer) => this.emitData(chunk))
      stream.on('close', () => {
        this.stream = null
        client.end()
      })
    })
  }

  private persistSecrets(step: AuthStep | null): void {
    if (!step) return
    const save = (job: Promise<void>, ok: string) =>
      job.then(
        () => this.notice('info', ok),
        () => this.notice('warn', 'Не удалось сохранить секрет — в следующий раз его спросят снова.')
      )
    if ((step.method === 'password' || step.method === 'keyboard-interactive') && step.save && !step.fromStore) {
      void save(this.deps.secrets.setPassword(this.session.id, step.password), 'Пароль сохранён в защищённом хранилище Windows.')
    }
    if (step.method === 'publickey' && step.passphraseToSave) {
      void save(this.deps.secrets.setPassphrase(step.keyPath, step.passphraseToSave), 'Фраза-пароль ключа сохранена.')
    }
  }

  private emitData(chunk: Buffer): void {
    if (this.disposed) return
    this.pending.push(chunk)
    this.pendingBytes += chunk.length
    this.unacked += chunk.length
    if (!this.paused && this.stream && this.unacked > FLOW_HIGH_WATER) {
      this.paused = true
      this.stream.pause()
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
    for (let offset = 0; offset < all.length; offset += MAX_MESSAGE) {
      this.deps.events.data(all.subarray(offset, offset + MAX_MESSAGE))
    }
  }

  private onClose(): void {
    this.clearWatchdog()
    this.flush()
    if (this.disposed || this.finished) return
    if (!this.ready) {
      this.fail(this.failure ?? new Error('Соединение закрыто сервером до входа.'))
      return
    }
    this.finished = true
    this.notice('info', 'Соединение закрыто.')
    this.setState('closed')
  }

  private fail(err: unknown): void {
    if (this.disposed || this.finished) return
    this.finished = true
    this.clearWatchdog()
    this.flush()
    const { host, port } = this.session
    const reason = this.failure && !(err instanceof ConnectError) && /authentication methods failed|verification failed/i.test(String((err as Error)?.message))
      ? this.failure
      : err
    this.notice('error', describeError(reason, host, port))
    this.setState('failed')
    const client = this.client
    if (client) {
      try {
        client.end()
      } catch {
        // уже закрыт
      }
      setTimeout(() => client.destroy(), 1000).unref()
    } else {
      this.sock?.destroy()
    }
  }

  // ---------- вопросы пользователю и таймеры ----------

  private async ask(payload: PromptPayload): Promise<PromptResponse> {
    this.pauseWatchdog()
    try {
      return await this.deps.prompt(payload)
    } finally {
      this.resumeWatchdog()
    }
  }

  private armWatchdog(phase: 'connect' | 'handshake'): void {
    this.clearWatchdog()
    this.watchdogPhase = phase
    if (this.watchdogPauses === 0) this.startWatchdogTimer()
  }

  private startWatchdogTimer(): void {
    if (this.watchdog) clearTimeout(this.watchdog)
    const phase = this.watchdogPhase
    if (!phase) return
    const ms = phase === 'connect' ? this.t.connect : this.t.handshake
    this.watchdog = setTimeout(() => {
      this.watchdog = null
      const seconds = Math.round(ms / 1000)
      const { host, port } = this.session
      const error =
        phase === 'connect'
          ? new ConnectError(`Сервер ${formatTarget(host, port)} не ответил за ${seconds} с.`, 'connect-timeout')
          : new ConnectError(`Сервер не завершил SSH-рукопожатие за ${seconds} с.`, 'handshake-timeout')
      this.failure = error
      this.fail(error)
    }, ms)
  }

  private touchWatchdog(): void {
    if (this.watchdogPhase && this.watchdogPauses === 0) this.startWatchdogTimer()
  }

  private pauseWatchdog(): void {
    this.watchdogPauses++
    if (this.watchdog) {
      clearTimeout(this.watchdog)
      this.watchdog = null
    }
  }

  private resumeWatchdog(): void {
    this.watchdogPauses = Math.max(0, this.watchdogPauses - 1)
    if (this.watchdogPauses === 0 && this.watchdogPhase && !this.finished && !this.disposed) this.startWatchdogTimer()
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog)
    this.watchdog = null
    this.watchdogPhase = null
  }

  private setState(state: ConnState): void {
    if (this.state === state) return
    this.state = state
    if (!this.disposed) this.deps.events.state(state)
  }

  private notice(level: NoticeLevel, text: string): void {
    if (!this.disposed) this.deps.events.notice(level, text)
  }
}

function formatTarget(host: string, port: number): string {
  const h = host.includes(':') ? `[${host}]` : host
  return port === 22 ? h : `${h}:${port}`
}

function describeStep(step: AuthStep | null, homeDir: string): string {
  switch (step?.method) {
    case 'publickey':
      return `ключ ${displayPath(step.keyPath, homeDir)}`
    case 'agent':
      return 'ssh-agent'
    case 'password':
      return 'пароль'
    case 'keyboard-interactive':
      return 'пароль (keyboard-interactive)'
    case 'none':
      return 'без пароля'
    default:
      return 'неизвестно'
  }
}
