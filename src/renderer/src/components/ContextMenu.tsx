import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { hideMenu } from '../store/actions'
import { useApp, type MenuItem } from '../store/app'
import { Icon } from './Icon'

export function ContextMenu() {
  const menu = useApp((s) => s.menu)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [focus, setFocus] = useState(-1)

  // Меню не должно вылезать за край окна.
  useLayoutEffect(() => {
    if (!menu || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    setPos({
      x: Math.max(6, Math.min(menu.x, window.innerWidth - r.width - 6)),
      y: Math.max(6, Math.min(menu.y, window.innerHeight - r.height - 6))
    })
    setFocus(-1)
    ref.current.focus()
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const close = (e: Event) => {
      if (e.type === 'mousedown' && ref.current?.contains(e.target as Node)) return
      hideMenu()
    }
    window.addEventListener('mousedown', close, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('wheel', close, { passive: true })
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('wheel', close)
    }
  }, [menu])

  if (!menu) return null

  const items = menu.items
  const actionable = items.map((it, i) => (it !== 'separator' && !it.disabled ? i : -1)).filter((i) => i >= 0)

  const run = (item: MenuItem) => {
    hideMenu()
    item.onSelect()
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      hideMenu()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const at = actionable.indexOf(focus)
      const next = e.key === 'ArrowDown' ? actionable[(at + 1) % actionable.length] : actionable[(at - 1 + actionable.length) % actionable.length]
      setFocus(next ?? -1)
    } else if (e.key === 'Enter' && focus >= 0) {
      const item = items[focus]
      if (item !== 'separator') run(item)
    } else {
      return
    }
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div ref={ref} className="ctx" role="menu" tabIndex={-1} style={{ left: pos.x, top: pos.y }} onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()}>
      {items.map((item, i) =>
        item === 'separator' ? (
          <div key={`sep-${i}`} className="ctx-sep" />
        ) : (
          <button
            key={item.label}
            role={item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={item.checked}
            className={`ctx-item${item.danger ? ' danger' : ''}${focus === i ? ' focus' : ''}`}
            disabled={item.disabled}
            onMouseEnter={() => setFocus(i)}
            onClick={() => run(item)}
          >
            {item.checked !== undefined ? (
              item.checked ? (
                <Icon name="check" className="ctx-check" />
              ) : (
                <span style={{ width: 16 }} />
              )
            ) : item.icon ? (
              <Icon name={item.icon} className={item.iconClass} />
            ) : (
              <span style={{ width: 16 }} />
            )}
            <span>{item.label}</span>
            {item.hint && <span className="hint">{item.hint}</span>}
          </button>
        )
      )}
    </div>
  )
}
