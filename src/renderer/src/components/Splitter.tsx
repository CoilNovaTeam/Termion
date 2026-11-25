import { useRef, useState, type PointerEvent } from 'react'
import { DEFAULT_SETTINGS } from '@shared/validate'
import { updateSettings } from '../store/actions'
import { useApp } from '../store/app'

const MIN = 200
const MAX = 520

/** Перетаскиваемая граница левой панели. Двойной клик — ширина по умолчанию. */
export function Splitter() {
  const layout = useApp((s) => s.settings.layout)
  const [dragging, setDragging] = useState(false)
  const start = useRef({ x: 0, width: 0 })

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    start.current = { x: e.clientX, width: useApp.getState().settings.sidebarWidth }
    setDragging(true)
  }

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    const width = Math.round(Math.min(MAX, Math.max(MIN, start.current.width + e.clientX - start.current.x)))
    updateSettings((s) => (s.sidebarWidth === width ? s : { ...s, sidebarWidth: width }))
  }

  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    setDragging(false)
  }

  return (
    <div
      className={`splitter${dragging ? ' dragging' : ''}`}
      data-layout={layout}
      title="Потяните, чтобы изменить ширину"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={() => updateSettings((s) => ({ ...s, sidebarWidth: DEFAULT_SETTINGS.sidebarWidth }))}
    />
  )
}
