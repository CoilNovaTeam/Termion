import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from '../Icon'

interface ModalProps {
  title: string
  subtitle?: string
  icon?: IconName
  tone?: 'default' | 'danger' | 'warning'
  width?: number
  onCancel: () => void
  /** Щелчок по затемнению закрывает окно (для вопросов от SSH — нет). */
  closeOnBackdrop?: boolean
  footer: ReactNode
  children: ReactNode
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

export function Modal({ title, subtitle, icon, tone = 'default', width, onCancel, closeOnBackdrop = true, footer, children }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = ref.current
    if (!root) return
    const target = root.querySelector<HTMLElement>('[data-autofocus]') ?? root.querySelector<HTMLElement>('.modal-body input, .modal-body select')
    ;(target ?? root).focus()
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onCancel()
      return
    }
    if (e.key !== 'Tab' || !ref.current) return
    // Фокус не уходит за пределы окна.
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null)
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        ref={ref}
        className={`modal${tone !== 'default' ? ` ${tone}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={width ? { width: `min(${width}px, calc(100vw - 32px))` } : undefined}
        onKeyDown={onKeyDown}
      >
        <div className="modal-head">
          {icon && (
            <span className="mh-ic">
              <Icon name={icon} />
            </span>
          )}
          <h3>
            {title}
            {subtitle && (
              <div style={{ fontSize: 11.5, fontWeight: 400, color: 'var(--text-faint)', marginTop: 2 }}>{subtitle}</div>
            )}
          </h3>
          <button className="icon-btn" title="Закрыть (Esc)" onClick={onCancel}>
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        <div className="modal-foot">{footer}</div>
      </div>
    </div>,
    document.body
  )
}
