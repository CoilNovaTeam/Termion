// Панель крупных кнопок и полоса слева — только для раскладки «Как в MobaXterm».

import { findSession } from '@shared/tree'
import { currentFolderId } from '../hooks/useShortcuts'
import { openDialog, openSession, setSide, toast } from '../store/actions'
import { getState, isTerminal, useApp } from '../store/app'
import { Icon } from './Icon'

export function connectSelected(): void {
  const { tree, selectedId } = getState()
  const session = selectedId ? findSession(tree, selectedId) : null
  if (session) openSession(session.id)
  else toast('Выберите сессию в списке', 'info')
}

export function Toolbar() {
  const side = useApp((s) => s.side)
  return (
    <div className="toolbar">
      <button className="tb" onClick={() => openDialog({ type: 'session', editId: null, parentId: currentFolderId() })}>
        <Icon name="plus" />
        <span>Сессия</span>
      </button>
      <button className="tb" onClick={connectSelected}>
        <Icon name="plug" />
        <span>Подключить</span>
      </button>
      <div className="tb-sep" />
      <button className={`tb${side === 'files' ? ' on' : ''}`} onClick={() => setSide(side === 'files' ? 'sessions' : 'files')}>
        <Icon name="folder" />
        <span>Файлы</span>
      </button>
      <div className="tb-sep" />
      <button className="tb" onClick={() => openDialog({ type: 'settings' })}>
        <Icon name="gear" />
        <span>Настройки</span>
      </button>
    </div>
  )
}

export function Rail() {
  const side = useApp((s) => s.side)
  const live = useApp((s) => s.tabs.some((t) => isTerminal(t) && t.state === 'connected'))
  return (
    <nav className="rail">
      <button className={`rail-btn${side === 'sessions' ? ' on' : ''}`} title="Сессии" onClick={() => setSide('sessions')}>
        <Icon name="server" />
      </button>
      <button className={`rail-btn${side === 'files' ? ' on' : ''}`} title="Файлы на сервере" onClick={() => setSide('files')}>
        <Icon name="folder" />
        {live && <i className="badge" />}
      </button>
      <div className="spacer" />
      <button className="rail-btn" title="Настройки" onClick={() => openDialog({ type: 'settings' })}>
        <Icon name="gear" />
      </button>
    </nav>
  )
}
