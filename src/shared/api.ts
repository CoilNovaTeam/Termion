// Контракт API, который preload выставляет в окно как window.termion.

import type {
  AppInfo,
  LocalOpenRequest,
  LocalShell,
  Macro,
  PromptRequest,
  PromptResponse,
  ReadTextResult,
  RemoteEntry,
  SaveTextRequest,
  SaveTextResult,
  SecretStatus,
  Settings,
  SshDataEvent,
  SshInfoEvent,
  SshNoticeEvent,
  ServerStats,
  SshStateEvent,
  StatsMode,
  TransferJob,
  TreeNode,
  UploadSource
} from './types'

export type Unsubscribe = () => void

/** Что откроется при закрытии программы: активные SSH-подключения и терминалы компьютера. */
export interface CloseInfo {
  connections: number
  locals: number
}

export interface ConnectRequest {
  /** Идентификатор задаёт окно, чтобы связать вкладку с подключением до первых событий. */
  connId: string
  sessionId: string
  cols: number
  rows: number
}

export interface TermionApi {
  app: {
    info(): Promise<AppInfo>
    openDataDir(): Promise<void>
    openExternal(url: string): Promise<void>
    /** Показать файл в Проводнике. */
    showInFolder(path: string): Promise<void>
    /**
     * Перед закрытием окна главный процесс спрашивает интерфейс. Обработчик может показать
     * своё окно (несохранённые файлы, активные подключения) и вернуть false, чтобы отменить закрытие.
     */
    onBeforeClose(cb: (info: CloseInfo) => Promise<boolean>): Unsubscribe
  }
  sessions: {
    load(): Promise<TreeNode[]>
    save(tree: TreeNode[]): Promise<void>
  }
  macros: {
    load(): Promise<Macro[]>
    save(macros: Macro[]): Promise<void>
  }
  secrets: {
    status(sessionId: string): Promise<SecretStatus>
    /** null — удалить сохранённый пароль. */
    setPassword(sessionId: string, password: string | null): Promise<void>
  }
  settings: {
    load(): Promise<Settings>
    save(settings: Settings): Promise<void>
  }
  dialogs: {
    pickKeyFile(): Promise<string | null>
  }
  clipboard: {
    readText(): Promise<string>
    writeText(text: string): void
  }
  local: {
    /** Установленные оболочки: PowerShell, CMD, Git Bash, WSL… (refresh — искать заново). */
    shells(refresh?: boolean): Promise<LocalShell[]>
    /** Открыть терминал компьютера. Дальше он работает как подключение: ssh.write, resize, ack, disconnect. */
    open(req: LocalOpenRequest): Promise<void>
  }
  ssh: {
    connect(req: ConnectRequest): Promise<void>
    write(connId: string, data: string, binary?: boolean): void
    resize(connId: string, cols: number, rows: number): void
    ack(connId: string, bytes: number): void
    disconnect(connId: string): void
    /** Сбросить все подключения окна (после перезагрузки интерфейса). */
    reset(): Promise<void>
    /** Сведения о сервере: нагрузка, память, диски, сеть (только чтение). */
    stats(connId: string, mode: StatsMode): Promise<ServerStats>
    respond(promptId: string, response: PromptResponse): void
    onData(cb: (e: SshDataEvent) => void): Unsubscribe
    onState(cb: (e: SshStateEvent) => void): Unsubscribe
    onNotice(cb: (e: SshNoticeEvent) => void): Unsubscribe
    onInfo(cb: (e: SshInfoEvent) => void): Unsubscribe
    onPrompt(cb: (e: PromptRequest) => void): Unsubscribe
    onPromptCancel(cb: (promptId: string) => void): Unsubscribe
  }
  sftp: {
    home(connId: string): Promise<string>
    list(connId: string, path: string): Promise<RemoteEntry[]>
    stat(connId: string, path: string): Promise<RemoteEntry>
    readText(connId: string, path: string): Promise<ReadTextResult>
    writeText(req: SaveTextRequest): Promise<SaveTextResult>
    mkdir(connId: string, path: string): Promise<void>
    createFile(connId: string, path: string): Promise<void>
    rename(connId: string, from: string, to: string): Promise<void>
    remove(connId: string, path: string): Promise<void>
    /** Скачать на компьютер. Возвращает id передачи или null, если пользователь отменил выбор папки. */
    download(connId: string, paths: string[]): Promise<string | null>
    /** Загрузить на сервер в папку remoteDir. */
    upload(connId: string, remoteDir: string, source: UploadSource): Promise<string | null>
    cancelTransfer(jobId: string): void
    onTransfer(cb: (job: TransferJob) => void): Unsubscribe
  }
  files: {
    /** Путь к файлу, перетащенному из Проводника. */
    pathForFile(file: File): string
    /**
     * Перетаскивание из дерева в Проводник: окно ставит в перетаскивание ссылку
     * termion-dl://get/<token>/<имя>, а главный процесс отдаёт по ней файл с сервера
     * (или zip, если перетаскивают папку либо несколько объектов), когда Проводник попросит.
     */
    registerDragOut(token: string, connId: string, paths: string[], title: string): void
  }
}
