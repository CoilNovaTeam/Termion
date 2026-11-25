// Сведения о сервере активной вкладки: опрос для строки состояния и для подробной сводки.
// Опрашивается только сервер вкладки, которая сейчас на экране, и только пока окно видно —
// фоновые вкладки и свёрнутое окно сервер не нагружают.

import type { StatsMode } from '@shared/types'
import { api, errorText } from '../api'
import { filesTabId, getState, isTerminal, setState, type TerminalTab } from './app'

/** Как часто обновлять: строка состояния — раз в 5 с, открытая сводка — раз в 2,5 с. */
export const LIGHT_MS = 5000
export const FULL_MS = 2500
/** Если сведения получить не удалось (например, сервер только для SFTP) — повтор через минуту. */
const RETRY_MS = 60_000
const HISTORY = 48

const due = new Map<string, number>()
const busy = new Set<string>()
let started = false

function omit<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map
  const out = { ...map }
  delete out[key]
  return out
}

/** Вкладка-терминал, чей сервер сейчас на экране (активная или владелец активного редактора). */
export function activeServerTab(): TerminalTab | null {
  const s = getState()
  const id = filesTabId(s)
  const tab = s.tabs.find((t) => t.id === id)
  return isTerminal(tab) && tab.state === 'connected' && tab.connId ? tab : null
}

async function poll(connId: string, mode: StatsMode): Promise<void> {
  busy.add(connId)
  try {
    const stats = await api.ssh.stats(connId, mode)
    setState((s) => ({
      stats: { ...s.stats, [connId]: stats },
      statsErrors: omit(s.statsErrors, connId),
      cpuHistory: stats.cpu === null ? s.cpuHistory : { ...s.cpuHistory, [connId]: [...(s.cpuHistory[connId] ?? []), stats.cpu].slice(-HISTORY) }
    }))
    due.set(connId, Date.now() + (getState().serverPanel ? FULL_MS : LIGHT_MS))
  } catch (err) {
    setState((s) => ({ statsErrors: { ...s.statsErrors, [connId]: errorText(err) } }))
    due.set(connId, Date.now() + RETRY_MS)
  } finally {
    busy.delete(connId)
  }
}

function tick(): void {
  if (document.visibilityState === 'hidden') return
  const s = getState()
  const tab = activeServerTab()
  if (!tab?.connId) return
  if (!s.serverPanel && !s.settings.monitor.statusBar) return
  const connId = tab.connId
  if (busy.has(connId) || (due.get(connId) ?? 0) > Date.now()) return
  void poll(connId, s.serverPanel ? 'full' : 'light')
}

export function startMonitor(): void {
  if (started) return
  started = true
  setInterval(tick, 500)
  document.addEventListener('visibilitychange', tick)
}

export function openServerPanel(): void {
  const tab = activeServerTab()
  if (tab?.connId && !getState().stats[tab.connId]?.top) due.delete(tab.connId) // подробности — сразу
  setState({ serverPanel: true, menu: null })
  tick()
}

export function closeServerPanel(): void {
  if (getState().serverPanel) setState({ serverPanel: false })
}

export function toggleServerPanel(): void {
  if (getState().serverPanel) closeServerPanel()
  else openServerPanel()
}

/** Обновить сейчас (кнопка в сводке; после ошибки — не ждать минуту). */
export function refreshServer(): void {
  const tab = activeServerTab()
  if (!tab?.connId) return
  due.delete(tab.connId)
  tick()
}

/** Подключение закрыто — старые цифры больше не нужны. */
export function forgetServer(connId: string): void {
  due.delete(connId)
  setState((s) => ({
    stats: omit(s.stats, connId),
    statsErrors: omit(s.statsErrors, connId),
    cpuHistory: omit(s.cpuHistory, connId)
  }))
}
