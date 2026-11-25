// Файлы на сервере: дерево папок для каждой вкладки-терминала, выделение, операции с файлами,
// перетаскивание и передачи. Всё идёт через SFTP того же подключения, что и терминал.

import { ancestry, baseName, canMoveInto, isWithin, joinPath, parentPath, rebase, safeLocalName, shellQuote, topLevel } from '@shared/remotePath'
import type { RemoteEntry, TransferJob, UploadSource } from '@shared/types'
import { checkFileName, normalizeRemotePath } from '@shared/validate'
import { api, errorText } from '../api'
import { plural } from '../format'
import { resolveCwd, type CwdHint } from '../terminal/cwd'
import {
  activateTab,
  closeDialog,
  closeTabsNow,
  confirmAction,
  openDialog,
  patchTab,
  sendToTerminal,
  setSide,
  tabById,
  terminalTab,
  toast,
  updateSettings
} from './actions'
import { filesTabId, getState, isEditor, isTerminal, setState, type EditorTab, type FilesView, type TerminalTab } from './app'
import { openFile } from './editors'

export const isDirLike = (e: RemoteEntry): boolean => e.type === 'dir' || (e.type === 'link' && e.target === 'dir')

const emptyView = (): FilesView => ({
  home: null,
  root: null,
  listings: {},
  expanded: {},
  loading: {},
  errors: {},
  selection: [],
  cursor: null,
  anchor: null,
  editing: null,
  error: null
})

/** Выделить один элемент (или снять выделение). */
const only = (path: string | null): Pick<FilesView, 'selection' | 'cursor' | 'anchor'> => ({
  selection: path ? [path] : [],
  cursor: path,
  anchor: path
})

export const viewOf = (tabId: string): FilesView | undefined => getState().files[tabId]

function patchView(tabId: string, fn: (v: FilesView) => Partial<FilesView>): void {
  setState((s) => {
    const v = s.files[tabId]
    return v ? { files: { ...s.files, [tabId]: { ...v, ...fn(v) } } } : s
  })
}

function omit<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map
  const out = { ...map }
  delete out[key]
  return out
}

/** Убрать ключ dir и всё, что лежит внутри него. */
function omitWithin<T>(map: Record<string, T>, dir: string): Record<string, T> {
  const keys = Object.keys(map).filter((k) => isWithin(k, dir))
  if (!keys.length) return map
  const out = { ...map }
  for (const k of keys) delete out[k]
  return out
}

/** Подключение вкладки, если оно сейчас активно. */
function liveConn(tabId: string): string | null {
  const tab = terminalTab(tabId)
  return tab?.state === 'connected' && tab.connId ? tab.connId : null
}

/** Ответ ещё нужен: вкладка на месте, и это то же подключение. */
const stillCurrent = (tabId: string, connId: string): boolean => terminalTab(tabId)?.connId === connId && !!viewOf(tabId)

export function findEntry(v: FilesView, path: string): RemoteEntry | undefined {
  return v.listings[parentPath(path)]?.find((e) => e.path === path)
}

/** Выделенные элементы, которые сейчас известны дереву (без вложенных в выделенные папки). */
export function selectedEntries(v: FilesView): RemoteEntry[] {
  return topLevel(v.selection)
    .map((p) => findEntry(v, p))
    .filter((e): e is RemoteEntry => !!e)
}

// ---------- загрузка папок ----------

async function loadDir(tabId: string, dir: string, quiet = false): Promise<boolean> {
  const connId = liveConn(tabId)
  if (!connId || !viewOf(tabId)) return false
  if (!quiet) patchView(tabId, (v) => ({ loading: { ...v.loading, [dir]: true } }))
  try {
    const entries = await api.sftp.list(connId, dir)
    if (!stillCurrent(tabId, connId)) return false
    patchView(tabId, (v) => {
      let listings = { ...v.listings, [dir]: entries }
      // Подпапки, которых больше нет, убираем из памяти вместе с содержимым.
      const alive = new Set(entries.filter(isDirLike).map((e) => e.path))
      for (const key of Object.keys(listings)) {
        if (key !== dir && parentPath(key) === dir && !alive.has(key)) listings = omitWithin(listings, key)
      }
      // Из выделения уходит то, чего в папке больше нет.
      const present = new Set(entries.map((e) => e.path))
      const gone = (p: string | null) => !!p && p !== dir && parentPath(p) === dir && !present.has(p)
      const selection = v.selection.filter((p) => !gone(p))
      return {
        listings,
        loading: omit(v.loading, dir),
        errors: omit(v.errors, dir),
        ...(selection.length !== v.selection.length || gone(v.cursor)
          ? { selection, cursor: gone(v.cursor) ? (selection[0] ?? null) : v.cursor, anchor: gone(v.anchor) ? null : v.anchor }
          : {})
      }
    })
    return true
  } catch (err) {
    if (!stillCurrent(tabId, connId)) return false
    patchView(tabId, (v) => ({
      listings: omitWithin(v.listings, dir),
      loading: omit(v.loading, dir),
      errors: { ...v.errors, [dir]: errorText(err) }
    }))
    return false
  }
}

/** Перечитать папку from (по умолчанию корень дерева) и все раскрытые папки внутри неё. */
async function reloadFrom(tabId: string, quiet: boolean, from?: string): Promise<void> {
  const start = from ?? viewOf(tabId)?.root
  if (!start) return
  const walk = async (dir: string): Promise<void> => {
    if (!(await loadDir(tabId, dir, quiet))) return
    const v = viewOf(tabId)
    if (!v) return
    const open = (v.listings[dir] ?? []).filter((e) => isDirLike(e) && v.expanded[e.path])
    await Promise.all(open.map((e) => walk(e.path)))
  }
  await walk(start)
}

/** Тихо перечитать несколько папок (без повторов: вложенные перечитаются вместе с внешними). */
function reloadDirs(tabId: string, dirs: string[]): void {
  const v = viewOf(tabId)
  if (!v?.root) return
  const root = v.root
  for (const dir of topLevel(dirs.filter((d) => isWithin(d, root)))) void reloadFrom(tabId, true, dir)
}

export function refresh(tabId: string): void {
  void reloadFrom(tabId, false)
}

const softTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Тихо обновить дерево, если оно сейчас на экране (после команды в терминале, при переключении вкладок). */
export function softRefresh(tabId: string, delay = 400): void {
  clearTimeout(softTimers.get(tabId))
  softTimers.set(
    tabId,
    setTimeout(() => {
      softTimers.delete(tabId)
      const s = getState()
      const v = s.files[tabId]
      if (!v?.root || v.error || Object.keys(v.loading).length) return
      if (filesTabId(s) !== tabId || (s.settings.layout === 'classic' && s.side !== 'files')) return
      void reloadFrom(tabId, true)
    }, delay)
  )
}

// ---------- подключение и папка терминала ----------

/** Подсказки о папке терминала, пришедшие раньше, чем стала известна домашняя папка. */
const pendingHints = new Map<string, CwdHint>()

export async function onTerminalConnected(tabId: string): Promise<void> {
  const connId = liveConn(tabId)
  if (!connId) return
  pendingHints.delete(tabId)
  const prev = viewOf(tabId)
  // После переподключения остаются корень и раскрытые папки, содержимое читается заново.
  setState((s) => ({
    files: {
      ...s.files,
      [tabId]: prev ? { ...prev, listings: {}, loading: {}, errors: {}, editing: null, error: null } : emptyView()
    }
  }))
  patchTab<TerminalTab>(tabId, { cwd: null })
  let home: string
  try {
    home = await api.sftp.home(connId)
  } catch (err) {
    if (stillCurrent(tabId, connId)) patchView(tabId, () => ({ error: `Файлы сервера недоступны: ${errorText(err)}` }))
    return
  }
  const tab = terminalTab(tabId)
  if (!tab || !stillCurrent(tabId, connId)) return
  const hint = pendingHints.get(tabId)
  pendingHints.delete(tabId)
  const cwd = hint ? resolveCwd(hint, tab.username, home) : null
  if (cwd) patchTab<TerminalTab>(tabId, { cwd })
  const follow = getState().settings.files.followTerminal
  const root = (follow && cwd) || prev?.root || home
  patchView(tabId, () => ({ home, root }))
  await reloadFrom(tabId, false)
}

/** Повторить открытие файлов сервера после ошибки. */
export function retryFiles(tabId: string): void {
  void onTerminalConnected(tabId)
}

export function onCwd(tabId: string, hint: CwdHint): void {
  const tab = terminalTab(tabId)
  if (!tab || tab.state !== 'connected') return
  const v = viewOf(tabId)
  if (!v?.home) {
    pendingHints.set(tabId, hint)
    return
  }
  const cwd = resolveCwd(hint, tab.username, v.home)
  if (!cwd || v.error) return
  if (cwd === tab.cwd) {
    // Заголовок обновляется после каждой команды: что-то могло появиться или пропасть.
    softRefresh(tabId)
    return
  }
  patchTab<TerminalTab>(tabId, { cwd })
  if (getState().settings.files.followTerminal && cwd !== v.root) void setRoot(tabId, cwd)
  else softRefresh(tabId)
}

export function dropFilesView(tabId: string): void {
  const connId = terminalTab(tabId)?.connId
  pendingHints.delete(tabId)
  clearTimeout(softTimers.get(tabId))
  softTimers.delete(tabId)
  setState((s) => ({
    files: omit(s.files, tabId),
    transfers: connId ? s.transfers.filter((j) => j.connId !== connId) : s.transfers
  }))
}

// ---------- навигация ----------

export async function setRoot(tabId: string, path: string, select: string | null = null): Promise<void> {
  const v = viewOf(tabId)
  if (!v || !liveConn(tabId)) return
  patchView(tabId, (cur) => {
    if (select) return { root: path, editing: null, ...only(select) }
    // Выделение внутри новой папки остаётся, снаружи — снимается.
    const keep = cur.selection.filter((p) => p !== path && isWithin(p, path))
    return {
      root: path,
      editing: null,
      selection: keep,
      cursor: cur.cursor && keep.includes(cur.cursor) ? cur.cursor : (keep[0] ?? null),
      anchor: cur.anchor && keep.includes(cur.anchor) ? cur.anchor : null
    }
  })
  await reloadFrom(tabId, !!v.listings[path])
}

export function goUp(tabId: string): void {
  const root = viewOf(tabId)?.root
  if (root && root !== '/') void setRoot(tabId, parentPath(root), root)
}

export function goHome(tabId: string): void {
  const home = viewOf(tabId)?.home
  if (home) void setRoot(tabId, home)
}

/** Перейти по введённому пути: абсолютному, от «~» или от текущей папки дерева. */
export async function goToPath(tabId: string, input: string): Promise<boolean> {
  const v = viewOf(tabId)
  const connId = liveConn(tabId)
  if (!v?.root || !connId) return false
  let text = input.trim()
  if (!text) return false
  if (text === '~' || text.startsWith('~/')) text = (v.home ?? '/') + text.slice(1)
  else if (!text.startsWith('/')) text = joinPath(v.root, text)
  const path = normalizeRemotePath(text)
  if (!path) {
    toast('Неверный путь', 'error')
    return false
  }
  let entry: RemoteEntry
  try {
    entry = await api.sftp.stat(connId, path)
  } catch (err) {
    toast(errorText(err), 'error', 6000)
    return false
  }
  if (isDirLike(entry)) {
    await setRoot(tabId, path)
  } else {
    // Путь к файлу: показываем его папку и открываем файл.
    await setRoot(tabId, parentPath(path), path)
    openFile(tabId, path)
  }
  return true
}

export function toggleDir(tabId: string, path: string, open?: boolean): void {
  const v = viewOf(tabId)
  if (!v) return
  const next = open ?? !v.expanded[path]
  if (next === !!v.expanded[path]) return
  patchView(tabId, (cur) => ({ expanded: next ? { ...cur.expanded, [path]: true } : omit(cur.expanded, path) }))
  // Уже загруженная папка показывается сразу и тихо обновляется.
  if (next) void reloadFrom(tabId, !!v.listings[path], path)
}

// ---------- выделение ----------

export function selectOnly(tabId: string, path: string | null): void {
  const v = viewOf(tabId)
  if (!v) return
  if (v.cursor === path && v.selection.length === (path ? 1 : 0) && (!path || v.selection[0] === path)) return
  patchView(tabId, () => only(path))
}

/** Ctrl+щелчок: добавить элемент к выделению или убрать из него. */
export function toggleSelected(tabId: string, path: string): void {
  patchView(tabId, (v) => {
    const has = v.selection.includes(path)
    return { selection: has ? v.selection.filter((p) => p !== path) : [...v.selection, path], cursor: path, anchor: path }
  })
}

/** Shift+щелчок и Shift+стрелки: диапазон от якоря до path в порядке строк дерева. */
export function selectRange(tabId: string, path: string, order: string[]): void {
  const v = viewOf(tabId)
  if (!v) return
  const from = order.indexOf(v.anchor ?? v.cursor ?? path)
  const to = order.indexOf(path)
  if (from < 0 || to < 0) {
    selectOnly(tabId, path)
    return
  }
  const [a, b] = from <= to ? [from, to] : [to, from]
  patchView(tabId, (cur) => ({ selection: order.slice(a, b + 1), cursor: path, anchor: cur.anchor ?? cur.cursor ?? path }))
}

export function selectAll(tabId: string, order: string[]): void {
  if (!order.length) return
  patchView(tabId, (v) => ({ selection: [...order], cursor: v.cursor ?? order[0], anchor: v.anchor ?? order[0] }))
}

/** Показать файл открытой вкладки редактора в дереве. */
export function revealInTree(editorTabId: string): void {
  const tab = tabById(editorTabId)
  if (!isEditor(tab)) return
  const ownerId = tab.ownerId
  const v = viewOf(ownerId)
  if (!v?.root || !liveConn(ownerId)) return
  if (getState().settings.layout === 'classic') setSide('files')
  const dir = parentPath(tab.path)
  if (!isWithin(dir, v.root)) {
    void setRoot(ownerId, dir, tab.path)
    return
  }
  const root = v.root
  const chain = ancestry(dir).filter((p) => p !== root && isWithin(p, root))
  patchView(ownerId, (cur) => ({
    expanded: { ...cur.expanded, ...Object.fromEntries(chain.map((p) => [p, true])) },
    ...only(tab.path)
  }))
  for (const p of chain) if (!v.listings[p]) void loadDir(ownerId, p)
}

// ---------- создание, переименование, удаление ----------

/** Папка для нового файла или загрузки: выбранная папка, папка выбранного файла или корень. */
export function targetDir(v: FilesView): string | null {
  if (!v.root) return null
  const sel = v.cursor && v.selection.includes(v.cursor) ? findEntry(v, v.cursor) : undefined
  const dir = sel ? (isDirLike(sel) ? sel.path : parentPath(sel.path)) : v.root
  return isWithin(dir, v.root) ? dir : v.root
}

export function startCreate(tabId: string, mode: 'newfile' | 'newdir', parent?: string): void {
  const v = viewOf(tabId)
  if (!v?.root || !liveConn(tabId)) return
  const target = parent && isWithin(parent, v.root) ? parent : targetDir(v)
  if (!target) return
  patchView(tabId, (cur) => ({
    editing: { mode, parent: target },
    expanded: target === cur.root ? cur.expanded : { ...cur.expanded, [target]: true }
  }))
  if (!v.listings[target]) void loadDir(tabId, target)
}

export function startRename(tabId: string, path: string): void {
  const v = viewOf(tabId)
  if (!v || !liveConn(tabId) || path === v.root) return
  patchView(tabId, () => ({ editing: { mode: 'rename', path }, ...only(path) }))
}

export function cancelEdit(tabId: string): void {
  if (viewOf(tabId)?.editing) patchView(tabId, () => ({ editing: null }))
}

const committing = new Set<string>()

/**
 * Применить имя из поля ввода. keepOnError — оставить поле открытым при ошибке
 * (по Enter), иначе закрыть (когда фокус ушёл из поля).
 */
export async function commitEdit(tabId: string, rawName: string, keepOnError: boolean): Promise<void> {
  const v = viewOf(tabId)
  const edit = v?.editing
  if (!v || !edit || committing.has(tabId)) return
  const name = rawName.trim()
  const original = edit.mode === 'rename' ? baseName(edit.path) : ''
  if (!name || name === original) {
    cancelEdit(tabId)
    return
  }
  const problem = checkFileName(name)
  const connId = liveConn(tabId)
  if (problem || !connId) {
    toast(problem ?? 'Нет подключения к серверу', 'error')
    if (!keepOnError || !connId) cancelEdit(tabId)
    return
  }
  const parent = edit.mode === 'rename' ? parentPath(edit.path) : edit.parent
  const target = joinPath(parent, name)
  committing.add(tabId)
  try {
    if (edit.mode === 'rename') await api.sftp.rename(connId, edit.path, target)
    else if (edit.mode === 'newfile') await api.sftp.createFile(connId, target)
    else await api.sftp.mkdir(connId, target)
  } catch (err) {
    toast(errorText(err), 'error', 6000)
    if (!keepOnError) cancelEdit(tabId)
    return
  } finally {
    committing.delete(tabId)
  }
  if (!stillCurrent(tabId, connId)) return
  if (edit.mode === 'rename') afterRename(tabId, edit.path, target)
  patchView(tabId, () => ({ editing: null, ...only(target) }))
  await reloadFrom(tabId, true, parent)
  if (edit.mode === 'newfile') openFile(tabId, target)
}

/** После переименования или перемещения: раскрытые папки, выделение и открытые файлы — на новые пути. */
function afterRename(tabId: string, from: string, to: string): void {
  const moved = (p: string) => (isWithin(p, from) ? rebase(p, from, to) : p)
  patchView(tabId, (v) => {
    const expanded: Record<string, boolean> = {}
    for (const [p, on] of Object.entries(v.expanded)) expanded[moved(p)] = on
    return {
      expanded,
      listings: omitWithin(v.listings, from),
      errors: omitWithin(v.errors, from),
      root: v.root && isWithin(v.root, from) ? rebase(v.root, from, to) : v.root,
      selection: v.selection.map(moved),
      cursor: v.cursor && moved(v.cursor),
      anchor: v.anchor && moved(v.anchor)
    }
  })
  setState((s) => ({
    tabs: s.tabs.map((t) => {
      if (!isEditor(t) || t.ownerId !== tabId || !isWithin(t.path, from)) return t
      const path = rebase(t.path, from, to)
      return { ...t, path, title: baseName(path) } satisfies EditorTab
    })
  }))
}

function countText(entries: RemoteEntry[]): string {
  const dirs = entries.filter(isDirLike).length
  const files = entries.length - dirs
  const parts: string[] = []
  if (dirs) parts.push(`${dirs} ${plural(dirs, 'папка', 'папки', 'папок')}`)
  if (files) parts.push(`${files} ${plural(files, 'файл', 'файла', 'файлов')}`)
  return parts.join(' и ')
}

/** Удаление выделенного (одного или нескольких объектов) с подтверждением. */
export function askRemove(tabId: string, chosen: RemoteEntry[]): void {
  const entries = chosen.filter((e, i, all) => !all.some((o, j) => j !== i && o.path !== e.path && isWithin(e.path, o.path)))
  if (!entries.length) return
  let title: string
  let message: string
  if (entries.length === 1) {
    const entry = entries[0]
    const kind = entry.type === 'link' ? 'link' : entry.type === 'dir' ? 'dir' : 'file'
    title = { dir: 'Удалить папку?', file: 'Удалить файл?', link: 'Удалить ссылку?' }[kind]
    message = {
      dir: `Папка «${entry.name}» будет удалена с сервера вместе со всем содержимым. Отменить это нельзя.`,
      file: `Файл «${entry.name}» будет удалён с сервера. Отменить это нельзя.`,
      link: `Ссылка «${entry.name}» будет удалена. То, на что она указывает, останется на месте.`
    }[kind]
  } else {
    const names = entries.slice(0, 6).map((e) => `«${e.name}»`)
    const more = entries.length > 6 ? ` и ещё ${entries.length - 6}` : ''
    title = `Удалить ${entries.length} ${plural(entries.length, 'объект', 'объекта', 'объектов')}?`
    message = `С сервера будут удалены ${countText(entries)}: ${names.join(', ')}${more}. Папки — вместе со всем содержимым, ссылки — без того, на что они указывают. Отменить это нельзя.`
  }
  confirmAction({
    title,
    message,
    confirmLabel: 'Удалить',
    danger: true,
    onConfirm: async () => {
      const connId = liveConn(tabId)
      if (!connId) throw new Error('Нет подключения к серверу.')
      const failed: string[] = []
      let removed = 0
      for (const entry of entries) {
        try {
          await api.sftp.remove(connId, entry.path)
          afterRemove(tabId, entry.path)
          removed++
        } catch (err) {
          failed.push(`«${entry.name}»: ${errorText(err)}`)
        }
      }
      if (removed) {
        const one = entries.length === 1 ? entries[0] : null
        toast(
          one ? { dir: 'Папка удалена', file: 'Файл удалён', link: 'Ссылка удалена', other: 'Удалено' }[one.type] : `Удалено объектов: ${removed}`,
          'success'
        )
      }
      if (failed.length) toast(`Не удалось удалить ${failed.join('; ')}`, 'error', 9000)
      reloadDirs(tabId, entries.map((e) => parentPath(e.path)))
    }
  })
}

function afterRemove(tabId: string, path: string): void {
  patchView(tabId, (v) => {
    const selection = v.selection.filter((p) => !isWithin(p, path))
    return {
      listings: omitWithin(v.listings, path),
      expanded: omitWithin(v.expanded, path),
      errors: omitWithin(v.errors, path),
      selection,
      cursor: v.cursor && isWithin(v.cursor, path) ? (selection[0] ?? null) : v.cursor,
      anchor: v.anchor && isWithin(v.anchor, path) ? null : v.anchor,
      editing: null
    }
  })
  // Файлы без правок закрываем. С правками — оставляем: при сохранении будет вопрос.
  const clean = getState()
    .tabs.filter((t) => isEditor(t) && t.ownerId === tabId && isWithin(t.path, path) && !t.dirty)
    .map((t) => t.id)
  if (clean.length) closeTabsNow(clean)
}

// ---------- перемещение ----------

export const canMove = canMoveInto

/** Перетащили внутри дерева: спросить (если не отключено) и переместить. */
export function requestMove(tabId: string, paths: string[], dir: string): void {
  const items = topLevel(paths).filter((p) => parentPath(p) !== dir)
  if (!canMove(items, dir)) return
  if (getState().settings.files.confirmMove) openDialog({ type: 'move', tabId, paths: items, dir })
  else void moveEntries(tabId, items, dir)
}

/** Ответ в окне «Переместить?». */
export function resolveMove(confirm: boolean, dontAskAgain: boolean): void {
  const dialog = getState().dialog
  if (dialog?.type !== 'move') return
  closeDialog()
  if (!confirm) return
  if (dontAskAgain) updateSettings((s) => ({ ...s, files: { ...s.files, confirmMove: false } }))
  void moveEntries(dialog.tabId, dialog.paths, dialog.dir)
}

export async function moveEntries(tabId: string, paths: string[], dir: string): Promise<void> {
  const connId = liveConn(tabId)
  if (!connId) {
    toast('Нет подключения к серверу', 'error')
    return
  }
  const moved: Array<[string, string]> = []
  const failed: string[] = []
  for (const from of paths) {
    const to = joinPath(dir, baseName(from))
    try {
      await api.sftp.rename(connId, from, to)
      moved.push([from, to])
    } catch (err) {
      failed.push(`«${baseName(from)}»: ${errorText(err)}`)
    }
  }
  if (!stillCurrent(tabId, connId)) return
  for (const [from, to] of moved) afterRename(tabId, from, to)
  if (moved.length) {
    const targets = moved.map(([, to]) => to)
    patchView(tabId, (v) => ({
      selection: targets,
      cursor: targets[0],
      anchor: targets[0],
      expanded: dir === v.root ? v.expanded : { ...v.expanded, [dir]: true }
    }))
    toast(moved.length === 1 ? `Перемещено в ${dir}` : `Перемещено в ${dir}: ${moved.length}`, 'success')
  }
  if (failed.length) {
    toast(
      `Не удалось переместить ${failed.join('; ')}. Если это другой диск сервера — используйте mv в терминале.`,
      'error',
      10000
    )
  }
  reloadDirs(tabId, [dir, ...moved.map(([from]) => parentPath(from))])
}

// ---------- перетаскивание ----------

export interface DragInfo {
  tabId: string
  paths: string[]
}

/** Что сейчас перетаскивается из дерева (для подсветки, куда можно положить). */
let dragging: DragInfo | null = null

export const currentDrag = (): DragInfo | null => dragging

export function endDrag(): void {
  dragging = null
}

/**
 * Начало перетаскивания из дерева. Возвращает ссылку DownloadURL для Проводника: один файл
 * отдаётся как есть, папка или несколько объектов — zip-архивом (см. src/main/ssh/dragOut.ts).
 */
export function beginDrag(tabId: string, entries: RemoteEntry[]): { downloadUrl: string | null; outName: string } {
  const items = entries.filter((e, i, all) => !all.some((o, j) => j !== i && o.path !== e.path && isWithin(e.path, o.path)))
  dragging = { tabId, paths: items.map((e) => e.path) }
  const connId = liveConn(tabId)
  const single = items.length === 1 && !isDirLike(items[0]) ? items[0] : null
  let outName: string
  if (single) {
    outName = safeLocalName(single.name)
  } else if (items.length === 1) {
    outName = `${safeLocalName(items[0].name)}.zip`
  } else {
    const parents = new Set(items.map((e) => parentPath(e.path)))
    const parent = parents.size === 1 ? [...parents][0] : '/'
    outName = `${parent === '/' ? 'files' : safeLocalName(baseName(parent))}.zip`
  }
  if (!connId || !items.length) return { downloadUrl: null, outName }
  const token = crypto.randomUUID()
  api.files.registerDragOut(
    token,
    connId,
    items.map((e) => e.path),
    outName
  )
  const mime = single ? 'application/octet-stream' : 'application/zip'
  return { downloadUrl: `${mime}:${outName}:termion-dl://get/${token}/${encodeURIComponent(outName)}`, outName }
}

// ---------- терминал ----------

/** Перейти в папку в терминале этой вкладки. */
export function cdInTerminal(tabId: string, dir: string): void {
  if (!sendToTerminal(tabId, `cd ${shellQuote(dir)}\r`)) {
    toast('Нет подключения к серверу', 'error')
    return
  }
  activateTab(tabId)
}

// ---------- настройки дерева ----------

export function toggleHidden(): void {
  updateSettings((s) => ({ ...s, files: { ...s.files, showHidden: !s.files.showHidden } }))
}

export function toggleFollow(tabId: string | null): void {
  const on = !getState().settings.files.followTerminal
  updateSettings((s) => ({ ...s, files: { ...s.files, followTerminal: on } }))
  toast(on ? 'Дерево следует за папкой терминала' : 'Дерево больше не следует за терминалом', 'info', 2200)
  if (!on || !tabId) return
  const cwd = terminalTab(tabId)?.cwd
  if (cwd && cwd !== viewOf(tabId)?.root) void setRoot(tabId, cwd)
}

// ---------- передача файлов ----------

export async function download(tabId: string, paths: string[]): Promise<void> {
  const connId = liveConn(tabId)
  if (!connId || !paths.length) return
  try {
    await api.sftp.download(connId, topLevel(paths))
  } catch (err) {
    toast(errorText(err), 'error', 6000)
  }
}

export async function upload(tabId: string, dir: string, source: UploadSource): Promise<void> {
  const connId = liveConn(tabId)
  if (!connId) return
  try {
    await api.sftp.upload(connId, dir, source)
  } catch (err) {
    toast(errorText(err), 'error', 6000)
  }
}

/** Файлы и папки, перетащенные из Проводника. */
export function uploadDropped(tabId: string, dir: string, files: FileList): void {
  const paths = Array.from(files)
    .map((f) => api.files.pathForFile(f))
    .filter(Boolean)
  if (!paths.length) {
    toast('Перетащите файлы или папки из Проводника', 'info')
    return
  }
  void upload(tabId, dir, { kind: 'paths', paths })
}

const transferTimers = new Map<string, ReturnType<typeof setTimeout>>()
const isFinished = (j: TransferJob) => j.state === 'done' || j.state === 'failed' || j.state === 'cancelled'

export function onTransfer(job: TransferJob): void {
  const tab = getState().tabs.find((t): t is TerminalTab => isTerminal(t) && t.connId === job.connId)
  const prev = getState().transfers.find((j) => j.id === job.id)
  if (!tab) {
    // Вкладку закрыли или переподключили — передача уже не нужна.
    if (prev) dismissTransfer(job.id)
    return
  }
  setState((s) => ({ transfers: prev ? s.transfers.map((j) => (j.id === job.id ? job : j)) : [...s.transfers, job] }))
  if (!isFinished(job) || (prev && isFinished(prev))) return

  if (job.kind === 'upload' && job.remoteDir && viewOf(tab.id)?.listings[job.remoteDir]) {
    void reloadFrom(tab.id, true, job.remoteDir)
  }
  const skipped = job.skipped ? ` (пропущено: ${job.skipped})` : ''
  if (job.state === 'done') {
    const what = job.kind === 'upload' ? `Загружено на сервер: ${job.title}` : job.dragOut ? `Передано в Проводник: ${job.title}` : `Скачано: ${job.title}`
    toast(`${what}${skipped}`, 'success', 3500)
    autoDismiss(job.id, job.kind === 'download' && !job.dragOut ? 30_000 : 8_000)
  } else if (job.state === 'failed') {
    toast(`${job.kind === 'upload' ? 'Загрузка' : 'Скачивание'} не удалась: ${job.error ?? 'неизвестная ошибка'}`, 'error', 9000)
  } else {
    autoDismiss(job.id, 2500)
  }
}

function autoDismiss(id: string, ms: number): void {
  clearTimeout(transferTimers.get(id))
  transferTimers.set(
    id,
    setTimeout(() => dismissTransfer(id), ms)
  )
}

export function dismissTransfer(id: string): void {
  clearTimeout(transferTimers.get(id))
  transferTimers.delete(id)
  setState((s) => ({ transfers: s.transfers.filter((j) => j.id !== id) }))
}

export function cancelTransfer(id: string): void {
  api.sftp.cancelTransfer(id)
}
