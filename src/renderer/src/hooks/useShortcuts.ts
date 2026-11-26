import { useEffect } from 'react'
import { locate } from '@shared/tree'
import { closeTab, cycleTab, duplicateTab, focusSearch, openDialog, openLocal, reconnect } from '../store/actions'
import { getState, isEditor } from '../store/app'
import { reloadFile, saveEditor, toggleWordWrap } from '../store/editors'
import { runHotkey } from '../store/macros'
import { hotkeyOf } from '@shared/hotkeys'

/** Папка для новой сессии: выбранная папка или папка выбранной сессии. */
export function currentFolderId(): string | null {
  const { tree, selectedId } = getState()
  if (!selectedId) return null
  const found = locate(tree, selectedId)
  if (!found) return null
  return found.node.type === 'folder' ? found.node.id : (found.parent?.id ?? null)
}

/**
 * Глобальные сочетания клавиш. Перехватываются до терминала (фаза capture), поэтому
 * работают и когда фокус в терминале. Используется event.code — сочетания не зависят
 * от раскладки (русская/английская). Ctrl+W, Ctrl+N и подобные намеренно не заняты:
 * они нужны программам на сервере (bash, nano, vim). Ctrl+S сохраняет файл, только когда
 * открыта вкладка редактора — в терминале это сочетание уходит на сервер.
 */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = getState()
      if (s.dialog || s.prompts.length || s.menu) return
      const tab = s.activeTabId
      const editor = isEditor(s.tabs.find((t) => t.id === tab))
      // Горячие клавиши макросов (Ctrl+Alt+1 и т. п.) — раньше терминала и редактора.
      const hotkey = hotkeyOf(e)
      if (hotkey && (e.ctrlKey || e.altKey) && runHotkey(hotkey)) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      // Alt+Z — перенос строк в редакторе (в терминале это сочетание нужно программам на сервере).
      if (editor && e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && e.code === 'KeyZ') {
        e.preventDefault()
        e.stopPropagation()
        toggleWordWrap()
        return
      }
      const ctrl = e.ctrlKey && !e.altKey && !e.metaKey
      if (!ctrl) return
      let handled = true
      if (!e.shiftKey && e.code === 'KeyS' && editor && tab) void saveEditor(tab)
      else if (!e.shiftKey && e.code === 'KeyK') focusSearch()
      else if (!e.shiftKey && e.code === 'Comma') openDialog({ type: 'settings' })
      else if (e.code === 'Tab') cycleTab(e.shiftKey ? -1 : 1)
      else if (!e.shiftKey && e.code === 'PageDown') cycleTab(1)
      else if (!e.shiftKey && e.code === 'PageUp') cycleTab(-1)
      else if (e.shiftKey && e.code === 'KeyN') openDialog({ type: 'session', editId: null, parentId: currentFolderId() })
      else if (e.shiftKey && e.code === 'KeyT') openLocal()
      else if (e.shiftKey && e.code === 'KeyW' && tab) closeTab(tab)
      else if (e.shiftKey && e.code === 'KeyD' && tab) duplicateTab(tab)
      else if (e.shiftKey && e.code === 'KeyR' && tab) {
        if (editor) reloadFile(tab)
        else reconnect(tab)
      }
      else handled = false
      if (handled) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}
