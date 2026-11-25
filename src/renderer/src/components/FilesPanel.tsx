// Панель файлов сервера: путь, дерево папок (с прокруткой больших папок без задержек),
// выделение нескольких объектов, контекстные меню, перетаскивание (из Проводника, внутри
// дерева и в Проводник) и список передач.

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode
} from 'react'
import { flushSync } from 'react-dom'
import { isWithin, parentPath } from '@shared/remotePath'
import type { RemoteEntry, TransferJob } from '@shared/types'
import { api } from '../api'
import { fileTone } from '../editor/languages'
import { formatDate, formatSize, modeString, plural } from '../format'
import { copyText, reconnect, showMenu } from '../store/actions'
import { filesTabId, isEditor, useApp, type FilesView, type MenuEntry, type TerminalTab } from '../store/app'
import { openFile } from '../store/editors'
import * as files from '../store/files'
import { Icon } from './Icon'

/** Свой тип данных перетаскивания: так перетаскивание из дерева отличается от файлов из Проводника. */
const INTERNAL_TYPE = 'application/x-termion-files'
/** Через сколько раскрывается свёрнутая папка, если держать над ней перетаскиваемое. */
const HOVER_EXPAND_MS = 650

type EntryRow = { kind: 'entry'; key: string; entry: RemoteEntry; depth: number; open: boolean }
type Row =
  | EntryRow
  | { kind: 'edit'; key: string; depth: number; mode: 'newfile' | 'newdir' | 'rename'; entry?: RemoteEntry }
  | { kind: 'note'; key: string; depth: number; tone: 'loading' | 'error' | 'empty'; text: string }

const isHidden = (e: RemoteEntry) => e.name.startsWith('.')

/** Видимые строки дерева: раскрытые папки по порядку, поле ввода имени, служебные строки. */
function buildRows(v: FilesView, showHidden: boolean): Row[] {
  const rows: Row[] = []
  const edit = v.editing
  const selected = new Set(v.selection)
  const visit = (dir: string, depth: number) => {
    if (edit && edit.mode !== 'rename' && edit.parent === dir) rows.push({ kind: 'edit', key: `edit:${dir}`, depth, mode: edit.mode })
    const list = v.listings[dir]
    if (!list) {
      if (depth === 0) return // корень: своё состояние на всю панель
      const error = v.errors[dir]
      rows.push(
        error
          ? { kind: 'note', key: `err:${dir}`, depth, tone: 'error', text: error }
          : { kind: 'note', key: `load:${dir}`, depth, tone: 'loading', text: 'Загрузка…' }
      )
      return
    }
    let shown = 0
    for (const entry of list) {
      const renaming = edit?.mode === 'rename' && edit.path === entry.path
      if (!showHidden && isHidden(entry) && !renaming && !selected.has(entry.path)) continue
      shown++
      if (renaming) {
        rows.push({ kind: 'edit', key: `edit:${entry.path}`, depth, mode: 'rename', entry })
        continue
      }
      const open = files.isDirLike(entry) && !!v.expanded[entry.path]
      rows.push({ kind: 'entry', key: entry.path, entry, depth, open })
      if (open) visit(entry.path, depth + 1)
    }
    if (!shown && depth > 0 && !(edit && edit.mode !== 'rename' && edit.parent === dir)) {
      const hidden = list.length > 0
      rows.push({ kind: 'note', key: `empty:${dir}`, depth, tone: 'empty', text: hidden ? 'Только скрытые файлы' : 'Пусто' })
    }
  }
  if (v.root) visit(v.root, 0)
  return rows
}

function entryTooltip(e: RemoteEntry): string {
  const lines = [e.name]
  if (e.type === 'link') lines.push(e.target === 'broken' ? `Ссылка → ${e.linkTo ?? '?'} (не существует)` : `Ссылка → ${e.linkTo ?? '?'}`)
  const kind = files.isDirLike(e) ? 'Папка' : formatSize(e.size)
  lines.push(`${kind} · изменён ${formatDate(e.mtime)}`)
  lines.push(modeString(e))
  return lines.join('\n')
}

function EntryIcon({ entry, open }: { entry: RemoteEntry; open?: boolean }) {
  const dir = files.isDirLike(entry)
  const tone = dir ? 'fi-folder' : entry.type === 'link' && entry.target === 'broken' ? 'ft-err' : `ft-${fileTone(entry.name)}`
  return (
    <span className={`ri ${tone}${open ? ' open' : ''}`}>
      <Icon name={dir ? 'folder' : 'file'} />
      {entry.type === 'link' && (
        <span className="lnk">
          <Icon name="arrowLink" size={9} />
        </span>
      )}
    </span>
  )
}

function EditRow({ tabId, row, style }: { tabId: string; row: Extract<Row, { kind: 'edit' }>; style: CSSProperties }) {
  const ref = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    const dot = el.value.lastIndexOf('.')
    el.setSelectionRange(0, row.mode === 'rename' && dot > 0 ? dot : el.value.length)
  }, [row.mode])
  const dir = row.mode === 'newdir' || (row.entry ? files.isDirLike(row.entry) : false)
  return (
    <div className="row inline" style={style}>
      <span className="chev" />
      <span className={`ri ${dir ? 'fi-folder' : 'ft-dim'}`}>
        <Icon name={dir ? 'folder' : 'file'} />
      </span>
      <input
        ref={ref}
        className="inline-input mono"
        defaultValue={row.entry?.name ?? ''}
        placeholder={row.mode === 'newdir' ? 'имя папки' : 'имя файла'}
        spellCheck={false}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            void files.commitEdit(tabId, e.currentTarget.value, true)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            files.cancelEdit(tabId)
            ref.current?.closest<HTMLElement>('.ftree')?.focus()
          }
        }}
        onBlur={(e) => void files.commitEdit(tabId, e.currentTarget.value, false)}
      />
    </div>
  )
}

// ---------- меню ----------

function entryMenu(tabId: string, v: FilesView, entry: RemoteEntry): MenuEntry[] {
  const path = entry.path
  const common: MenuEntry[] = [
    { label: 'Копировать путь', icon: 'copy', onSelect: () => copyText(path, 'Путь скопирован') },
    'separator',
    { label: 'Переименовать', icon: 'edit', hint: 'F2', onSelect: () => files.startRename(tabId, path) },
    { label: 'Удалить', icon: 'trash', hint: 'Del', danger: true, onSelect: () => files.askRemove(tabId, [entry]) }
  ]
  if (entry.type === 'link' && entry.target === 'broken') return common.slice(0)
  if (files.isDirLike(entry)) {
    const open = !!v.expanded[path]
    return [
      { label: open ? 'Свернуть' : 'Раскрыть', icon: 'chev', hint: 'Enter', onSelect: () => files.toggleDir(tabId, path) },
      { label: 'Открыть как корень дерева', icon: 'target', onSelect: () => void files.setRoot(tabId, path) },
      { label: 'Перейти сюда в терминале', icon: 'term', onSelect: () => files.cdInTerminal(tabId, path) },
      'separator',
      { label: 'Новый файл здесь', icon: 'filePlus', onSelect: () => files.startCreate(tabId, 'newfile', path) },
      { label: 'Новая папка здесь', icon: 'folderPlus', onSelect: () => files.startCreate(tabId, 'newdir', path) },
      { label: 'Загрузить сюда файлы…', icon: 'upload', onSelect: () => void files.upload(tabId, path, { kind: 'pick-files' }) },
      { label: 'Загрузить сюда папку…', icon: 'upload', onSelect: () => void files.upload(tabId, path, { kind: 'pick-folder' }) },
      { label: 'Скачать папку на компьютер', icon: 'download', onSelect: () => void files.download(tabId, [path]) },
      'separator',
      ...common
    ]
  }
  return [
    { label: 'Открыть в редакторе', icon: 'edit', hint: 'Enter', onSelect: () => openFile(tabId, path) },
    { label: 'Скачать на компьютер', icon: 'download', onSelect: () => void files.download(tabId, [path]) },
    { label: 'Перейти к папке в терминале', icon: 'term', onSelect: () => files.cdInTerminal(tabId, parentPath(path)) },
    'separator',
    ...common
  ]
}

/** Меню для нескольких выделенных объектов. */
function multiMenu(tabId: string, entries: RemoteEntry[]): MenuEntry[] {
  const paths = entries.map((e) => e.path)
  const n = entries.length
  return [
    { label: `Скачать на компьютер (${n})`, icon: 'download', onSelect: () => void files.download(tabId, paths) },
    { label: 'Копировать пути', icon: 'copy', onSelect: () => copyText(paths.join('\n'), 'Пути скопированы') },
    'separator',
    { label: `Удалить (${n})`, icon: 'trash', hint: 'Del', danger: true, onSelect: () => files.askRemove(tabId, entries) }
  ]
}

function backgroundMenu(tabId: string, v: FilesView, showHidden: boolean, follow: boolean): MenuEntry[] {
  const root = v.root as string
  return [
    { label: 'Новый файл', icon: 'filePlus', onSelect: () => files.startCreate(tabId, 'newfile', root) },
    { label: 'Новая папка', icon: 'folderPlus', onSelect: () => files.startCreate(tabId, 'newdir', root) },
    { label: 'Загрузить файлы…', icon: 'upload', onSelect: () => void files.upload(tabId, root, { kind: 'pick-files' }) },
    { label: 'Загрузить папку…', icon: 'upload', onSelect: () => void files.upload(tabId, root, { kind: 'pick-folder' }) },
    'separator',
    { label: 'Перейти сюда в терминале', icon: 'term', onSelect: () => files.cdInTerminal(tabId, root) },
    { label: 'Копировать путь', icon: 'copy', onSelect: () => copyText(root, 'Путь скопирован') },
    'separator',
    { label: 'Показывать скрытые файлы', checked: showHidden, onSelect: files.toggleHidden },
    { label: 'Следовать за папкой терминала', checked: follow, onSelect: () => files.toggleFollow(tabId) },
    { label: 'Обновить', icon: 'refresh', hint: 'F5', onSelect: () => files.refresh(tabId) }
  ]
}

// ---------- путь ----------

function PathBar({ tabId, v, follow }: { tabId: string; v: FilesView; follow: boolean }) {
  const root = v.root as string
  const [editing, setEditing] = useState(false)
  const crumbsRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    // Длинный путь: видна его последняя часть.
    const el = crumbsRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [root, editing])

  const parts = root.split('/').filter(Boolean)
  const crumbs = [{ label: '/', path: '/' }]
  let acc = ''
  for (const part of parts) {
    acc += `/${part}`
    crumbs.push({ label: part, path: acc })
  }

  const submit = async (input: HTMLInputElement) => {
    if (await files.goToPath(tabId, input.value)) setEditing(false)
    else input.select()
  }

  return (
    <div className="pathbar">
      <button className="icon-btn" title="На уровень выше (Backspace)" disabled={root === '/'} onClick={() => files.goUp(tabId)}>
        <Icon name="up" />
      </button>
      <button className="icon-btn" title={`Домашняя папка${v.home ? `: ${v.home}` : ''}`} disabled={!v.home || v.home === root} onClick={() => files.goHome(tabId)}>
        <Icon name="home" />
      </button>
      {editing ? (
        <input
          className="path-input mono"
          defaultValue={root}
          autoFocus
          spellCheck={false}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') void submit(e.currentTarget)
            else if (e.key === 'Escape') setEditing(false)
          }}
          onBlur={() => setEditing(false)}
        />
      ) : (
        <div className="crumbs mono" ref={crumbsRef} title={`${root}\nДвойной щелчок — ввести путь`} onDoubleClick={() => setEditing(true)}>
          {crumbs.map((c, i) => (
            <span key={c.path} className="crumb-wrap">
              {i > 1 && <span className="sep">/</span>}
              <button className={`crumb${i === crumbs.length - 1 ? ' last' : ''}`} onClick={() => void files.setRoot(tabId, c.path)} onDoubleClick={(e) => e.stopPropagation()}>
                {c.label}
              </button>
            </span>
          ))}
        </div>
      )}
      <button
        className={`icon-btn${follow ? ' on' : ''}`}
        title={follow ? 'Дерево следует за папкой терминала (нажмите, чтобы выключить)' : 'Следовать за папкой терминала'}
        onClick={() => files.toggleFollow(tabId)}
      >
        <Icon name="link" />
      </button>
    </div>
  )
}

// ---------- дерево ----------

const OVERSCAN = 8

interface Ghost {
  title: string
  sub: string | null
  dir: boolean
  tone: string
}

function Tree({ tabId, v, live }: { tabId: string; v: FilesView; live: boolean }) {
  const showHidden = useApp((s) => s.settings.files.showHidden)
  const follow = useApp((s) => s.settings.files.followTerminal)
  const tabs = useApp((s) => s.tabs)
  const rows = useMemo(() => buildRows(v, showHidden), [v, showHidden])
  const selected = useMemo(() => new Set(v.selection), [v.selection])
  const openedPaths = useMemo(() => {
    const paths = new Set<string>()
    for (const t of tabs) if (isEditor(t) && t.ownerId === tabId) paths.add(t.path)
    return paths
  }, [tabs, tabId])

  const treeRef = useRef<HTMLDivElement>(null)
  const probeRef = useRef<HTMLDivElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const [rowH, setRowH] = useState(28)
  const [viewport, setViewport] = useState({ top: 0, height: 600 })
  const [dropDir, setDropDir] = useState<string | null>(null)
  const [dragged, setDragged] = useState<{ origin: string; paths: Set<string> } | null>(null)
  const [ghost, setGhost] = useState<Ghost | null>(null)
  const revealRef = useRef<string | null>(null)
  const hoverRef = useRef<{ path: string; timer: ReturnType<typeof setTimeout> } | null>(null)

  // Высота строки зависит от темы — меряем её на невидимой строке-образце.
  useLayoutEffect(() => {
    const probe = probeRef.current
    const tree = treeRef.current
    if (!probe || !tree) return
    const measure = () => {
      if (probe.offsetHeight > 0) setRowH(probe.offsetHeight)
      setViewport({ top: tree.scrollTop, height: tree.clientHeight })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(probe)
    ro.observe(tree)
    return () => ro.disconnect()
  }, [])

  const frame = useRef(0)
  const onScroll = () => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      const tree = treeRef.current
      if (tree) setViewport({ top: tree.scrollTop, height: tree.clientHeight })
    })
  }
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current)
      if (hoverRef.current) clearTimeout(hoverRef.current.timer)
    },
    []
  )

  // Строка под курсором (с клавиатуры или «Показать в дереве») прокручивается в видимую область.
  useEffect(() => {
    revealRef.current = v.cursor
  }, [v.cursor])
  useEffect(() => {
    const target = revealRef.current
    const tree = treeRef.current
    if (!target || !tree) return
    const index = rows.findIndex((r) => r.key === target)
    if (index < 0) return
    revealRef.current = null
    const top = index * rowH
    if (top < tree.scrollTop) tree.scrollTop = top
    else if (top + rowH > tree.scrollTop + tree.clientHeight) tree.scrollTop = top + rowH - tree.clientHeight
  }, [rows, rowH])

  const entryRows = useMemo(() => rows.filter((r): r is EntryRow => r.kind === 'entry'), [rows])
  const order = useMemo(() => entryRows.map((r) => r.entry.path), [entryRows])
  const cursorIndex = v.cursor ? order.indexOf(v.cursor) : -1

  const activate = (entry: RemoteEntry) => {
    if (files.isDirLike(entry)) files.toggleDir(tabId, entry.path)
    else if (!(entry.type === 'link' && entry.target === 'broken')) openFile(tabId, entry.path)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.altKey || e.metaKey) return
    if (e.ctrlKey) {
      if (!e.shiftKey && e.code === 'KeyA') {
        e.preventDefault()
        e.stopPropagation()
        files.selectAll(tabId, order)
      }
      return
    }
    const current = cursorIndex >= 0 ? entryRows[cursorIndex] : undefined
    /** Перевести курсор; с Shift — расширить выделение. */
    const go = (index: number) => {
      const row = entryRows[Math.max(0, Math.min(entryRows.length - 1, index))]
      if (!row) return
      if (e.shiftKey) files.selectRange(tabId, row.entry.path, order)
      else files.selectOnly(tabId, row.entry.path)
    }
    const page = Math.max(1, Math.floor((treeRef.current?.clientHeight ?? 300) / rowH) - 1)
    let handled = true
    switch (e.key) {
      case 'ArrowDown':
        go(cursorIndex + 1)
        break
      case 'ArrowUp':
        go(cursorIndex < 0 ? entryRows.length - 1 : cursorIndex - 1)
        break
      case 'Home':
        go(0)
        break
      case 'End':
        go(entryRows.length - 1)
        break
      case 'PageDown':
        go(cursorIndex + page)
        break
      case 'PageUp':
        go(cursorIndex - page)
        break
      case 'ArrowRight':
        if (current && files.isDirLike(current.entry)) {
          const next = entryRows[cursorIndex + 1]
          if (!current.open) files.toggleDir(tabId, current.entry.path, true)
          else if (next && next.depth > current.depth) files.selectOnly(tabId, next.entry.path)
        }
        break
      case 'ArrowLeft':
        if (current?.open) files.toggleDir(tabId, current.entry.path, false)
        else if (current && current.depth > 0) files.selectOnly(tabId, parentPath(current.entry.path))
        break
      case 'Enter':
        if (current) activate(current.entry)
        break
      case 'Backspace':
        files.goUp(tabId)
        break
      case 'F2':
        if (current) files.startRename(tabId, current.entry.path)
        break
      case 'Delete':
        if (v.selection.length) files.askRemove(tabId, files.selectedEntries(v))
        break
      case 'Escape':
        if (v.selection.length > 1) files.selectOnly(tabId, v.cursor)
        else handled = false
        break
      case 'F5':
        files.refresh(tabId)
        break
      default:
        handled = false
    }
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  const rowFromEvent = (e: { target: EventTarget | null }): RemoteEntry | null => {
    const el = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-path]')
    const path = el?.dataset.path
    return path ? (entryRows.find((r) => r.entry.path === path)?.entry ?? null) : null
  }

  const onContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('input')) return
    e.preventDefault()
    const entry = rowFromEvent(e)
    if (!entry) {
      showMenu(e.clientX, e.clientY, backgroundMenu(tabId, v, showHidden, follow))
      return
    }
    // Правый щелчок по выделенному — меню для всего выделения, по другому — только для него.
    if (selected.has(entry.path) && v.selection.length > 1) {
      showMenu(e.clientX, e.clientY, multiMenu(tabId, files.selectedEntries(v)))
      return
    }
    files.selectOnly(tabId, entry.path)
    showMenu(e.clientX, e.clientY, entryMenu(tabId, v, entry))
  }

  // ---------- перетаскивание ----------

  /** Папка, куда упадёт перетаскиваемое: папка под курсором, папка файла под курсором или корень. */
  const dropTarget = (e: DragEvent): string => {
    const entry = rowFromEvent(e)
    if (!entry) return v.root as string
    return files.isDirLike(entry) ? entry.path : parentPath(entry.path)
  }

  const clearHover = () => {
    if (hoverRef.current) clearTimeout(hoverRef.current.timer)
    hoverRef.current = null
  }

  /** Держат перетаскиваемое над свёрнутой папкой — через мгновение она раскрывается. */
  const hoverExpand = (e: DragEvent) => {
    const entry = rowFromEvent(e)
    const path = entry && files.isDirLike(entry) && !v.expanded[entry.path] ? entry.path : null
    if (hoverRef.current?.path === path) return
    clearHover()
    if (path) hoverRef.current = { path, timer: setTimeout(() => files.toggleDir(tabId, path, true), HOVER_EXPAND_MS) }
  }

  const finishDrag = () => {
    files.endDrag()
    clearHover()
    setDropDir(null)
    setDragged(null)
  }

  const onRowDragStart = (e: DragEvent<HTMLDivElement>, entry: RemoteEntry) => {
    if (!live) {
      e.preventDefault()
      return
    }
    // Тянут выделенное — тянем всё выделение; иначе — только эту строку.
    const chosen = selected.has(entry.path) ? files.selectedEntries(v) : [entry]
    if (!selected.has(entry.path)) files.selectOnly(tabId, entry.path)
    const { downloadUrl, outName } = files.beginDrag(tabId, chosen)
    e.dataTransfer.effectAllowed = 'copyMove'
    e.dataTransfer.setData(INTERNAL_TYPE, tabId)
    if (downloadUrl) e.dataTransfer.setData('DownloadURL', downloadUrl)
    const one = chosen.length === 1 ? chosen[0] : null
    const zip = !one || files.isDirLike(one)
    flushSync(() =>
      setGhost({
        title: one ? one.name : `${chosen.length} ${plural(chosen.length, 'объект', 'объекта', 'объектов')}`,
        sub: zip ? `в Проводник — архивом ${outName}` : null,
        dir: !!one && files.isDirLike(one),
        tone: one && !files.isDirLike(one) ? `ft-${fileTone(one.name)}` : 'fi-folder'
      })
    )
    if (ghostRef.current) e.dataTransfer.setDragImage(ghostRef.current, 14, 14)
    setDragged({ origin: entry.path, paths: new Set(chosen.map((c) => c.path)) })
  }

  const internalDrag = (e: DragEvent) => {
    const drag = files.currentDrag()
    return e.dataTransfer.types.includes(INTERNAL_TYPE) && drag?.tabId === tabId ? drag : null
  }

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    const drag = internalDrag(e)
    if (drag) {
      const dir = dropTarget(e)
      hoverExpand(e)
      if (!files.canMove(drag.paths, dir)) {
        e.dataTransfer.dropEffect = 'none'
        if (dropDir) setDropDir(null)
        return
      }
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (dir !== dropDir) setDropDir(dir)
      return
    }
    if (!e.dataTransfer.types.includes('Files') || !live) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    hoverExpand(e)
    const dir = dropTarget(e)
    if (dir !== dropDir) setDropDir(dir)
  }

  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setDropDir(null)
      clearHover()
    }
  }

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const drag = internalDrag(e)
    const dir = dropTarget(e)
    if (drag) {
      e.preventDefault()
      finishDrag()
      files.requestMove(tabId, drag.paths, dir)
      return
    }
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    setDropDir(null)
    clearHover()
    files.uploadDropped(tabId, dir, e.dataTransfer.files)
  }

  // Видимый диапазон строк (+ строка ввода имени и строка, которую тащат, — они должны оставаться на месте).
  const first = Math.max(0, Math.floor(viewport.top / rowH) - OVERSCAN)
  const last = Math.min(rows.length, Math.ceil((viewport.top + viewport.height) / rowH) + OVERSCAN)
  const visible: number[] = []
  for (let i = first; i < last; i++) visible.push(i)
  for (const key of [rows.find((r) => r.kind === 'edit')?.key, dragged?.origin]) {
    const index = key ? rows.findIndex((r) => r.key === key) : -1
    if (index >= 0 && (index < first || index >= last)) visible.push(index)
  }

  const root = v.root as string
  const rootDrop = dropDir === root

  return (
    <div
      ref={treeRef}
      className={`tree ftree${rootDrop ? ' drop-root' : ''}`}
      tabIndex={0}
      role="tree"
      aria-label="Файлы на сервере"
      aria-multiselectable="true"
      onScroll={onScroll}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onMouseDown={(e) => {
        // Щелчок по пустому месту снимает выделение.
        if (e.button === 0 && e.target === e.currentTarget && !e.ctrlKey && !e.shiftKey) files.selectOnly(tabId, null)
      }}
    >
      <div className="row probe" ref={probeRef} aria-hidden="true">
        &nbsp;
      </div>
      <div className="ftree-inner" style={{ height: rows.length * rowH }}>
        {visible.map((i) => {
          const row = rows[i]
          const style: CSSProperties = { top: i * rowH, '--d': row.depth } as CSSProperties
          if (row.kind === 'edit') return <EditRow key={row.key} tabId={tabId} row={row} style={style} />
          if (row.kind === 'note') {
            return (
              <div key={row.key} className={`row note ${row.tone}`} style={style} title={row.text}>
                <span className="chev" />
                {row.tone === 'loading' ? <Icon name="refresh" className="spin" size={13} /> : row.tone === 'error' ? <Icon name="warn" size={13} /> : null}
                <span className="rn">{row.text}</span>
              </div>
            )
          }
          const { entry, open } = row
          const dir = files.isDirLike(entry)
          const isSelected = selected.has(entry.path)
          const cls = [
            'row',
            dir ? 'fdir' : 'ffile',
            open ? 'open' : '',
            isSelected ? 'selected' : '',
            v.cursor === entry.path ? 'cursor' : '',
            openedPaths.has(entry.path) ? 'opened' : '',
            isHidden(entry) ? 'dotfile' : '',
            dropDir === entry.path ? 'drop-inside' : '',
            dragged?.paths.has(entry.path) ? 'dragging' : ''
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <div
              key={row.key}
              className={cls}
              style={style}
              data-path={entry.path}
              role="treeitem"
              aria-expanded={dir ? open : undefined}
              aria-selected={isSelected}
              title={entryTooltip(entry)}
              draggable={live}
              onDragStart={(e) => onRowDragStart(e, entry)}
              onDragEnd={finishDrag}
              onClick={(e) => {
                if (e.detail > 1) return
                if (e.ctrlKey || e.metaKey) files.toggleSelected(tabId, entry.path)
                else if (e.shiftKey) files.selectRange(tabId, entry.path, order)
                else {
                  files.selectOnly(tabId, entry.path)
                  if (dir) files.toggleDir(tabId, entry.path)
                }
              }}
              onDoubleClick={(e) => {
                if (e.ctrlKey || e.shiftKey || e.metaKey) return
                // Двойной щелчок по папке — войти в неё (как в MobaXterm), по файлу — открыть.
                if (dir) void files.setRoot(tabId, entry.path)
                else activate(entry)
              }}
            >
              <span className="chev">{dir && <Icon name="chev" size={14} />}</span>
              <EntryIcon entry={entry} open={open} />
              <span className="rn">{entry.name}</span>
              {!dir && entry.type !== 'other' && <span className="meta mono">{entry.type === 'link' && entry.target === 'broken' ? 'нет цели' : formatSize(entry.size)}</span>}
            </div>
          )
        })}
      </div>
      {!rows.length && (
        <div className="tree-empty small">
          <span>{v.listings[root]?.length ? 'Здесь только скрытые файлы' : 'Папка пуста'}</span>
          <span className="hint-line">Перетащите сюда файлы из Проводника, чтобы загрузить их на сервер</span>
        </div>
      )}
      {/* Картинка, которая едет за курсором при перетаскивании. */}
      <div className="drag-ghost" ref={ghostRef} aria-hidden="true">
        {ghost && (
          <>
            <span className={`dg-ic ${ghost.tone}`}>
              <Icon name={ghost.dir || ghost.sub ? 'folder' : 'file'} />
            </span>
            <span className="dg-text">
              <b>{ghost.title}</b>
              {ghost.sub && <small>{ghost.sub}</small>}
            </span>
          </>
        )}
      </div>
    </div>
  )
}

/** Строка под деревом, когда выделено несколько объектов. */
function SelectionBar({ tabId, v }: { tabId: string; v: FilesView }) {
  const entries = files.selectedEntries(v)
  if (entries.length < 2) return null
  const dirs = entries.filter(files.isDirLike).length
  const fileEntries = entries.filter((e) => !files.isDirLike(e))
  const size = fileEntries.reduce((n, e) => n + e.size, 0)
  const parts: string[] = []
  if (dirs) parts.push(`${dirs} ${plural(dirs, 'папка', 'папки', 'папок')}`)
  if (fileEntries.length) parts.push(`${fileEntries.length} ${plural(fileEntries.length, 'файл', 'файла', 'файлов')} · ${formatSize(size)}`)
  return (
    <div className="sel-bar">
      <span className="sel-count">Выделено: {entries.length}</span>
      <span className="sel-what">{parts.join(', ')}</span>
      <button className="icon-btn" title="Снять выделение (Esc)" onClick={() => files.selectOnly(tabId, v.cursor)}>
        <Icon name="x" size={13} />
      </button>
    </div>
  )
}

// ---------- передачи ----------

function transferText(job: TransferJob): string {
  if (job.state === 'preparing') return job.dragOut ? 'Проводник ждёт файл…' : 'Подготовка…'
  if (job.state === 'running') {
    const files = job.totalFiles > 1 ? ` · ${Math.min(job.doneFiles + 1, job.totalFiles)} из ${job.totalFiles}` : ''
    return `${job.dragOut ? 'В Проводник · ' : ''}${formatSize(job.doneBytes)} из ${formatSize(job.totalBytes)}${files}`
  }
  if (job.state === 'done') {
    const what = job.totalFiles === 1 ? formatSize(job.totalBytes) : `${job.doneFiles} ${plural(job.doneFiles, 'файл', 'файла', 'файлов')}, ${formatSize(job.doneBytes)}`
    return `${job.dragOut ? 'Передано в Проводник' : 'Готово'} · ${what}${job.skipped ? ` · пропущено: ${job.skipped}` : ''}`
  }
  if (job.state === 'cancelled') return 'Отменено'
  return job.error ?? 'Ошибка'
}

function Transfers({ connId }: { connId: string }) {
  const all = useApp((s) => s.transfers)
  const jobs = useMemo(() => all.filter((j) => j.connId === connId), [all, connId])
  if (!jobs.length) return null
  return (
    <div className="xfers">
      {jobs.map((job) => {
        const active = job.state === 'preparing' || job.state === 'running'
        const pct = job.totalBytes > 0 ? Math.min(100, (job.doneBytes / job.totalBytes) * 100) : 0
        return (
          <div key={job.id} className={`xfer ${job.state}`} title={job.localPath ? `${job.title}\n${job.localPath}` : job.title}>
            <span className="xf-ic">
              <Icon name={job.kind === 'upload' ? 'upload' : 'download'} size={14} />
            </span>
            <div className="xf-main">
              <div className="xf-title">{job.title}</div>
              {active && (
                <div className="xf-bar">
                  <i style={{ width: `${job.state === 'preparing' ? 0 : pct}%` }} />
                </div>
              )}
              <div className="xf-sub">{transferText(job)}</div>
            </div>
            {active ? (
              <button className="icon-btn" title="Отменить" onClick={() => files.cancelTransfer(job.id)}>
                <Icon name="x" size={14} />
              </button>
            ) : (
              <>
                {job.kind === 'download' && job.state === 'done' && job.localPath && (
                  <button className="icon-btn" title="Показать в папке" onClick={() => void api.app.showInFolder(job.localPath as string)}>
                    <Icon name="external" size={14} />
                  </button>
                )}
                <button className="icon-btn" title="Убрать из списка" onClick={() => files.dismissTransfer(job.id)}>
                  <Icon name="x" size={14} />
                </button>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ---------- панель ----------

function Placeholder({ icon, text, children }: { icon: 'folder' | 'plug' | 'warn' | 'refresh'; text: string; children?: ReactNode }) {
  return (
    <div className="empty-panel">
      <Icon name={icon} className={icon === 'refresh' ? 'spin' : undefined} />
      <p>{text}</p>
      {children && <div className="ep-actions">{children}</div>}
    </div>
  )
}

export function FilesPanel() {
  const tabId = useApp((s) => filesTabId(s))
  const tab = useApp((s) => s.tabs.find((t): t is TerminalTab => t.id === tabId && t.kind === 'terminal'))
  const v = useApp((s) => (tabId ? s.files[tabId] : undefined))
  const follow = useApp((s) => s.settings.files.followTerminal)
  const live = tab?.state === 'connected'

  // При переключении вкладок дерево тихо обновляется.
  useEffect(() => {
    if (tabId && live) files.softRefresh(tabId, 150)
  }, [tabId, live])

  const busy = !!v && Object.keys(v.loading).length > 0
  const ready = !!(live && v?.root && !v.error)
  const rootLoaded = !!(v?.root && v.listings[v.root])

  let body: ReactNode
  if (!tab) body = <Placeholder icon="folder" text="Подключитесь к сессии — здесь появятся файлы сервера" />
  else if (tab.state === 'closed' || tab.state === 'failed')
    body = (
      <Placeholder icon="plug" text="Соединение закрыто">
        <button className="btn sm primary" onClick={() => reconnect(tab.id)}>
          <Icon name="refresh" />
          Переподключиться
        </button>
      </Placeholder>
    )
  else if (!live || !v) body = <Placeholder icon="refresh" text="Подключение…" />
  else if (v.error)
    body = (
      <Placeholder icon="warn" text={v.error}>
        <button className="btn sm" onClick={() => files.retryFiles(tab.id)}>
          <Icon name="refresh" />
          Повторить
        </button>
      </Placeholder>
    )
  else if (!v.root) body = <Placeholder icon="refresh" text="Открываю файлы сервера…" />
  else if (!v.listings[v.root])
    body = v.errors[v.root] ? (
      <Placeholder icon="warn" text={v.errors[v.root]}>
        <button className="btn sm" onClick={() => files.refresh(tab.id)}>
          <Icon name="refresh" />
          Повторить
        </button>
        {v.root !== '/' && (
          <button className="btn sm" onClick={() => files.goUp(tab.id)}>
            <Icon name="up" />
            Наверх
          </button>
        )}
        {v.home && v.home !== v.root && (
          <button className="btn sm" onClick={() => files.goHome(tab.id)}>
            <Icon name="home" />
            Домой
          </button>
        )}
      </Placeholder>
    ) : (
      <Placeholder icon="refresh" text="Загрузка…" />
    )
  else body = <Tree key={tab.id} tabId={tab.id} v={v} live={live} />

  return (
    <section className="panel files">
      <div className="panel-head">
        <span className="ph-title">Файлы</span>
        {tab && (
          <span className={`ph-chip${live ? '' : ' off'}`} title={`${tab.username}@${tab.host}`}>
            <i />
            <span>{tab.title}</span>
          </span>
        )}
        {ready && tab && v && (
          <div className="ph-actions">
            <button className="icon-btn" title="Новый файл" disabled={!rootLoaded} onClick={() => files.startCreate(tab.id, 'newfile')}>
              <Icon name="filePlus" />
            </button>
            <button className="icon-btn" title="Новая папка" disabled={!rootLoaded} onClick={() => files.startCreate(tab.id, 'newdir')}>
              <Icon name="folderPlus" />
            </button>
            <button
              className="icon-btn"
              title="Загрузить файлы на сервер"
              disabled={!rootLoaded}
              onClick={() => {
                const dir = files.targetDir(v)
                if (dir) void files.upload(tab.id, dir, { kind: 'pick-files' })
              }}
            >
              <Icon name="upload" />
            </button>
            <button className="icon-btn" title="Обновить (F5)" onClick={() => files.refresh(tab.id)}>
              <Icon name="refresh" className={busy ? 'spin' : undefined} />
            </button>
          </div>
        )}
      </div>
      {ready && tab && v && <PathBar key={tab.id} tabId={tab.id} v={v} follow={follow} />}
      {body}
      {ready && tab && v && rootLoaded && <SelectionBar tabId={tab.id} v={v} />}
      {tab?.connId && <Transfers connId={tab.connId} />}
    </section>
  )
}

/** Подпись для строки состояния: где сейчас дерево файлов («~/app» вместо «/home/user/app»). */
export function filesRootLabel(v: FilesView | undefined): string | null {
  if (!v?.root) return null
  return v.home && v.home !== '/' && isWithin(v.root, v.home) ? `~${v.root.slice(v.home.length)}` : v.root
}
