import { create } from 'zustand'
import type {
  AppInfo,
  AuthMethod,
  ConnInfo,
  ConnState,
  EolId,
  PromptRequest,
  RemoteEntry,
  RemoteFileMeta,
  ServerStats,
  Settings,
  TextEncodingId,
  TransferJob,
  TreeNode
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/validate'
import type { IconName } from '../components/Icon'
import type { LanguageInfo } from '../editor/languages'

export type TabState = ConnState | 'idle'

export interface TerminalTab {
  kind: 'terminal'
  id: string
  sessionId: string
  title: string
  connId: string | null
  state: TabState
  info: ConnInfo | null
  /** Снимок параметров сессии на момент подключения (для строки состояния). */
  host: string
  port: number
  username: string
  auth: AuthMethod
  cols: number
  rows: number
  /** Текущая папка оболочки (по заголовку окна или OSC 7), если сервер её сообщает. */
  cwd: string | null
}

export interface EditorTab {
  kind: 'editor'
  id: string
  /** Вкладка-терминал, через подключение которой открыт файл. */
  ownerId: string
  path: string
  title: string
  status: 'loading' | 'ready' | 'error'
  error: string | null
  /** Почему файл нельзя открыть в редакторе (тогда предлагается скачать). */
  problem: 'too-large' | 'binary' | null
  /** Есть несохранённые изменения: в тексте или в кодировке/окончаниях строк. */
  dirty: boolean
  /** Текст отличается от сохранённого. */
  docDirty: boolean
  saving: boolean
  /** Размер и время изменения файла на сервере при открытии или последнем сохранении. */
  meta: RemoteFileMeta | null
  encoding: TextEncodingId
  eol: EolId
  savedEncoding: TextEncodingId
  savedEol: EolId
  language: LanguageInfo
  line: number
  col: number
  lines: number
}

export type Tab = TerminalTab | EditorTab

export type FileEdit = { mode: 'newfile' | 'newdir'; parent: string } | { mode: 'rename'; path: string }

/** Дерево файлов сервера для одной вкладки-терминала. */
export interface FilesView {
  home: string | null
  root: string | null
  listings: Record<string, RemoteEntry[]>
  expanded: Record<string, boolean>
  loading: Record<string, boolean>
  errors: Record<string, string>
  /** Выделенные пути (можно несколько: Ctrl+щелчок, Shift+щелчок). */
  selection: string[]
  /** Курсор: элемент, с которым работают клавиши (F2, Enter, стрелки). */
  cursor: string | null
  /** Откуда считается диапазон при Shift+щелчке. */
  anchor: string | null
  editing: FileEdit | null
  /** Ошибка всей панели (например, на сервере выключен SFTP). */
  error: string | null
}

export type DialogState =
  | { type: 'session'; editId: string | null; parentId: string | null }
  | { type: 'folder'; editId: string | null; parentId: string | null }
  | {
      type: 'confirm'
      title: string
      message: string
      confirmLabel: string
      danger?: boolean
      onConfirm: () => void | Promise<void>
    }
  | { type: 'settings' }
  /** Несохранённые файлы перед закрытием вкладок. */
  | { type: 'unsaved'; dirtyIds: string[]; closeIds: string[] }
  /** Файл изменили или удалили на сервере после открытия. */
  | { type: 'conflict'; tabId: string; conflict: 'changed' | 'deleted' }
  /** Закрытие программы с активными подключениями или несохранёнными файлами. */
  | { type: 'close-app'; connections: number; dirtyIds: string[] }
  /** Перемещение файлов перетаскиванием внутри дерева. */
  | { type: 'move'; tabId: string; paths: string[]; dir: string }

export interface MenuItem {
  label: string
  icon?: IconName
  hint?: string
  danger?: boolean
  disabled?: boolean
  checked?: boolean
  onSelect: () => void
}

export type MenuEntry = MenuItem | 'separator'

export interface MenuState {
  x: number
  y: number
  items: MenuEntry[]
}

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'success' | 'error'
}

export interface AppState {
  ready: boolean
  info: AppInfo | null
  settings: Settings
  tree: TreeNode[]
  selectedId: string | null
  filter: string
  /** Какая панель открыта слева в раскладке «Как в MobaXterm». */
  side: 'sessions' | 'files'
  tabs: Tab[]
  activeTabId: string | null
  files: Record<string, FilesView>
  transfers: TransferJob[]
  /** Сведения о серверах — по подключениям (connId). */
  stats: Record<string, ServerStats>
  statsErrors: Record<string, string>
  /** Последние значения загрузки процессора — для графика в сводке. */
  cpuHistory: Record<string, number[]>
  /** Открыта ли сводка о сервере активной вкладки. */
  serverPanel: boolean
  prompts: PromptRequest[]
  dialog: DialogState | null
  menu: MenuState | null
  toasts: Toast[]
  /** Увеличивается, когда нужно поставить фокус в поиск сессий. */
  searchFocusToken: number
}

export const useApp = create<AppState>(() => ({
  ready: false,
  info: null,
  settings: structuredClone(DEFAULT_SETTINGS),
  tree: [],
  selectedId: null,
  filter: '',
  side: 'sessions',
  tabs: [],
  activeTabId: null,
  files: {},
  transfers: [],
  stats: {},
  statsErrors: {},
  cpuHistory: {},
  serverPanel: false,
  prompts: [],
  dialog: null,
  menu: null,
  toasts: [],
  searchFocusToken: 0
}))

export const getState = useApp.getState
export const setState = useApp.setState

export const isTerminal = (tab: Tab | undefined | null): tab is TerminalTab => tab?.kind === 'terminal'
export const isEditor = (tab: Tab | undefined | null): tab is EditorTab => tab?.kind === 'editor'

/** Вкладка-терминал, чьи файлы показывать: активная или владелец активного редактора. */
export function filesTabId(state: Pick<AppState, 'tabs' | 'activeTabId'>): string | null {
  const active = state.tabs.find((t) => t.id === state.activeTabId)
  if (!active) return null
  return active.kind === 'terminal' ? active.id : active.ownerId
}
