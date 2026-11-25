import type { TermionApi } from '@shared/api'

export const api: TermionApi = window.termion

/** Текст ошибки без служебного префикса Electron «Error invoking remote method …». */
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
}
