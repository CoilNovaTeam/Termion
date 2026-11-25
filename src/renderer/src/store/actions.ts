// Действия интерфейса: дерево сессий, вкладки, подключения, настройки, окна и уведомления.
// Файлы на сервере — в files.ts, редактор — в editors.ts.

import type { AuthMethod, PromptResponse, SessionNode, Settings, TreeNode } from '@shared/types'
import { countSessions, findSession, insertNode, locate, moveNode, newId, removeNode, setAllExpanded, updateNode } from '@shared/tree'
import { api, errorText } from '../api'
import * as editors from '../editor/registry'
import * as terminals from '../terminal/registry'
import { getState, isEditor, isTerminal, setState, type DialogState, type MenuEntry, type Tab, type TerminalTab, type Toast } from './app'
import { onEditorCursor, onEditorDirty, saveEditor } from './editors'
import { dropFilesView, onCwd, onTerminalConnected, onTransfer } from './files'
import { forgetServer, startMonitor } from './monitor'

// ---------- уведомления, меню, окна ----------

let toastSeq = 0

export function toast(text: string, kind: Toast['kind'] = 'info', ms = 3200): void {
  const id = ++toastSeq
  setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, kind }] }))
  setTimeout(() => dismissToast(id), ms)
}

export function dismissToast(id: number): void {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

export function showMenu(x: number, y: number, items: MenuEntry[]): void {
  setState({ menu: { x, y, items } })
}

export function hideMenu(): void {
  if (getState().menu) setState({ menu: null })
}

export function openDialog(dialog: DialogState): void {
  setState({ dialog, menu: null })
}

export function closeDialog(): void {
  setState({ dialog: null })
  focusActive()
}

export function confirmAction(opts: Omit<Extract<DialogState, { type: 'confirm' }>, 'type'>): void {
  openDialog({ type: 'confirm', ...opts })
}

export function focusSearch(): void {
  setState((s) => ({ side: 'sessions', searchFocusToken: s.searchFocusToken + 1 }))
}

export function setSide(side: 'sessions' | 'files'): void {
  setState({ side })
}

export function copyText(text: string, what = 'Скопировано'): void {
  api.clipboard.writeText(text)
  toast(what, 'success', 1800)
}

/** Вернуть фокус в активную вкладку (терминал или редактор). */
export function focusActive(): void {
  const tab = getState().tabs.find((t) => t.id === getState().activeTabId)
  if (isTerminal(tab)) terminals.focus(tab.id)
  else if (isEditor(tab)) editors.focus(tab.id)
}

// ---------- настройки ----------

let settingsTimer: ReturnType<typeof setTimeout> | undefined

export function updateSettings(fn: (s: Settings) => Settings): void {
  const next = fn(getState().settings)
  setState({ settings: next })
  document.documentElement.dataset.theme = next.theme
  terminals.applySettings(next)
  editors.applySettings(next)
  clearTimeout(settingsTimer)
  settingsTimer = setTimeout(() => void saveSettings(), 350)
}

async function saveSettings(): Promise<void> {
  clearTimeout(settingsTimer)
  settingsTimer = undefined
  try {
    await api.settings.save(getState().settings)
  } catch (err) {
    toast(`Не удалось сохранить настройки: ${errorText(err)}`, 'error', 6000)
  }
}

// ---------- дерево сессий ----------

let savedTree: TreeNode[] = []
let treeTimer: ReturnType<typeof setTimeout> | undefined
let saving: Promise<void> = Promise.resolve()

/** Сохраняет текущее дерево. Записи идут строго по очереди. */
export function persistTree(): Promise<void> {
  clearTimeout(treeTimer)
  treeTimer = undefined
  saving = saving
    .catch(() => undefined)
    .then(async () => {
      const tree = getState().tree
      if (tree === savedTree) return
      try {
        await api.sessions.save(tree)
        savedTree = tree
      } catch (err) {
        toast(`Не удалось сохранить список сессий: ${errorText(err)}`, 'error', 6000)
        throw err
      }
    })
  return saving
}

/** now — сохранить сразу (структурные изменения), later — через полсекунды (раскрытие папок). */
async function setTree(next: TreeNode[], mode: 'now' | 'later' = 'now'): Promise<void> {
  const previous = getState().tree
  setState({ tree: next })
  if (mode === 'later') {
    clearTimeout(treeTimer)
    treeTimer = setTimeout(() => void persistTree().catch(() => undefined), 600)
    return
  }
  try {
    await persistTree()
  } catch (err) {
    setState({ tree: previous })
    throw err
  }
}

export function select(id: string | null): void {
  setState({ selectedId: id })
}

export function setFilter(filter: string): void {
  setState({ filter })
}

export interface SessionInput {
  name: string
  host: string
  port: number
  username: string
  auth: AuthMethod
  keyPath: string
}

export type PasswordChange = { kind: 'keep' } | { kind: 'set'; value: string } | { kind: 'clear' }

export async function saveSession(
  editId: string | null,
  parentId: string | null,
  input: SessionInput,
  password: PasswordChange
): Promise<string> {
  const tree = getState().tree
  let next: TreeNode[]
  let id: string
  if (editId) {
    const found = locate(tree, editId)
    if (!found || found.node.type !== 'session') throw new Error('Сессия не найдена.')
    id = editId
    next = updateNode(tree, editId, (n) => ({ ...(n as SessionNode), ...input }))
    if ((found.parent?.id ?? null) !== parentId) next = moveNode(next, editId, parentId)
  } else {
    id = newId()
    next = insertNode(tree, { type: 'session', id, ...input }, parentId)
  }
  if (parentId) next = updateNode(next, parentId, (n) => (n.type === 'folder' ? { ...n, expanded: true } : n))
  const oldName = editId ? findSession(tree, editId)?.name : undefined
  await setTree(next)
  if (password.kind === 'set') await api.secrets.setPassword(id, password.value)
  else if (password.kind === 'clear') await api.secrets.setPassword(id, null)
  // Открытые вкладки переименованной сессии получают новое имя (с сохранением «(2)», «(3)»…).
  if (oldName && oldName !== input.name) {
    setState((s) => ({
      tabs: s.tabs.map((t) =>
        isTerminal(t) && t.sessionId === id && (t.title === oldName || t.title.startsWith(`${oldName} (`))
          ? { ...t, title: input.name + t.title.slice(oldName.length) }
          : t
      )
    }))
  }
  setState({ selectedId: id })
  return id
}

export async function saveFolder(editId: string | null, parentId: string | null, name: string): Promise<string> {
  const tree = getState().tree
  if (editId) {
    await setTree(updateNode(tree, editId, (n) => ({ ...n, name })))
    return editId
  }
  const id = newId()
  let next = insertNode(tree, { type: 'folder', id, name, expanded: true, children: [] }, parentId)
  if (parentId) next = updateNode(next, parentId, (n) => (n.type === 'folder' ? { ...n, expanded: true } : n))
  await setTree(next)
  setState({ selectedId: id })
  return id
}

export function askDelete(id: string): void {
  const found = locate(getState().tree, id)
  if (!found) return
  const node = found.node
  const message =
    node.type === 'session'
      ? `Сессия «${node.name}» (${node.username}@${node.host}) будет удалена вместе с сохранённым паролем. Открытые вкладки останутся.`
      : node.children.length
        ? `Папка «${node.name}» будет удалена вместе со всем содержимым (сессий внутри: ${countSessions(node.children)}).`
        : `Пустая папка «${node.name}» будет удалена.`
  confirmAction({
    title: node.type === 'session' ? 'Удалить сессию?' : 'Удалить папку?',
    message,
    confirmLabel: 'Удалить',
    danger: true,
    onConfirm: async () => {
      const next = removeNode(getState().tree, id)
      await setTree(next)
      if (getState().selectedId === id) setState({ selectedId: found.parent?.id ?? null })
      toast(node.type === 'session' ? 'Сессия удалена' : 'Папка удалена', 'success')
    }
  })
}

export async function duplicateSession(id: string): Promise<void> {
  const found = locate(getState().tree, id)
  if (!found || found.node.type !== 'session') return
  const copy: SessionNode = { ...found.node, id: newId(), name: `${found.node.name} (копия)` }
  const siblings = found.parent ? found.parent.children : getState().tree
  const after = siblings[found.index + 1]?.id ?? null
  try {
    await setTree(insertNode(getState().tree, copy, found.parent?.id ?? null, after))
    setState({ selectedId: copy.id })
  } catch {
    // сообщение уже показано
  }
}

export function toggleFolder(id: string, expanded?: boolean): void {
  const tree = getState().tree
  void setTree(
    updateNode(tree, id, (n) => (n.type === 'folder' ? { ...n, expanded: expanded ?? !n.expanded } : n)),
    'later'
  )
}

export function setAllFolders(expanded: boolean): void {
  void setTree(setAllExpanded(getState().tree, expanded), 'later')
}

export async function moveTo(id: string, parentId: string | null, beforeId: string | null): Promise<void> {
  try {
    let next = moveNode(getState().tree, id, parentId, beforeId)
    if (parentId) next = updateNode(next, parentId, (n) => (n.type === 'folder' ? { ...n, expanded: true } : n))
    await setTree(next)
  } catch (err) {
    toast(errorText(err), 'error')
  }
}

// ---------- вкладки ----------

export const tabById = (id: string): Tab | undefined => getState().tabs.find((t) => t.id === id)
export const terminalTab = (id: string): TerminalTab | undefined => {
  const tab = tabById(id)
  return isTerminal(tab) ? tab : undefined
}
const tabByConn = (connId: string): TerminalTab | undefined =>
  getState().tabs.find((t): t is TerminalTab => isTerminal(t) && t.connId === connId)

export function patchTab<T extends Tab>(id: string, patch: Partial<T>): void {
  setState((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? ({ ...t, ...patch } as Tab) : t)) }))
}

export function isTabConnected(tabId: string): boolean {
  return terminalTab(tabId)?.state === 'connected'
}

/** Вставить вкладку сразу после активной. */
export function addTab(tab: Tab): void {
  setState((s) => {
    const index = s.tabs.findIndex((t) => t.id === s.activeTabId)
    const tabs = [...s.tabs]
    tabs.splice(index >= 0 ? index + 1 : tabs.length, 0, tab)
    return { tabs, activeTabId: tab.id, menu: null }
  })
}

/** Открывает новую вкладку для сессии (как двойной клик в MobaXterm). */
export function openSession(sessionId: string): void {
  const s = findSession(getState().tree, sessionId)
  if (!s) return
  const tabs = getState().tabs
  const same = tabs.filter((t) => isTerminal(t) && t.sessionId === sessionId).length
  const tab: TerminalTab = {
    kind: 'terminal',
    id: newId(),
    sessionId,
    title: same ? `${s.name} (${same + 1})` : s.name,
    connId: null,
    state: 'idle',
    info: null,
    host: s.host,
    port: s.port,
    username: s.username,
    auth: s.auth,
    cols: 0,
    rows: 0,
    cwd: null
  }
  setState({ tabs: [...tabs, tab], activeTabId: tab.id, selectedId: sessionId, menu: null })
}

/** Вызывается реестром терминалов, когда терминал на экране и знает свой размер. */
export async function connectTab(tabId: string): Promise<void> {
  const tab = terminalTab(tabId)
  if (!tab) return
  const s = findSession(getState().tree, tab.sessionId)
  if (!s) {
    terminals.notice(tabId, 'error', 'Эта сессия удалена из списка — подключиться нельзя.')
    patchTab<TerminalTab>(tabId, { state: 'failed' })
    terminals.setDisconnected(tabId, true)
    return
  }
  if (tab.connId) {
    api.ssh.disconnect(tab.connId)
    forgetServer(tab.connId)
  }
  const connId = newId()
  const { cols, rows } = terminals.size(tabId)
  terminals.bind(tabId, connId)
  patchTab<TerminalTab>(tabId, {
    connId,
    state: 'connecting',
    info: null,
    host: s.host,
    port: s.port,
    username: s.username,
    auth: s.auth,
    cols,
    rows
  })
  try {
    await persistTree() // главный процесс читает сессию из своей сохранённой копии
    await api.ssh.connect({ connId, sessionId: s.id, cols, rows })
  } catch (err) {
    terminals.notice(tabId, 'error', errorText(err))
    patchTab<TerminalTab>(tabId, { state: 'failed' })
    terminals.setDisconnected(tabId, true)
  }
}

export function reconnect(tabId: string): void {
  const tab = terminalTab(tabId)
  if (!tab || tab.state === 'connecting' || tab.state === 'authenticating') return
  terminals.beginReconnect(tabId)
  void connectTab(tabId)
}

export function disconnectTab(tabId: string): void {
  const tab = terminalTab(tabId)
  if (!tab?.connId || (tab.state !== 'connected' && tab.state !== 'connecting' && tab.state !== 'authenticating')) return
  api.ssh.disconnect(tab.connId)
  dropPrompts(tab.connId)
  forgetServer(tab.connId)
  patchTab<TerminalTab>(tabId, { state: 'closed' })
  terminals.notice(tabId, 'info', 'Отключено.')
  terminals.setDisconnected(tabId, true)
}

/** Отправить текст в терминал вкладки (для «Перейти сюда в терминале»). */
export function sendToTerminal(tabId: string, text: string): boolean {
  const tab = terminalTab(tabId)
  if (!tab?.connId || tab.state !== 'connected') return false
  api.ssh.write(tab.connId, text)
  return true
}

/**
 * Закрыть вкладки. Вместе с терминалом закрываются открытые через него файлы;
 * если среди закрываемого есть несохранённые файлы — сначала вопрос.
 */
export function closeTabs(ids: string[]): void {
  const tabs = getState().tabs
  const closing = new Set(ids)
  for (const t of tabs) if (isEditor(t) && closing.has(t.ownerId)) closing.add(t.id)
  const dirtyIds = tabs.filter((t) => isEditor(t) && t.dirty && closing.has(t.id)).map((t) => t.id)
  if (dirtyIds.length) {
    openDialog({ type: 'unsaved', dirtyIds, closeIds: [...closing] })
    return
  }
  closeTabsNow([...closing])
}

export function closeTab(tabId: string): void {
  closeTabs([tabId])
}

/** Закрыть без вопросов (после решения пользователя). */
export function closeTabsNow(ids: string[]): void {
  const { tabs, activeTabId } = getState()
  const closing = new Set(ids)
  for (const t of tabs) if (isEditor(t) && closing.has(t.ownerId)) closing.add(t.id)
  for (const t of tabs) {
    if (!closing.has(t.id)) continue
    if (isTerminal(t)) {
      if (t.connId) {
        api.ssh.disconnect(t.connId)
        dropPrompts(t.connId)
        forgetServer(t.connId)
      }
      terminals.dispose(t.id)
      dropFilesView(t.id)
    } else {
      editors.dispose(t.id)
    }
  }
  const index = tabs.findIndex((t) => t.id === activeTabId)
  const rest = tabs.filter((t) => !closing.has(t.id))
  let nextActive = activeTabId && !closing.has(activeTabId) ? activeTabId : null
  if (!nextActive && rest.length) {
    // ближайшая уцелевшая вкладка справа, иначе слева
    const after = tabs.slice(index + 1).find((t) => !closing.has(t.id))
    const before = [...tabs.slice(0, Math.max(0, index))].reverse().find((t) => !closing.has(t.id))
    nextActive = (after ?? before ?? rest[0]).id
  }
  setState({ tabs: rest, activeTabId: nextActive })
  focusActive()
}

export function closeOtherTabs(tabId: string): void {
  const tab = tabById(tabId)
  const keep = new Set([tabId])
  if (isEditor(tab)) keep.add(tab.ownerId) // файл без своего подключения не сохранить
  closeTabs(getState().tabs.filter((t) => !keep.has(t.id)).map((t) => t.id))
}

export function closeAllTabs(): void {
  closeTabs(getState().tabs.map((t) => t.id))
}

export function activateTab(tabId: string): void {
  const tab = tabById(tabId)
  if (!tab) return
  const sessionId = isTerminal(tab) ? tab.sessionId : terminalTab(tab.ownerId)?.sessionId
  setState({ activeTabId: tabId, ...(sessionId ? { selectedId: sessionId } : {}) })
  if (isTerminal(tab)) terminals.activate(tabId)
  else editors.focus(tabId)
}

export function cycleTab(direction: 1 | -1): void {
  const { tabs, activeTabId } = getState()
  if (tabs.length < 2) return
  const index = tabs.findIndex((t) => t.id === activeTabId)
  const next = tabs[(index + direction + tabs.length) % tabs.length]
  activateTab(next.id)
}

export function duplicateTab(tabId: string): void {
  const tab = terminalTab(tabId)
  if (tab) openSession(tab.sessionId)
}

// ---------- вопросы от SSH ----------

function dropPrompts(connId: string): void {
  setState((s) => ({ prompts: s.prompts.filter((p) => p.connId !== connId) }))
}

export function respondPrompt(promptId: string, response: PromptResponse): void {
  api.ssh.respond(promptId, response)
  setState((s) => ({ prompts: s.prompts.filter((p) => p.promptId !== promptId) }))
  focusActive()
}

// ---------- закрытие программы ----------

let closeResolver: ((proceed: boolean) => void) | null = null

/** Решение пользователя в окне «Закрыть Termion?». */
export async function resolveAppClose(choice: 'save' | 'discard' | 'cancel'): Promise<void> {
  const dialog = getState().dialog
  const dirtyIds = dialog?.type === 'close-app' ? dialog.dirtyIds : []
  if (choice === 'save') {
    for (const id of dirtyIds) {
      if (await saveEditor(id)) continue
      // Не сохранилось (ошибка или конфликт) — программа остаётся открытой, показываем файл.
      closeResolver?.(false)
      closeResolver = null
      if (getState().dialog === dialog) setState({ dialog: null })
      activateTab(id)
      return
    }
  }
  if (getState().dialog === dialog) setState({ dialog: null })
  closeResolver?.(choice !== 'cancel')
  closeResolver = null
  if (choice === 'cancel') focusActive()
}

async function beforeClose(info: { connections: number }): Promise<boolean> {
  await flushAll()
  const dirtyIds = getState().tabs.filter((t) => isEditor(t) && t.dirty).map((t) => t.id)
  if (!info.connections && !dirtyIds.length) return true
  closeResolver?.(false)
  return new Promise<boolean>((resolve) => {
    closeResolver = resolve
    setState({ dialog: { type: 'close-app', connections: info.connections, dirtyIds }, menu: null })
  })
}

// ---------- запуск ----------

export async function flushAll(): Promise<void> {
  if (settingsTimer) await saveSettings()
  await persistTree().catch(() => undefined)
}

export async function init(): Promise<void> {
  terminals.configure({
    settings: () => getState().settings,
    connect: (tabId) => void connectTab(tabId),
    reconnect,
    closeTab,
    isConnected: isTabConnected,
    onResize: (tabId, cols, rows) => patchTab<TerminalTab>(tabId, { cols, rows }),
    onCwd,
    showMenu
  })
  editors.configure({
    settings: () => getState().settings,
    onDirty: onEditorDirty,
    onCursor: onEditorCursor
  })

  api.ssh.onData(({ connId, data }) => terminals.write(connId, data))
  api.ssh.onState(({ connId, state }) => {
    const tab = tabByConn(connId)
    if (!tab) return
    patchTab<TerminalTab>(tab.id, { state })
    if (state === 'connected') void onTerminalConnected(tab.id)
    if (state === 'closed' || state === 'failed') {
      terminals.setDisconnected(tab.id, true)
      forgetServer(connId)
    }
  })
  api.ssh.onNotice(({ connId, level, text }) => {
    const tab = tabByConn(connId)
    if (tab) terminals.notice(tab.id, level, text)
  })
  api.ssh.onInfo(({ connId, info }) => {
    const tab = tabByConn(connId)
    if (tab) patchTab<TerminalTab>(tab.id, { info })
  })
  api.ssh.onPrompt((prompt) => setState((s) => ({ prompts: [...s.prompts, prompt] })))
  api.ssh.onPromptCancel((promptId) => setState((s) => ({ prompts: s.prompts.filter((p) => p.promptId !== promptId) })))
  api.sftp.onTransfer(onTransfer)
  api.app.onBeforeClose(beforeClose)
  startMonitor()

  // Окно могли перезагрузить — старые подключения этого окна больше не нужны.
  await api.ssh.reset().catch(() => undefined)
  const [info, settings, tree] = await Promise.all([api.app.info(), api.settings.load(), api.sessions.load()])
  savedTree = tree
  document.documentElement.dataset.theme = settings.theme
  setState({ ready: true, info, settings, tree })
  for (const text of info.startupNotices) toast(text, 'error', 15000)
}
