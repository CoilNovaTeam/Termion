// Макросы: где виден макрос и что именно он «напечатает» в терминал.

import type { Macro, TreeNode } from './types'
import { isInside, locate } from './tree'

/** Вкладка, в которой запускают макрос: SSH-сессия или терминал компьютера. */
export interface MacroTarget {
  local: boolean
  sessionId: string
}

/** Папка или сессия, к которой привязан макрос, удалена — тогда макрос виден везде (с пометкой). */
export function scopeMissing(macro: Macro, tree: readonly TreeNode[]): boolean {
  if (macro.scope.type !== 'folder' && macro.scope.type !== 'session') return false
  const found = locate(tree, macro.scope.id)
  return !found || found.node.type !== macro.scope.type
}

/** Виден ли макрос во вкладке (и работает ли там его горячая клавиша). */
export function macroApplies(macro: Macro, target: MacroTarget, tree: readonly TreeNode[]): boolean {
  const { scope } = macro
  if (scope.type === 'all' || scopeMissing(macro, tree)) return true
  if (scope.type === 'local') return target.local
  if (target.local || !target.sessionId) return false
  if (scope.type === 'session') return scope.id === target.sessionId
  return isInside(tree, scope.id, target.sessionId)
}

/**
 * Что отправить в терминал: строки с Enter (\r) между ними. После последней строки Enter
 * нажимается, только если включено «Нажать Enter после последней строки». Пустые строки
 * в конце отбрасываются.
 */
export function macroChunks(commands: string, enter: boolean): string[] {
  const lines = commands.replace(/\r\n?/g, '\n').split('\n')
  while (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop()
  return lines.map((line, i) => (i < lines.length - 1 || enter ? `${line}\r` : line))
}
