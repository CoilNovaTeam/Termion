// Макросы: сохранённые команды, которые печатаются в терминал одним нажатием — как будто
// их ввели вручную. Запуск — кнопкой на полосе макросов, горячей клавишей или сам после
// входа в сессию («После входа выполнить» в настройках сессии).

import { macroApplies, macroChunks } from '@shared/macro'
import { findSession, newId } from '@shared/tree'
import type { Macro } from '@shared/types'
import { api, errorText } from '../api'
import * as terminals from '../terminal/registry'
import { activateTab, confirmAction, terminalTab, toast } from './actions'
import { getState, isEditor, isTerminal, setState, type AppState, type TerminalTab } from './app'

// ---------- хранение ----------

let saving: Promise<void> = Promise.resolve()

/** Сохранить список: сразу на экране, затем в macros.json. При ошибке — откат. */
function persist(next: Macro[]): Promise<void> {
  const previous = getState().macros
  setState({ macros: next })
  saving = saving
    .catch(() => undefined)
    .then(async () => {
      try {
        await api.macros.save(next)
      } catch (err) {
        setState({ macros: previous })
        toast(`Не удалось сохранить макросы: ${errorText(err)}`, 'error', 6000)
        throw err
      }
    })
  return saving
}

export async function saveMacro(macro: Omit<Macro, 'id'> & { id: string | null }): Promise<string> {
  const id = macro.id ?? newId()
  const item: Macro = { ...macro, id }
  const list = getState().macros
  const next = list.some((m) => m.id === id) ? list.map((m) => (m.id === id ? item : m)) : [...list, item]
  await persist(next)
  return id
}

export function askDeleteMacro(id: string, after?: () => void): void {
  const macro = getState().macros.find((m) => m.id === id)
  if (!macro) return
  confirmAction({
    title: 'Удалить макрос?',
    message: `Макрос «${macro.name}» будет удалён. Сессии, которые запускали его после входа, просто перестанут это делать.`,
    confirmLabel: 'Удалить',
    danger: true,
    onConfirm: async () => {
      await persist(getState().macros.filter((m) => m.id !== id))
      toast('Макрос удалён', 'success')
      after?.()
    }
  })
}

export function duplicateMacro(id: string): void {
  const list = getState().macros
  const i = list.findIndex((m) => m.id === id)
  if (i < 0) return
  const copy: Macro = { ...list[i], id: newId(), name: `${list[i].name} (копия)`, hotkey: '' }
  void persist([...list.slice(0, i + 1), copy, ...list.slice(i + 1)]).catch(() => undefined)
}

/** Переставить макрос на полосе (перетаскиванием). */
export function moveMacro(id: string, beforeId: string | null): void {
  const list = getState().macros
  const item = list.find((m) => m.id === id)
  if (!item || id === beforeId) return
  const rest = list.filter((m) => m.id !== id)
  const at = beforeId ? rest.findIndex((m) => m.id === beforeId) : rest.length
  rest.splice(at < 0 ? rest.length : at, 0, item)
  void persist(rest).catch(() => undefined)
}

// ---------- где виден ----------

/** Вкладка-терминал, в которой запускать макрос: активная или та, через которую открыт файл. */
export function macroTarget(s: Pick<AppState, 'tabs' | 'activeTabId'>): TerminalTab | null {
  const active = s.tabs.find((t) => t.id === s.activeTabId)
  if (isTerminal(active)) return active
  if (isEditor(active)) {
    const owner = s.tabs.find((t) => t.id === active.ownerId)
    return isTerminal(owner) ? owner : null
  }
  return null
}

export function macrosFor(tab: TerminalTab | null, s: Pick<AppState, 'macros' | 'tree'>): Macro[] {
  if (!tab) return s.macros
  return s.macros.filter((m) => macroApplies(m, { local: !!tab.local, sessionId: tab.sessionId }, s.tree))
}

// ---------- запуск ----------

const runs = new Map<string, { cancelled: boolean }>()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function markRun(tabId: string, macroId: string | null): void {
  setState((s) => {
    const macroRuns = { ...s.macroRuns }
    if (macroId) macroRuns[tabId] = macroId
    else delete macroRuns[tabId]
    return { macroRuns }
  })
}

/**
 * Напечатать макрос в терминал вкладки (по умолчанию — активной). quiet — без переключения
 * на вкладку и без подсказок (запуск после входа).
 */
export async function runMacro(macroId: string, tabId?: string, quiet = false): Promise<void> {
  const macro = getState().macros.find((m) => m.id === macroId)
  if (!macro) return
  const tab = tabId ? (terminalTab(tabId) ?? null) : macroTarget(getState())
  if (!tab) {
    if (!quiet) toast('Откройте вкладку терминала — макрос выполняется в ней', 'info')
    return
  }
  if (tab.state !== 'connected' || !tab.connId) {
    if (!quiet) toast(tab.local ? 'Терминал завершён — запустите его заново (Enter)' : 'Нет подключения — переподключитесь (Ctrl+Shift+R)', 'error')
    return
  }
  if (runs.has(tab.id)) {
    if (!quiet) toast('В этой вкладке уже выполняется макрос — щёлкните по нему, чтобы остановить', 'info')
    return
  }
  const connId = tab.connId
  if (!quiet) {
    if (getState().activeTabId !== tab.id) activateTab(tab.id)
    else terminals.focus(tab.id)
  }
  const chunks = macroChunks(macro.commands, macro.enter)
  if (!macro.delay) {
    api.ssh.write(connId, chunks.join(''))
    markRun(tab.id, macro.id)
    setTimeout(() => {
      if (getState().macroRuns[tab.id] === macro.id && !runs.has(tab.id)) markRun(tab.id, null)
    }, 450)
    return
  }
  // С паузами: по строке, пока вкладка подключена и макрос не остановили.
  const run = { cancelled: false }
  runs.set(tab.id, run)
  markRun(tab.id, macro.id)
  try {
    for (let i = 0; i < chunks.length; i++) {
      const cur = terminalTab(tab.id)
      if (run.cancelled || cur?.connId !== connId || cur.state !== 'connected') break
      api.ssh.write(connId, chunks[i])
      if (i < chunks.length - 1) await sleep(macro.delay)
    }
  } finally {
    runs.delete(tab.id)
    markRun(tab.id, null)
  }
}

/** Остановить макрос с паузами (оставшиеся строки не печатаются). */
export function stopMacro(tabId: string): void {
  const run = runs.get(tabId)
  if (run) run.cancelled = true
}

/** Щелчок по кнопке макроса: запустить, а если он уже печатается здесь — остановить. */
export function clickMacro(macroId: string): void {
  const tab = macroTarget(getState())
  if (tab && runs.has(tab.id) && getState().macroRuns[tab.id] === macroId) {
    stopMacro(tab.id)
    toast('Макрос остановлен', 'info', 1800)
    return
  }
  void runMacro(macroId)
}

/** Горячая клавиша: макрос с этим сочетанием, видимый в активной вкладке. */
export function runHotkey(hotkey: string): boolean {
  const s = getState()
  const tab = macroTarget(s)
  const macro = macrosFor(tab, s).find((m) => m.hotkey === hotkey)
  if (!macro) return false
  void runMacro(macro.id)
  return true
}

/** После входа в сессию — макрос из её настроек («После входа выполнить»). */
export function autorun(tab: TerminalTab): void {
  if (tab.local) return
  const session = findSession(getState().tree, tab.sessionId)
  const macroId = session?.onConnect
  if (!macroId || !getState().macros.some((m) => m.id === macroId)) return
  const connId = tab.connId
  // Небольшая пауза: оболочка успевает вывести приглашение (набранное раньше тоже не потеряется).
  setTimeout(() => {
    const cur = terminalTab(tab.id)
    if (cur?.connId === connId && cur.state === 'connected') void runMacro(macroId, tab.id, true)
  }, 700)
}
