// Полоса макросов под терминалом: кнопки макросов, видимых в активной вкладке.
// Щелчок — напечатать команды в терминал, правый щелчок — изменить, перетаскивание — порядок.

import { useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react'
import { scopeMissing } from '@shared/macro'
import { findSession, locate } from '@shared/tree'
import type { Macro, TreeNode } from '@shared/types'
import { openDialog, showMenu } from '../store/actions'
import { useApp, type MenuEntry } from '../store/app'
import { askDeleteMacro, clickMacro, duplicateMacro, macroTarget, macrosFor, moveMacro, runMacro } from '../store/macros'
import { Icon, type IconName } from './Icon'

const MACRO_DRAG = 'application/x-termion-macro'

/** Подпись области макроса: значок и название папки или сессии. */
export function scopeLabel(macro: Macro, tree: readonly TreeNode[]): { icon: IconName; text: string; missing?: boolean } | null {
  const { scope } = macro
  if (scope.type === 'all') return null
  if (scope.type === 'local') return { icon: 'term', text: 'компьютер' }
  if (scopeMissing(macro, tree)) return { icon: 'warn', text: scope.type === 'folder' ? 'папка удалена' : 'сессия удалена', missing: true }
  if (scope.type === 'session') return { icon: 'server', text: findSession(tree, scope.id)?.name ?? '?' }
  const found = locate(tree, scope.id)
  return { icon: 'folder', text: found?.node.name ?? '?' }
}

function macroTooltip(macro: Macro): string {
  const lines = macro.commands.split('\n').slice(0, 12)
  const more = macro.commands.split('\n').length > 12 ? '\n…' : ''
  const extra = [macro.hotkey ? `Горячая клавиша: ${macro.hotkey}` : '', macro.enter ? '' : 'Последняя строка без Enter — проверьте и запустите сами']
    .filter(Boolean)
    .join('\n')
  return `${lines.join('\n')}${more}${extra ? `\n\n${extra}` : ''}\nПравый щелчок — изменить`
}

export function MacrosBar() {
  const show = useApp((s) => s.settings.macros.showBar)
  const macros = useApp((s) => s.macros)
  const tree = useApp((s) => s.tree)
  const target = useApp((s) => macroTarget(s))
  const runs = useApp((s) => s.macroRuns)
  const list = useMemo(() => macrosFor(target, { macros, tree }), [target, macros, tree])
  const dragRef = useRef<string | null>(null)
  const [dropBefore, setDropBefore] = useState<string | null>(null)
  if (!show) return null

  const live = target?.state === 'connected'
  const running = target ? runs[target.id] : undefined

  const onChipMenu = (e: MouseEvent, macro: Macro) => {
    e.preventDefault()
    e.stopPropagation()
    showMenu(e.clientX, e.clientY, [
      { label: 'Выполнить', icon: 'play', hint: macro.hotkey || undefined, disabled: !live, onSelect: () => void runMacro(macro.id) },
      { label: 'Изменить…', icon: 'edit', onSelect: () => openDialog({ type: 'macro', editId: macro.id }) },
      { label: 'Дублировать', icon: 'duplicate', onSelect: () => duplicateMacro(macro.id) },
      'separator',
      { label: 'Удалить', icon: 'trash', danger: true, onSelect: () => askDeleteMacro(macro.id) }
    ])
  }

  /** Все макросы, в том числе не видные в этой вкладке, — чтобы их можно было найти и изменить. */
  const onAllMenu = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const items: MenuEntry[] = macros.map((m) => {
      const scope = scopeLabel(m, tree)
      return {
        label: m.name,
        icon: 'bolt',
        hint: scope ? scope.text : 'везде',
        onSelect: () => openDialog({ type: 'macro', editId: m.id })
      }
    })
    showMenu(r.left, r.top - 8, [
      ...items,
      ...(items.length ? (['separator'] as MenuEntry[]) : []),
      { label: 'Новый макрос…', icon: 'plus', onSelect: () => openDialog({ type: 'macro', editId: null }) }
    ])
  }

  const onDragStart = (e: DragEvent, id: string) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData(MACRO_DRAG, id)
    dragRef.current = id
  }
  const onDragOver = (e: DragEvent, id: string | null) => {
    if (!dragRef.current || !e.dataTransfer.types.includes(MACRO_DRAG)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dropBefore !== id) setDropBefore(id)
  }
  const onDrop = (e: DragEvent, id: string | null) => {
    if (!dragRef.current) return
    e.preventDefault()
    moveMacro(dragRef.current, id)
    dragRef.current = null
    setDropBefore(null)
  }
  const endDrag = () => {
    dragRef.current = null
    setDropBefore(null)
  }

  return (
    <div
      className="macros"
      onContextMenu={(e) => {
        e.preventDefault()
        showMenu(e.clientX, e.clientY, [{ label: 'Новый макрос…', icon: 'plus', onSelect: () => openDialog({ type: 'macro', editId: null }) }])
      }}
    >
      <span className="mac-label">
        <Icon name="bolt" />
        Макросы
      </span>
      <div className="mac-list">
        {list.map((m) => {
          const scope = scopeLabel(m, tree)
          return (
            <button
              key={m.id}
              className={`chip${running === m.id ? ' running' : ''}${dropBefore === m.id ? ' drop-before' : ''}`}
              data-off={live ? undefined : '1'}
              title={macroTooltip(m)}
              draggable
              onClick={() => clickMacro(m.id)}
              onContextMenu={(e) => onChipMenu(e, m)}
              onDragStart={(e) => onDragStart(e, m.id)}
              onDragOver={(e) => onDragOver(e, m.id)}
              onDrop={(e) => onDrop(e, m.id)}
              onDragEnd={endDrag}
            >
              <Icon name={running === m.id ? 'refresh' : 'play'} className={running === m.id ? 'spin' : undefined} />
              <span>{m.name}</span>
              {scope && (
                <span className={`scope${scope.missing ? ' missing' : ''}`}>
                  <Icon name={scope.icon} />
                  {scope.text}
                </span>
              )}
            </button>
          )
        })}
        <button
          className={`chip chip-add${dropBefore === null && dragRef.current ? ' drop-before' : ''}`}
          title="Новый макрос"
          onClick={() => openDialog({ type: 'macro', editId: null })}
          onDragOver={(e) => onDragOver(e, null)}
          onDrop={(e) => onDrop(e, null)}
        >
          <Icon name="plus" />
          <span>Макрос</span>
        </button>
      </div>
      {macros.length > 0 && (
        <button className="icon-btn mac-all" title={`Все макросы (${macros.length})`} onClick={onAllMenu}>
          <Icon name="more" />
        </button>
      )}
    </div>
  )
}
