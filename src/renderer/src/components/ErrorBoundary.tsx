import { Component, type ReactNode } from 'react'
import { Icon } from './Icon'

interface Props {
  children?: ReactNode
  /** Показать ошибку сразу (например, если не удалось загрузить данные). */
  fatal?: string
}

interface State {
  error: string | null
}

/** Если в интерфейсе случится непредвиденная ошибка — понятный экран вместо белого окна. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: this.props.fatal ?? null }

  static getDerivedStateFromError(err: unknown): State {
    return { error: err instanceof Error ? err.message : String(err) }
  }

  override render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="empty">
        <div className="mh-ic" style={{ width: 44, height: 44, background: 'var(--err-soft)', color: 'var(--err)' }}>
          <Icon name="warn" size={22} />
        </div>
        <h2>Что-то пошло не так</h2>
        <p style={{ maxWidth: 460, userSelect: 'text' }}>{this.state.error}</p>
        <div className="empty-actions">
          <button className="btn primary" onClick={() => location.reload()}>
            <Icon name="refresh" />
            Перезапустить интерфейс
          </button>
        </div>
      </div>
    )
  }
}
