// Встроенный редактор: открытие файлов с сервера, сохранение, конфликты и перечитывание.

import { baseName } from '@shared/remotePath'
import { newId } from '@shared/tree'
import type { EolId, TextEncodingId } from '@shared/types'
import { api, errorText } from '../api'
import { detectLanguage } from '../editor/languages'
import * as editors from '../editor/registry'
import { formatSize } from '../format'
import { activateTab, addTab, closeDialog, closeTabsNow, confirmAction, openDialog, patchTab, tabById, terminalTab, toast, updateSettings } from './actions'
import { getState, isEditor, type EditorTab } from './app'

export const editorTab = (id: string): EditorTab | undefined => {
  const tab = tabById(id)
  return isEditor(tab) ? tab : undefined
}

export function findEditor(ownerId: string, path: string): EditorTab | undefined {
  return getState().tabs.find((t): t is EditorTab => isEditor(t) && t.ownerId === ownerId && t.path === path)
}

/** Открыть файл во вкладке редактора (или перейти к уже открытой). */
export function openFile(ownerId: string, path: string): void {
  const existing = findEditor(ownerId, path)
  if (existing) {
    activateTab(existing.id)
    return
  }
  const tab: EditorTab = {
    kind: 'editor',
    id: newId(),
    ownerId,
    path,
    title: baseName(path),
    status: 'loading',
    error: null,
    problem: null,
    dirty: false,
    docDirty: false,
    saving: false,
    meta: null,
    encoding: 'utf8',
    eol: 'lf',
    savedEncoding: 'utf8',
    savedEol: 'lf',
    language: detectLanguage(path),
    line: 1,
    col: 1,
    lines: 1
  }
  addTab(tab)
  void loadFile(tab.id)
}

function ownerConn(tab: EditorTab): string | null {
  const owner = terminalTab(tab.ownerId)
  return owner?.state === 'connected' && owner.connId ? owner.connId : null
}

function noConnection(tab: EditorTab): string {
  const owner = terminalTab(tab.ownerId)
  return owner
    ? `Нет подключения к серверу. Переподключите вкладку «${owner.title}» (Ctrl+Shift+R) и повторите.`
    : 'Вкладка терминала, через которую открыт файл, закрыта.'
}

/** Загрузить (или перечитать) файл с сервера. Несохранённые правки теряются — спрашивать заранее. */
export async function loadFile(tabId: string): Promise<void> {
  const tab = editorTab(tabId)
  // Уже перечитывается — второй запрос не нужен.
  if (!tab || (tab.status === 'loading' && tab.meta)) return
  // Перечитывание уже открытого файла: при ошибке текст остаётся на экране.
  const reloading = tab.meta !== null && tab.status === 'ready'
  const connId = ownerConn(tab)
  if (!connId) {
    if (reloading) toast(noConnection(tab), 'error', 7000)
    else patchTab<EditorTab>(tabId, { status: 'error', problem: null, error: noConnection(tab) })
    return
  }
  patchTab<EditorTab>(tabId, { status: 'loading', error: null, problem: null })
  try {
    const res = await api.sftp.readText(connId, tab.path)
    const cur = editorTab(tabId)
    if (!cur) return
    if (!res.ok) {
      const error =
        res.reason === 'too-large'
          ? `Файл слишком большой для встроенного редактора (${formatSize(res.size)}). Скачайте его и откройте на компьютере.`
          : 'Это двоичный файл (программа, архив, картинка…) — как текст его не открыть. Его можно скачать на компьютер.'
      if (reloading) {
        patchTab<EditorTab>(tabId, { status: 'ready' })
        toast(error, 'error', 8000)
      } else {
        patchTab<EditorTab>(tabId, { status: 'error', problem: res.reason, error })
      }
      return
    }
    const firstLine = res.text.slice(0, 300).split('\n', 1)[0]
    const language = detectLanguage(cur.path, firstLine)
    editors.setDocument(tabId, res.text, language.id)
    patchTab<EditorTab>(tabId, {
      status: 'ready',
      error: null,
      problem: null,
      meta: res.meta,
      encoding: res.encoding,
      eol: res.eol,
      savedEncoding: res.encoding,
      savedEol: res.eol,
      dirty: false,
      docDirty: false,
      language
    })
    if (getState().activeTabId === tabId && !getState().dialog) editors.focus(tabId)
  } catch (err) {
    if (!editorTab(tabId)) return
    if (reloading) {
      patchTab<EditorTab>(tabId, { status: 'ready' })
      toast(`Не удалось перечитать «${tab.title}»: ${errorText(err)}`, 'error', 8000)
    } else {
      patchTab<EditorTab>(tabId, { status: 'error', problem: null, error: errorText(err) })
    }
  }
}

export function reloadFile(tabId: string): void {
  const tab = editorTab(tabId)
  if (!tab || tab.status === 'loading') return
  if (!tab.dirty) {
    void loadFile(tabId)
    return
  }
  confirmAction({
    title: 'Перечитать файл?',
    message: `Несохранённые изменения в «${tab.title}» пропадут — будет загружена версия с сервера.`,
    confirmLabel: 'Перечитать',
    danger: true,
    onConfirm: () => loadFile(tabId)
  })
}

const inFlight = new Map<string, Promise<boolean>>()

/**
 * Сохранить файл на сервер. force — записать, даже если файл на сервере изменился или удалён.
 * Возвращает true, если файл сохранён. Если файл уже сохраняется — ждёт это сохранение.
 */
export function saveEditor(tabId: string, force = false): Promise<boolean> {
  const pending = inFlight.get(tabId)
  if (pending) return pending
  const job = doSave(tabId, force).finally(() => inFlight.delete(tabId))
  inFlight.set(tabId, job)
  return job
}

async function doSave(tabId: string, force: boolean): Promise<boolean> {
  const tab = editorTab(tabId)
  if (!tab) return true
  if (tab.status !== 'ready') return false
  const connId = ownerConn(tab)
  if (!connId) {
    toast(noConnection(tab), 'error', 7000)
    return false
  }
  const doc = editors.getDoc(tabId)
  if (!doc) return false
  const { encoding, eol } = tab
  patchTab<EditorTab>(tabId, { saving: true })
  try {
    const res = await api.sftp.writeText({ connId, path: tab.path, text: doc.toString(), encoding, eol, expected: tab.meta, force })
    if (!editorTab(tabId)) return res.ok
    if (!res.ok) {
      patchTab<EditorTab>(tabId, { saving: false })
      openDialog({ type: 'conflict', tabId, conflict: res.conflict })
      return false
    }
    patchTab<EditorTab>(tabId, { saving: false, meta: res.meta, savedEncoding: encoding, savedEol: eol })
    editors.markSaved(tabId, doc)
    toast(`Сохранено: ${tab.title}`, 'success', 1600)
    return true
  } catch (err) {
    if (editorTab(tabId)) patchTab<EditorTab>(tabId, { saving: false })
    toast(`Не удалось сохранить «${tab.title}»: ${errorText(err)}`, 'error', 8000)
    return false
  }
}

/** Ответ в окне «Файл изменён на сервере». */
export function resolveConflict(tabId: string, choice: 'overwrite' | 'reload' | 'cancel'): void {
  closeDialog()
  if (choice === 'overwrite') void saveEditor(tabId, true)
  else if (choice === 'reload') void loadFile(tabId)
}

/** Ответ в окне «Сохранить изменения?» перед закрытием вкладок. */
export async function resolveUnsaved(choice: 'save' | 'discard' | 'cancel'): Promise<void> {
  const dialog = getState().dialog
  if (dialog?.type !== 'unsaved') return
  if (choice === 'cancel') {
    closeDialog()
    return
  }
  if (choice === 'save') {
    for (const id of dialog.dirtyIds) {
      if (await saveEditor(id)) continue
      // Не сохранилось: окно конфликта уже открыто или ошибка показана — вкладки не закрываем.
      if (getState().dialog === dialog) closeDialog()
      activateTab(id)
      return
    }
  }
  if (getState().dialog === dialog) closeDialog()
  closeTabsNow(dialog.closeIds)
}

// ---------- сигналы от CodeMirror ----------

const isDirty = (t: Pick<EditorTab, 'docDirty' | 'encoding' | 'savedEncoding' | 'eol' | 'savedEol'>) =>
  t.docDirty || t.encoding !== t.savedEncoding || t.eol !== t.savedEol

export function onEditorDirty(tabId: string, docDirty: boolean): void {
  const tab = editorTab(tabId)
  if (!tab) return
  const dirty = isDirty({ ...tab, docDirty })
  if (tab.docDirty !== docDirty || tab.dirty !== dirty) patchTab<EditorTab>(tabId, { docDirty, dirty })
}

export function onEditorCursor(tabId: string, line: number, col: number, lines: number): void {
  const tab = editorTab(tabId)
  if (tab && (tab.line !== line || tab.col !== col || tab.lines !== lines)) patchTab<EditorTab>(tabId, { line, col, lines })
}

/** Кодировка и окончания строк, с которыми файл будет сохранён. */
export function setFormat(tabId: string, patch: { encoding?: TextEncodingId; eol?: EolId }): void {
  const tab = editorTab(tabId)
  if (!tab || tab.status !== 'ready') return
  const next = { ...tab, ...patch }
  patchTab<EditorTab>(tabId, { ...patch, dirty: isDirty(next) })
}

export function toggleWordWrap(): void {
  updateSettings((s) => ({ ...s, editor: { ...s.editor, wordWrap: !s.editor.wordWrap } }))
}
