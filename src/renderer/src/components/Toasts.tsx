import { dismissToast } from '../store/actions'
import { useApp } from '../store/app'
import { Icon } from './Icon'

export function Toasts() {
  const toasts = useApp((s) => s.toasts)
  if (!toasts.length) return null
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismissToast(t.id)}>
          <Icon name={t.kind === 'error' ? 'warn' : t.kind === 'success' ? 'check' : 'info'} size={15} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  )
}
