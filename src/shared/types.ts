// Общие типы данных Termion: используются главным процессом, preload и интерфейсом.

export type ThemeId = 'graphite' | 'classic' | 'light'
export type LayoutId = 'stacked' | 'classic' | 'ide'
export type AuthMethod = 'password' | 'key' | 'agent'
export type CursorStyle = 'block' | 'bar' | 'underline'
export type TerminalFont = 'cascadia' | 'jetbrains' | 'consolas'

/** Сохранённая SSH-сессия. Пароли и фразы ключей здесь не хранятся — только в зашифрованном хранилище. */
export interface SessionNode {
  type: 'session'
  id: string
  name: string
  host: string
  port: number
  username: string
  auth: AuthMethod
  /** Путь к приватному ключу. Пустая строка — стандартные ключи из ~/.ssh. */
  keyPath: string
  /** Макрос, который выполняется сразу после входа (id), или пусто. */
  onConnect?: string
}

export interface FolderNode {
  type: 'folder'
  id: string
  name: string
  expanded: boolean
  children: TreeNode[]
}

export type TreeNode = SessionNode | FolderNode

export interface TerminalSettings {
  font: TerminalFont
  fontSize: number
  lineHeight: number
  cursorStyle: CursorStyle
  cursorBlink: boolean
  scrollback: number
  copyOnSelect: boolean
  rightClickPaste: boolean
  /** Терминал компьютера по умолчанию (id оболочки); пусто — первый найденный. */
  defaultShell: string
}

// ---------- терминалы компьютера ----------

export type ShellKind = 'pwsh' | 'powershell' | 'cmd' | 'gitbash' | 'msys2' | 'cygwin' | 'wsl' | 'sh'

export interface LocalShell {
  /** pwsh, powershell, cmd, gitbash, wsl:Ubuntu… */
  id: string
  name: string
  kind: ShellKind
  /** Путь к программе — для подсказки. */
  path: string
}

export interface LocalOpenRequest {
  connId: string
  shellId: string
  cols: number
  rows: number
}

export interface FilesSettings {
  /** Показывать файлы и папки, начинающиеся с точки. */
  showHidden: boolean
  /** Дерево файлов переходит в папку, где сейчас находится терминал. */
  followTerminal: boolean
  /** Спрашивать перед перемещением файлов перетаскиванием. */
  confirmMove: boolean
}

export interface EditorSettings {
  wordWrap: boolean
}

export interface MacroSettings {
  /** Полоса макросов под терминалом. */
  showBar: boolean
}

export interface MonitorSettings {
  /** Нагрузка сервера (ЦП, память, диск) в строке состояния. */
  statusBar: boolean
}

export interface Settings {
  theme: ThemeId
  layout: LayoutId
  sidebarWidth: number
  terminal: TerminalSettings
  files: FilesSettings
  editor: EditorSettings
  monitor: MonitorSettings
  macros: MacroSettings
}

// ---------- макросы ----------

/** Где виден макрос (и где работает его горячая клавиша). */
export type MacroScope = { type: 'all' } | { type: 'local' } | { type: 'folder'; id: string } | { type: 'session'; id: string }

export interface Macro {
  id: string
  name: string
  /** Команды — по одной на строку. Макрос печатает их в терминал, как будто их ввели вручную. */
  commands: string
  /** Нажать Enter после последней строки (между строками Enter нажимается всегда). */
  enter: boolean
  /** Пауза между строками, мс (0 — без пауз). */
  delay: number
  scope: MacroScope
  /** Горячая клавиша («Ctrl+Alt+1») или пусто. */
  hotkey: string
}

// ---------- файлы на сервере (SFTP) ----------

export type RemoteEntryType = 'dir' | 'file' | 'link' | 'other'

export interface RemoteEntry {
  name: string
  path: string
  type: RemoteEntryType
  /** Для символических ссылок: тип того, на что ссылка указывает. */
  target?: 'dir' | 'file' | 'other' | 'broken'
  /** Для символических ссылок: куда указывает. */
  linkTo?: string
  size: number
  /** Время изменения, секунды Unix. */
  mtime: number
  mode: number
}

export interface RemoteFileMeta {
  mtime: number
  size: number
  mode: number
}

export type TextEncodingId = 'utf8' | 'utf8-bom' | 'cp1251'
export type EolId = 'lf' | 'crlf'

export type ReadTextResult =
  | { ok: true; text: string; encoding: TextEncodingId; eol: EolId; meta: RemoteFileMeta }
  | { ok: false; reason: 'too-large' | 'binary'; size: number }

export interface SaveTextRequest {
  connId: string
  path: string
  text: string
  encoding: TextEncodingId
  eol: EolId
  /** Каким файл был при открытии — для проверки, не изменил ли его кто-то другой. */
  expected: RemoteFileMeta | null
  /** Сохранить, даже если файл на сервере изменился. */
  force: boolean
}

export type SaveTextResult =
  | { ok: true; meta: RemoteFileMeta; atomic: boolean }
  | { ok: false; conflict: 'changed' | 'deleted' }

export type TransferState = 'preparing' | 'running' | 'done' | 'failed' | 'cancelled'

export interface TransferJob {
  id: string
  connId: string
  kind: 'upload' | 'download'
  title: string
  state: TransferState
  totalBytes: number
  doneBytes: number
  totalFiles: number
  doneFiles: number
  /** Сколько существующих файлов пропущено по выбору пользователя. */
  skipped: number
  error?: string
  /** Папка на сервере, куда шла загрузка (чтобы обновить её в дереве). */
  remoteDir?: string
  /** Куда сохранено на компьютере (для «Показать в папке»). */
  localPath?: string
  /** Передача для перетаскивания в Проводник: куда именно — знает только Проводник. */
  dragOut?: boolean
}

export type UploadSource = { kind: 'paths'; paths: string[] } | { kind: 'pick-files' } | { kind: 'pick-folder' }

export interface SecretStatus {
  hasPassword: boolean
  /** Можно ли вообще сохранять секреты (доступно ли шифрование Windows). */
  canStore: boolean
}

export interface AppInfo {
  version: string
  dataDir: string
  electron: string
  platform: string
  /** Сообщения, накопленные при запуске (например, восстановление повреждённого файла). */
  startupNotices: string[]
}

// ---------- SSH ----------

export type ConnState = 'connecting' | 'authenticating' | 'connected' | 'closed' | 'failed'

export type NoticeLevel = 'info' | 'success' | 'warn' | 'error'

export interface ConnInfo {
  hostKeyType: string
  fingerprint: string
  authMethod: string
}

export interface HostKeyNewPrompt {
  kind: 'hostkey-new'
  host: string
  port: number
  keyType: string
  fingerprint: string
}

export interface HostKeyChangedPrompt {
  kind: 'hostkey-changed'
  host: string
  port: number
  keyType: string
  fingerprint: string
  knownKeyType: string
  knownFingerprint: string
  /** Где хранился прежний ключ: в Termion или в ~/.ssh/known_hosts OpenSSH. */
  source: 'termion' | 'openssh'
}

export interface PasswordPrompt {
  kind: 'password'
  host: string
  port: number
  username: string
  /** Предыдущая попытка не удалась (неверный пароль). */
  retry: boolean
  canSave: boolean
}

export interface PassphrasePrompt {
  kind: 'passphrase'
  keyPath: string
  retry: boolean
  canSave: boolean
}

export interface KeyboardInteractivePrompt {
  kind: 'keyboard-interactive'
  host: string
  username: string
  title: string
  instructions: string
  fields: { label: string; echo: boolean }[]
}

export type PromptPayload =
  | HostKeyNewPrompt
  | HostKeyChangedPrompt
  | PasswordPrompt
  | PassphrasePrompt
  | KeyboardInteractivePrompt

export type PromptRequest = PromptPayload & { promptId: string; connId: string }

export type PromptResponse =
  | { kind: 'hostkey'; accept: boolean }
  | { kind: 'secret'; value: string | null; save: boolean }
  | { kind: 'answers'; values: string[] | null }

export interface SshDataEvent {
  connId: string
  data: Uint8Array
}

export interface SshStateEvent {
  connId: string
  state: ConnState
}

export interface SshNoticeEvent {
  connId: string
  level: NoticeLevel
  text: string
}

export interface SshInfoEvent {
  connId: string
  info: ConnInfo
}

// ---------- сведения о сервере ----------

/** light — для строки состояния, full — для подробной сводки (процессы, Docker, адреса). */
export type StatsMode = 'light' | 'full'

export interface ServerInfo {
  hostname: string | null
  /** «Ubuntu 24.04.1 LTS» из /etc/os-release. */
  os: string | null
  /** «Linux 6.8.0-45-generic». */
  kernel: string | null
  arch: string | null
  cpuModel: string | null
  cores: number | null
  /** Виртуализация (kvm, openvz, lxc…), если определяется. */
  virt: string | null
}

export interface DiskUsage {
  mount: string
  source: string
  /** Байты. */
  total: number
  used: number
  avail: number
}

export interface NetIface {
  name: string
  addrs: string[]
  /** Байт в секунду; null — пока неизвестно (нужен второй замер). */
  rxRate: number | null
  txRate: number | null
  rxTotal: number
  txTotal: number
}

export interface ProcessInfo {
  pid: number
  name: string
  /** % одного ядра (как в top); null — пока неизвестно. */
  cpu: number | null
  /** Память (RSS), байты. */
  mem: number
}

export interface ContainerInfo {
  name: string
  status: string
  image: string
}

export interface ServerStats {
  /** Когда сделан замер (время компьютера, мс). */
  at: number
  mode: StatsMode
  info: ServerInfo
  /** Секунды с загрузки. */
  uptime: number | null
  load: [number, number, number] | null
  /** Загрузка процессора, %. */
  cpu: number | null
  mem: { total: number; available: number } | null
  swap: { total: number; free: number } | null
  disks: DiskUsage[]
  net: NetIface[]
  /** Только в подробной сводке. */
  users: number | null
  processes: number | null
  top: ProcessInfo[] | null
  /** null — Docker не установлен или нет прав. */
  docker: ContainerInfo[] | null
}
