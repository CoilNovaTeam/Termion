import { focusSearch, openDialog } from '../store/actions'
import { Icon, Logo } from './Icon'

export function TitleBar() {
  return (
    <header className="titlebar">
      <div className="brand">
        <Logo size={18} />
        <span className="brand-name">Termion</span>
      </div>
      <button className="search-trigger" onClick={focusSearch} title="Поиск сессий (Ctrl+K)">
        <Icon name="search" size={14} />
        <span>Поиск сессий…</span>
        <kbd>Ctrl K</kbd>
      </button>
      <div className="titlebar-spacer" />
      <button className="titlebar-btn" title="Настройки (Ctrl+,)" onClick={() => openDialog({ type: 'settings' })}>
        <Icon name="gear" />
      </button>
    </header>
  )
}
