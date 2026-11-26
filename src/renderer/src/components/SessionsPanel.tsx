import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { countSessions, flatten, isInside, locate, type FlatRow } from '@shared/tree'
import { currentFolderId } from '../hooks/useShortcuts'
import {
  askDelete,
  copyText,
  duplicateSession,
  moveTo,
  openDialog,
  openSession,
  select,
  setAllFolders,
  setFilter,
  showMenu,
  toggleFolder
} from '../store/actions'
import { getState, isTerminal, useApp, type TerminalTab } from '../store/app'
import { Icon } from './Icon'

type DropPos = 'before' | 'after' | 'inside'
interface DropTarget {
  id: string | null
  pos: DropPos | 'root'
}

const DRAG_TYPE = 'application/x-termion-node'

function highlight(text: string, query: string): ReactNode {
  const q = query.trim().toLowerCase()
  const i = q ? text.toLowerCase().indexOf(q) : -1
  if (i < 0) return text
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  )
}

function editNode(id: string): void {
  const found = locate(getState().tree, id)
  if (!found) return
  openDialog({ type: found.node.type, editId: id, parentId: found.parent?.id ?? null })
}

export function SessionsPanel() {
  const tree = useApp((s) => s.tree)
  const filter = useApp((s) => s.filter)
  const selectedId = useApp((s) => s.selectedId)
  const tabs = useApp((s) => s.tabs)
  const focusToken = useApp((s) => s.searchFocusToken)

  const rows = useMemo(() => flatten(tree, filter), [tree, filter])
  const live = useMemo(() => new Set(tabs.filter((t): t is TerminalTab => isTerminal(t) && t.state === 'connected').map((t) => t.sessionId)), [tabs])
  const total = useMemo(() => countSessions(tree), [tree])
  const anyExpanded = useMemo(() => rows.some((r) => r.node.type === 'folder' && r.open), [rows])

  const searchRef = useRef<HTMLInputElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  // Перетаскиваемый узел — в ref: события перетаскивания идут чаще перерисовок,
  // и обработчики должны видеть актуальное значение. Состояние — только для подсветки.
  const dragRef = useRef<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [drop, setDrop] = useState<DropTarget | null>(null)

  useEffect(() => {
    if (!focusToken) return
    searchRef.current?.focus()
    searchRef.current?.select()
  }, [focusToken])

  useEffect(() => {
    if (!selectedId) return
    treeRef.current?.querySelector(`[data-id="${selectedId}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  // ---------- клавиатура ----------

  const onTreeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!rows.length) return
    const index = rows.findIndex((r) => r.node.id === selectedId)
    const row: FlatRow | undefined = rows[index]
    const go = (i: number) => select(rows[Math.max(0, Math.min(rows.length - 1, i))].node.id)
    switch (e.key) {
      case 'ArrowDown':
        go(index < 0 ? 0 : index + 1)
        break
      case 'ArrowUp':
        go(index < 0 ? 0 : index - 1)
        break
      case 'Home':
        go(0)
        break
      case 'End':
        go(rows.length - 1)
        break
      case 'ArrowRight':
        if (row?.node.type === 'folder') {
          if (!row.open) toggleFolder(row.node.id, true)
          else go(index + 1)
        }
        break
      case 'ArrowLeft':
        if (row?.node.type === 'folder' && row.open && !filter) toggleFolder(row.node.id, false)
        else if (row?.parentId) select(row.parentId)
        break
      case 'Enter':
        if (!row) return
        if (row.node.type === 'session') openSession(row.node.id)
        else toggleFolder(row.node.id)
        break
      case 'F2':
        if (row) editNode(row.node.id)
        break
      case 'Delete':
        if (row) askDelete(row.node.id)
        break
      default:
        return
    }
    e.preventDefault()
  }

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setFilter('')
      treeRef.current?.focus()
    } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault()
      const first = rows.find((r) => r.node.type === 'session')
      if (first) {
        select(first.node.id)
        if (e.key === 'Enter') openSession(first.node.id)
        else treeRef.current?.focus()
      }
    }
  }

  // ---------- мышь и меню ----------

  const onRowClick = (row: FlatRow) => {
    select(row.node.id)
    if (row.node.type === 'folder' && !filter) toggleFolder(row.node.id)
  }

  const onRowMenu = (e: MouseEvent, row: FlatRow) => {
    e.preventDefault()
    e.stopPropagation()
    const node = row.node
    select(node.id)
    if (node.type === 'session') {
      showMenu(e.clientX, e.clientY, [
        { label: 'Подключиться', icon: 'plug', hint: 'Enter', onSelect: () => openSession(node.id) },
        { label: 'Изменить…', icon: 'edit', hint: 'F2', onSelect: () => editNode(node.id) },
        { label: 'Дублировать', icon: 'duplicate', onSelect: () => void duplicateSession(node.id) },
        { label: 'Копировать адрес', icon: 'copy', onSelect: () => copyText(`${node.username}@${node.host}`, 'Адрес скопирован') },
        { label: 'Новый макрос для сессии…', icon: 'bolt', onSelect: () => openDialog({ type: 'macro', editId: null, scope: { type: 'session', id: node.id } }) },
        'separator',
        { label: 'Удалить', icon: 'trash', hint: 'Del', danger: true, onSelect: () => askDelete(node.id) }
      ])
    } else {
      showMenu(e.clientX, e.clientY, [
        { label: 'Новая сессия здесь', icon: 'plus', onSelect: () => openDialog({ type: 'session', editId: null, parentId: node.id }) },
        { label: 'Новая папка внутри', icon: 'folderPlus', onSelect: () => openDialog({ type: 'folder', editId: null, parentId: node.id }) },
        { label: 'Переименовать…', icon: 'edit', hint: 'F2', onSelect: () => editNode(node.id) },
        { label: 'Новый макрос для папки…', icon: 'bolt', onSelect: () => openDialog({ type: 'macro', editId: null, scope: { type: 'folder', id: node.id } }) },
        'separator',
        { label: 'Удалить папку', icon: 'trash', hint: 'Del', danger: true, onSelect: () => askDelete(node.id) }
      ])
    }
  }

  const onTreeMenu = (e: MouseEvent) => {
    e.preventDefault()
    showMenu(e.clientX, e.clientY, [
      { label: 'Новая сессия', icon: 'plus', hint: 'Ctrl+Shift+N', onSelect: () => openDialog({ type: 'session', editId: null, parentId: null }) },
      { label: 'Новая папка', icon: 'folderPlus', onSelect: () => openDialog({ type: 'folder', editId: null, parentId: null }) },
      'separator',
      { label: 'Свернуть все папки', icon: 'collapse', onSelect: () => setAllFolders(false) },
      { label: 'Развернуть все папки', icon: 'expand', onSelect: () => setAllFolders(true) }
    ])
  }

  // ---------- перетаскивание ----------

  /** Куда упадёт узел при отпускании над строкой row (или null, если сюда нельзя). */
  const dropPosition = (e: DragEvent<HTMLElement>, row: FlatRow): DropPos | null => {
    const id = dragRef.current
    if (!id || id === row.node.id) return null
    const rect = e.currentTarget.getBoundingClientRect()
    const y = rect.height ? (e.clientY - rect.top) / rect.height : 0.5
    const pos: DropPos =
      row.node.type === 'folder' ? (y < 0.28 ? 'before' : y > 0.72 && !row.open ? 'after' : 'inside') : y < 0.5 ? 'before' : 'after'
    const parent = pos === 'inside' ? row.node.id : row.parentId
    const dragged = locate(tree, id)?.node
    // Папку нельзя положить внутрь самой себя или своих подпапок.
    if (dragged?.type === 'folder' && parent && isInside(tree, id, parent)) return null
    return pos
  }

  const onDragStart = (e: DragEvent, id: string) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData(DRAG_TYPE, id)
    dragRef.current = id
    setDragId(id)
  }

  const onRowDragOver = (e: DragEvent<HTMLDivElement>, row: FlatRow) => {
    if (!dragRef.current) return
    e.stopPropagation()
    const pos = dropPosition(e, row)
    if (!pos) {
      if (drop) setDrop(null)
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (drop?.id !== row.node.id || drop.pos !== pos) setDrop({ id: row.node.id, pos })
  }

  const onRowDrop = (e: DragEvent<HTMLDivElement>, row: FlatRow) => {
    e.preventDefault()
    e.stopPropagation()
    const id = dragRef.current
    const pos = dropPosition(e, row)
    endDrag()
    if (!id || !pos) return
    if (pos === 'inside') {
      void moveTo(id, row.node.id, null)
    } else if (pos === 'before') {
      void moveTo(id, row.parentId, row.node.id)
    } else {
      const found = locate(tree, row.node.id)
      const siblings = found?.parent ? found.parent.children : tree
      let next = found ? siblings[found.index + 1] : undefined
      if (next?.id === id) next = found ? siblings[found.index + 2] : undefined
      void moveTo(id, row.parentId, next?.id ?? null)
    }
  }

  const onTreeDragOver = (e: DragEvent) => {
    if (!dragRef.current) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (drop?.pos !== 'root') setDrop({ id: null, pos: 'root' })
  }

  const onTreeDrop = (e: DragEvent) => {
    e.preventDefault()
    const id = dragRef.current
    endDrag()
    if (id) void moveTo(id, null, null)
  }

  function endDrag() {
    dragRef.current = null
    setDragId(null)
    setDrop(null)
  }

  // ---------- отрисовка ----------

  return (
    <section className="panel sessions">
      <div className="panel-head">
        <span className="ph-title">Сессии</span>
        <span className="ph-count">{total}</span>
        <div className="ph-actions">
          <button
            className="icon-btn"
            title="Новая сессия (Ctrl+Shift+N)"
            onClick={() => openDialog({ type: 'session', editId: null, parentId: currentFolderId() })}
          >
            <Icon name="plus" />
          </button>
          <button className="icon-btn" title="Новая папка" onClick={() => openDialog({ type: 'folder', editId: null, parentId: currentFolderId() })}>
            <Icon name="folderPlus" />
          </button>
          <button
            className="icon-btn"
            title={anyExpanded ? 'Свернуть все папки' : 'Развернуть все папки'}
            onClick={() => setAllFolders(!anyExpanded)}
          >
            <Icon name={anyExpanded ? 'collapse' : 'expand'} />
          </button>
        </div>
      </div>

      <label className="search">
        <Icon name="search" size={14} />
        <input
          ref={searchRef}
          value={filter}
          placeholder="Поиск сессий…"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={onSearchKey}
        />
        {filter && (
          <button className="clear" title="Очистить" onClick={() => setFilter('')}>
            <Icon name="x" size={12} />
          </button>
        )}
      </label>

      <div
        ref={treeRef}
        className={`tree${drop?.pos === 'root' ? ' drop-root' : ''}`}
        role="tree"
        tabIndex={0}
        onKeyDown={onTreeKey}
        onContextMenu={onTreeMenu}
        onDragOver={onTreeDragOver}
        onDrop={onTreeDrop}
      >
        {rows.map((row) => {
          const n = row.node
          const isFolder = n.type === 'folder'
          const isLive = !isFolder && live.has(n.id)
          const cls = [
            'row',
            isFolder ? 'folder' : 'sess',
            row.open && 'open',
            selectedId === n.id && 'selected',
            dragId === n.id && 'dragging',
            drop?.id === n.id && `drop-${drop.pos}`
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <div
              key={n.id}
              data-id={n.id}
              className={cls}
              role="treeitem"
              aria-selected={selectedId === n.id}
              aria-expanded={isFolder ? row.open : undefined}
              style={{ '--d': row.depth } as CSSProperties}
              title={n.type === 'session' ? `${n.username}@${n.host}:${n.port} — двойной клик, чтобы подключиться` : undefined}
              draggable={!filter}
              onClick={() => onRowClick(row)}
              onDoubleClick={() => n.type === 'session' && openSession(n.id)}
              onContextMenu={(e) => onRowMenu(e, row)}
              onDragStart={(e) => onDragStart(e, n.id)}
              onDragOver={(e) => onRowDragOver(e, row)}
              onDrop={(e) => onRowDrop(e, row)}
              onDragEnd={endDrag}
            >
              <span className="chev">{isFolder && <Icon name="chev" size={14} />}</span>
              <span className={`ri${isFolder ? ' fi-folder' : isLive ? ' live' : ''}`}>
                <Icon name={isFolder ? 'folder' : 'server'} />
                {isLive && <i className="sdot" />}
              </span>
              <span className="rn">{highlight(n.name, filter)}</span>
              {n.type === 'folder' ? (
                <span className="cnt">{countSessions(n.children)}</span>
              ) : (
                <span className="meta mono">{n.host}</span>
              )}
            </div>
          )
        })}

        {!total && (
          <div className="tree-empty">
            <div className="big">
              <Icon name="server" size={22} />
            </div>
            <b>Сессий пока нет</b>
            <span>Добавьте сервер: адрес, логин и, по желанию, пароль. Дальше — подключение в один клик.</span>
            <button className="btn primary sm" onClick={() => openDialog({ type: 'session', editId: null, parentId: null })}>
              <Icon name="plus" />
              Новая сессия
            </button>
          </div>
        )}
        {!!total && !rows.length && <div className="tree-empty">Ничего не найдено по запросу «{filter.trim()}»</div>}
      </div>
    </section>
  )
}
