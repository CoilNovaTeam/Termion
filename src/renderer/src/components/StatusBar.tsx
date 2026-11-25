import type { MouseEvent } from 'react'
import type { EolId, TextEncodingId } from '@shared/types'
import * as editors from '../editor/registry'
import { showMenu } from '../store/actions'
import { isEditor, isTerminal, useApp, type EditorTab, type TerminalTab } from '../store/app'
import { setFormat } from '../store/editors'
import { filesRootLabel } from './FilesPanel'
import { Icon } from './Icon'
import { ServerMeters } from './ServerPanel'

const STATE_TEXT: Record<TerminalTab['state'], string> = {
  idle: 'Подготовка…',
  connecting: 'Подключение…',
  authenticating: 'Вход…',
  connected: 'Подключено',
  closed: 'Отключено',
  failed: 'Ошибка подключения'
}

const dot = (state: TerminalTab['state']) =>
  state === 'connected' ? 'ok' : state === 'failed' ? 'err' : state === 'closed' ? '' : 'busy'

const ENCODINGS: [TextEncodingId, string, string][] = [
  ['utf8', 'UTF-8', 'UTF-8'],
  ['utf8-bom', 'UTF-8 с BOM', 'UTF-8 BOM'],
  ['cp1251', 'Windows-1251 (кириллица)', 'Windows-1251']
]

const EOLS: [EolId, string][] = [
  ['lf', 'LF — Linux, macOS'],
  ['crlf', 'CRLF — Windows']
]

function EditorStatus({ tab }: { tab: EditorTab }) {
  const owner = useApp((s) => s.tabs.find((t) => t.id === tab.ownerId)?.title)
  const ready = tab.status === 'ready'

  const menuAt = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: r.left, y: r.top - 4 }
  }
  const encodingMenu = (e: MouseEvent<HTMLButtonElement>) => {
    const { x, y } = menuAt(e)
    showMenu(
      x,
      y,
      ENCODINGS.map(([id, label]) => ({ label, checked: tab.encoding === id, onSelect: () => setFormat(tab.id, { encoding: id }) }))
    )
  }
  const eolMenu = (e: MouseEvent<HTMLButtonElement>) => {
    const { x, y } = menuAt(e)
    showMenu(
      x,
      y,
      EOLS.map(([id, label]) => ({ label, checked: tab.eol === id, onSelect: () => setFormat(tab.id, { eol: id }) }))
    )
  }

  return (
    <footer className="status">
      <span className="st st-path" title={tab.path}>
        <Icon name="file" />
        <span className="mono">{tab.path}</span>
      </span>
      {owner && <span className="st">на {owner}</span>}
      {ready &&
        (tab.saving ? (
          <span className="st">Сохранение…</span>
        ) : tab.dirty ? (
          <span className="st st-warn">● Не сохранено</span>
        ) : (
          <span className="st">
            <Icon name="check" />
            Сохранено
          </span>
        ))}
      {ready && (
        <div className="st-right">
          <button className="st st-btn" title="Перейти к строке (Ctrl+G)" onClick={() => editors.gotoLine(tab.id)}>
            Стр {tab.line}, стлб {tab.col}
          </button>
          <span className="st">{tab.language.label}</span>
          <button className="st st-btn" title="Кодировка, в которой файл будет сохранён" onClick={encodingMenu}>
            {ENCODINGS.find(([id]) => id === tab.encoding)?.[2]}
          </button>
          <button className="st st-btn" title="Окончания строк" onClick={eolMenu}>
            {tab.eol.toUpperCase()}
          </button>
          <span className="st">Строк: {tab.lines.toLocaleString('ru-RU')}</span>
        </div>
      )}
    </footer>
  )
}

function TerminalStatus({ tab }: { tab: TerminalTab }) {
  const sessions = useApp((s) => s.tabs.filter((t) => isTerminal(t) && t.state === 'connected').length)
  const filesRoot = useApp((s) => filesRootLabel(s.files[tab.id]))
  const meters = useApp((s) => s.settings.monitor.statusBar)
  const target = `${tab.username}@${tab.host.includes(':') ? `[${tab.host}]` : tab.host}:${tab.port}`
  return (
    <footer className="status">
      <span className="st">
        <i className={`st-dot ${dot(tab.state)}`} />
        {STATE_TEXT[tab.state]}
      </span>
      <span className="st mono">{target}</span>
      {tab.info && (
        <>
          <span className="st" title={`Вход: ${tab.info.authMethod}`}>
            <Icon name={tab.auth === 'password' ? 'lock' : tab.auth === 'agent' ? 'agent' : 'key'} />
            {tab.info.authMethod}
          </span>
          <span className="st" title={`Ключ сервера ${tab.info.hostKeyType} ${tab.info.fingerprint}`}>
            <Icon name="shield" />
            {tab.info.hostKeyType}
          </span>
        </>
      )}
      <div className="st-right">
        {sessions > 1 && <span className="st">Подключений: {sessions}</span>}
        {tab.state === 'connected' && meters && tab.connId && <ServerMeters connId={tab.connId} />}
        {tab.state === 'connected' && filesRoot && (
          <span className="st st-path" title="Папка в дереве файлов">
            <Icon name="folder" />
            <span className="mono">{filesRoot}</span>
          </span>
        )}
        {tab.cols > 0 && (
          <span className="st mono">
            {tab.cols}×{tab.rows}
          </span>
        )}
      </div>
    </footer>
  )
}

export function StatusBar() {
  const tab = useApp((s) => s.tabs.find((t) => t.id === s.activeTabId))
  if (isEditor(tab)) return <EditorStatus tab={tab} />
  if (isTerminal(tab)) return <TerminalStatus tab={tab} />
  return (
    <footer className="status">
      <span className="st">
        <Icon name="info" />
        Нет открытых вкладок — дважды щёлкните по сессии в списке
      </span>
    </footer>
  )
}
