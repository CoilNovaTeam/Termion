import { useEffect, useRef, type MouseEvent, type WheelEvent } from 'react'
import { findSession } from '@shared/tree'
import { fileTone } from '../editor/languages'
import * as editors from '../editor/registry'
import { currentFolderId } from '../hooks/useShortcuts'
import {
  activateTab,
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  copyText,
  disconnectTab,
  duplicateTab,
  openDialog,
  openSession,
  reconnect,
  showMenu
} from '../store/actions'
import { isTerminal, useApp, type EditorTab, type MenuEntry, type Tab, type TerminalTab } from '../store/app'
import { loadFile, reloadFile, saveEditor, toggleWordWrap } from '../store/editors'
import { download, revealInTree } from '../store/files'
import { openServerPanel } from '../store/monitor'
import * as terminals from '../terminal/registry'
import { Icon, Logo } from './Icon'

const dotClass = (state: TerminalTab['state']) =>
  state === 'connected' ? 'ok' : state === 'connecting' || state === 'authenticating' || state === 'idle' ? 'busy' : state === 'failed' ? 'err' : ''

function TabsBar() {
  const tabs = useApp((s) => s.tabs)
  const activeTabId = useApp((s) => s.activeTabId)
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (activeTabId) barRef.current?.querySelector(`[data-tab="${activeTabId}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId])

  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY
  }

  const ownerTitle = (tab: EditorTab) => tabs.find((t) => t.id === tab.ownerId)?.title ?? ''
  // Подпись «на каком сервере» нужна, только когда открыто несколько терминалов.
  const severalServers = tabs.filter(isTerminal).length > 1

  const closeItems = (tab: Tab): MenuEntry[] => [
    { label: 'Закрыть', icon: 'x', hint: 'Ctrl+Shift+W', onSelect: () => closeTab(tab.id) },
    { label: 'Закрыть остальные', disabled: tabs.length < 2, onSelect: () => closeOtherTabs(tab.id) },
    { label: 'Закрыть все', onSelect: () => closeAllTabs() }
  ]

  const onMenu = (e: MouseEvent, tab: Tab) => {
    e.preventDefault()
    if (isTerminal(tab)) {
      const live = tab.state === 'connected' || tab.state === 'connecting' || tab.state === 'authenticating'
      showMenu(e.clientX, e.clientY, [
        { label: 'Переподключиться', icon: 'refresh', hint: 'Ctrl+Shift+R', onSelect: () => reconnect(tab.id) },
        { label: 'Отключиться', icon: 'unplug', disabled: !live, onSelect: () => disconnectTab(tab.id) },
        { label: 'Дублировать вкладку', icon: 'duplicate', hint: 'Ctrl+Shift+D', onSelect: () => duplicateTab(tab.id) },
        {
          label: 'Сведения о сервере',
          icon: 'server',
          disabled: tab.state !== 'connected',
          onSelect: () => {
            activateTab(tab.id)
            openServerPanel()
          }
        },
        'separator',
        ...closeItems(tab)
      ])
      return
    }
    showMenu(e.clientX, e.clientY, [
      { label: 'Сохранить', icon: 'save', hint: 'Ctrl+S', disabled: !tab.dirty || tab.status !== 'ready', onSelect: () => void saveEditor(tab.id) },
      { label: 'Перечитать с сервера', icon: 'refresh', hint: 'Ctrl+Shift+R', disabled: tab.status === 'loading', onSelect: () => reloadFile(tab.id) },
      { label: 'Показать в дереве файлов', icon: 'target', onSelect: () => revealInTree(tab.id) },
      { label: 'Копировать путь', icon: 'copy', onSelect: () => copyText(tab.path, 'Путь скопирован') },
      'separator',
      ...closeItems(tab)
    ])
  }

  const closeButton = (tab: Tab, dirty: boolean) => (
    <button
      className={`tab-x${dirty ? ' dirty' : ''}`}
      title={dirty ? 'Есть несохранённые изменения. Закрыть (Ctrl+Shift+W)' : 'Закрыть (Ctrl+Shift+W)'}
      onClick={(e) => {
        e.stopPropagation()
        closeTab(tab.id)
      }}
    >
      {dirty && <span className="dot" />}
      <Icon name="x" size={12} />
    </button>
  )

  return (
    <div className="tabs" role="tablist" ref={barRef} onWheel={onWheel}>
      {tabs.map((tab) => {
        const active = tab.id === activeTabId
        const common = {
          'data-tab': tab.id,
          role: 'tab',
          'aria-selected': active,
          onMouseDown: (e: MouseEvent) => {
            if (e.button === 1) e.preventDefault()
          },
          onAuxClick: (e: MouseEvent) => {
            if (e.button === 1) closeTab(tab.id)
          },
          onClick: () => activateTab(tab.id),
          onContextMenu: (e: MouseEvent) => onMenu(e, tab)
        }
        if (isTerminal(tab)) {
          return (
            <div key={tab.id} {...common} className={`tab is-term${active ? ' active' : ''}`} title={`${tab.username}@${tab.host}:${tab.port}`}>
              <span className="tab-ic">
                <Icon name="term" />
                <i className={dotClass(tab.state)} />
              </span>
              <span className="tab-name">{tab.title}</span>
              {closeButton(tab, false)}
            </div>
          )
        }
        const owner = ownerTitle(tab)
        return (
          <div key={tab.id} {...common} className={`tab is-file${active ? ' active' : ''}`} title={`${tab.path}\nна ${owner}`}>
            <span className={`tab-ic ft-${fileTone(tab.title)}`}>
              <Icon name="file" />
            </span>
            <span className="tab-name">{tab.title}</span>
            {severalServers && <span className="tab-sub">{owner}</span>}
            {closeButton(tab, tab.dirty)}
          </div>
        )
      })}
      <button
        className="tab-add"
        title="Новая сессия (Ctrl+Shift+N)"
        onClick={() => openDialog({ type: 'session', editId: null, parentId: currentFolderId() })}
      >
        <Icon name="plus" />
      </button>
    </div>
  )
}

function TerminalView({ tabId, active }: { tabId: string; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current) terminals.attach(tabId, ref.current)
  }, [tabId])
  useEffect(() => {
    if (active) terminals.activate(tabId)
  }, [active, tabId])
  return <div ref={ref} className={`term-view${active ? ' active' : ''}`} />
}

function EditorView({ tab, active }: { tab: EditorTab; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const owner = useApp((s) => s.tabs.find((t) => t.id === tab.ownerId)?.title)
  const wrap = useApp((s) => s.settings.editor.wordWrap)

  useEffect(() => {
    if (ref.current) editors.attach(tab.id, ref.current)
  }, [tab.id])

  const firstLoad = tab.status === 'loading' && !tab.meta
  return (
    <div className={`editor-view${active ? ' active' : ''}`}>
      <div className="ed-bar">
        <div className="ed-path">
          <span className={`ft-${fileTone(tab.title)}`}>
            <Icon name="file" />
          </span>
          <span className="mono" title={tab.path}>
            {tab.path}
          </span>
          {owner && <span className="ed-on">на {owner}</span>}
        </div>
        <div className="ed-actions" hidden={tab.status === 'error'}>
          <span className="ed-lang">{tab.language.label}</span>
          <button className={`icon-btn${wrap ? ' on' : ''}`} title="Перенос длинных строк (Alt+Z)" onClick={toggleWordWrap}>
            <Icon name="wrap" />
          </button>
          <button className="btn sm" title="Перечитать файл с сервера (Ctrl+Shift+R)" disabled={tab.status === 'loading'} onClick={() => reloadFile(tab.id)}>
            <Icon name="refresh" className={tab.status === 'loading' && !firstLoad ? 'spin' : undefined} />
            Перечитать
          </button>
          <button className="btn sm primary" disabled={!tab.dirty || tab.saving || tab.status !== 'ready'} onClick={() => void saveEditor(tab.id)}>
            <Icon name="save" />
            {tab.saving ? 'Сохранение…' : 'Сохранить'}
            <kbd>Ctrl S</kbd>
          </button>
        </div>
      </div>
      <div className="ed-body" ref={ref} />
      {firstLoad && (
        <div className="ed-overlay">
          <Icon name="refresh" className="spin" />
          <span>Загрузка файла…</span>
        </div>
      )}
      {tab.status === 'error' && (
        <div className="ed-overlay error">
          <span className="ed-ov-ic">
            <Icon name={tab.problem ? 'file' : 'warn'} size={22} />
          </span>
          <p>{tab.error}</p>
          <div className="ep-actions">
            {tab.problem ? (
              <button className="btn sm primary" onClick={() => void download(tab.ownerId, [tab.path])}>
                <Icon name="download" />
                Скачать на компьютер
              </button>
            ) : (
              <button className="btn sm primary" onClick={() => void loadFile(tab.id)}>
                <Icon name="refresh" />
                Повторить
              </button>
            )}
            <button className="btn sm" onClick={() => closeTab(tab.id)}>
              Закрыть вкладку
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function EmptyState() {
  const hasSessions = useApp((s) => s.tree.length > 0)
  const selected = useApp((s) => (s.selectedId ? findSession(s.tree, s.selectedId) : null))
  return (
    <div className="empty">
      <Logo size={46} />
      <h2>Termion</h2>
      <p>{hasSessions ? 'Дважды щёлкните по сессии слева, чтобы подключиться.' : 'Создайте первую сессию — и подключайтесь в один клик.'}</p>
      <div className="empty-actions">
        <button className="btn primary" onClick={() => openDialog({ type: 'session', editId: null, parentId: currentFolderId() })}>
          <Icon name="plus" />
          Новая сессия
        </button>
        {selected && (
          <button className="btn" onClick={() => openSession(selected.id)}>
            <Icon name="plug" />
            Подключить «{selected.name}»
          </button>
        )}
      </div>
      <div className="empty-keys">
        <span>
          <kbd>Ctrl K</kbd> поиск
        </span>
        <span>
          <kbd>Ctrl Shift N</kbd> новая сессия
        </span>
        <span>
          <kbd>Ctrl Tab</kbd> следующая вкладка
        </span>
        <span>
          <kbd>Ctrl S</kbd> сохранить файл
        </span>
        <span>
          <kbd>Ctrl ,</kbd> настройки
        </span>
      </div>
    </div>
  )
}

export function Workspace() {
  const tabs = useApp((s) => s.tabs)
  const activeTabId = useApp((s) => s.activeTabId)
  return (
    <main className="workspace">
      {tabs.length > 0 && <TabsBar />}
      <div className="pane">
        {tabs.map((tab) =>
          isTerminal(tab) ? (
            <TerminalView key={tab.id} tabId={tab.id} active={tab.id === activeTabId} />
          ) : (
            <EditorView key={tab.id} tab={tab} active={tab.id === activeTabId} />
          )
        )}
        {!tabs.length && <EmptyState />}
      </div>
    </main>
  )
}
