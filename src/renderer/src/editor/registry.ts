// Реестр редакторов. Экземпляры CodeMirror живут вне React (как терминалы): вкладка
// только встраивает готовый редактор в свой контейнер.

import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language'
import { gotoLine as gotoLineCommand, highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, type Extension, type Text } from '@codemirror/state'
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection
} from '@codemirror/view'
import type { Settings } from '@shared/types'
import { FONT_STACKS } from '../terminal/themes'
import { loadLanguage } from './languages'
import { editorTheme } from './theme'

export interface EditorHost {
  settings(): Settings
  onDirty(tabId: string, dirty: boolean): void
  onCursor(tabId: string, line: number, col: number, lines: number): void
}

interface Entry {
  tabId: string
  view: EditorView
  host: HTMLDivElement
  saved: Text
  language: Compartment
  wrap: Compartment
  dirtyTimer: ReturnType<typeof setTimeout> | undefined
  cursorTimer: ReturnType<typeof setTimeout> | undefined
}

const entries = new Map<string, Entry>()
let host: EditorHost

export function configure(h: EditorHost): void {
  host = h
}

function applyFont(el: HTMLElement, settings: Settings): void {
  const bundled = settings.terminal.font !== 'consolas'
  el.style.setProperty('--ed-font', FONT_STACKS[settings.terminal.font])
  el.style.setProperty('--ed-font-size', `${settings.terminal.fontSize}px`)
  el.style.setProperty('--ed-weight', bundled ? '300' : '400')
}

/** Значок сворачивания блока — тот же шеврон, что в деревьях программы. */
function foldMarker(open: boolean): HTMLElement {
  const el = document.createElement('span')
  el.className = open ? 'cm-fold-marker open' : 'cm-fold-marker'
  el.title = open ? 'Свернуть' : 'Развернуть'
  el.innerHTML =
    '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>'
  return el
}

function extensions(entry: Entry, readOnly: boolean): Extension[] {
  const settings = host.settings()
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    foldGutter({ markerDOM: foldMarker }),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    keymap.of([
      // Свои сочетания — первыми: Ctrl+G и Ctrl+H как в VS Code и Notepad++.
      { key: 'Mod-g', run: gotoLineCommand, preventDefault: true },
      { key: 'Mod-h', run: openSearchPanel, preventDefault: true },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      indentWithTab
    ]),
    editorTheme,
    entry.language.of([]),
    entry.wrap.of(settings.editor.wordWrap ? EditorView.lineWrapping : []),
    EditorState.readOnly.of(readOnly),
    EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onDocChanged(entry)
      if (update.docChanged || update.selectionSet) scheduleCursor(entry)
    })
  ]
}

function create(tabId: string): Entry {
  const el = document.createElement('div')
  el.className = 'editor-host'
  applyFont(el, host.settings())
  const entry = {
    tabId,
    host: el,
    language: new Compartment(),
    wrap: new Compartment(),
    dirtyTimer: undefined,
    cursorTimer: undefined
  } as Entry
  const state = EditorState.create({ doc: '', extensions: extensions(entry, true) })
  entry.view = new EditorView({ state, parent: el })
  entry.saved = state.doc
  entries.set(tabId, entry)
  return entry
}

function onDocChanged(entry: Entry): void {
  host.onDirty(entry.tabId, true)
  // Если правки отменили до сохранённого состояния — файл снова «чистый».
  clearTimeout(entry.dirtyTimer)
  entry.dirtyTimer = setTimeout(() => {
    const doc = entry.view.state.doc
    if (doc.length < 3_000_000) host.onDirty(entry.tabId, !doc.eq(entry.saved))
  }, 200)
}

function scheduleCursor(entry: Entry): void {
  if (entry.cursorTimer) return
  entry.cursorTimer = setTimeout(() => {
    entry.cursorTimer = undefined
    const state = entry.view.state
    const head = state.selection.main.head
    const line = state.doc.lineAt(head)
    host.onCursor(entry.tabId, line.number, head - line.from + 1, state.doc.lines)
  }, 80)
}

export function attach(tabId: string, container: HTMLElement): void {
  const entry = entries.get(tabId) ?? create(tabId)
  if (entry.host.parentElement !== container) container.appendChild(entry.host)
  entry.view.requestMeasure()
}

/** Загрузить текст файла: история правок начинается заново, файл «чистый». */
export function setDocument(tabId: string, text: string, languageId: string): void {
  const entry = entries.get(tabId) ?? create(tabId)
  clearTimeout(entry.dirtyTimer)
  entry.view.setState(EditorState.create({ doc: text, extensions: extensions(entry, false) }))
  entry.saved = entry.view.state.doc
  scheduleCursor(entry)
  void loadLanguage(languageId).then(
    (ext) => {
      if (entries.get(tabId) === entry) entry.view.dispatch({ effects: entry.language.reconfigure(ext) })
    },
    () => undefined
  )
}

/** Текущий текст (неизменяемый снимок CodeMirror). */
export function getDoc(tabId: string): Text | null {
  return entries.get(tabId)?.view.state.doc ?? null
}

/**
 * Отметить снимок doc как сохранённый. Пока шло сохранение, текст могли поменять —
 * тогда файл остаётся «несохранённым».
 */
export function markSaved(tabId: string, doc: Text): void {
  const entry = entries.get(tabId)
  if (!entry) return
  clearTimeout(entry.dirtyTimer)
  entry.saved = doc
  host.onDirty(tabId, !entry.view.state.doc.eq(doc))
}

/** Открыть строку «Перейти к строке». */
export function gotoLine(tabId: string): void {
  const entry = entries.get(tabId)
  if (!entry) return
  entry.view.focus()
  gotoLineCommand(entry.view)
}

export function focus(tabId: string | null): void {
  const entry = tabId ? entries.get(tabId) : undefined
  if (entry) requestAnimationFrame(() => entry.view.focus())
}

export function applySettings(settings: Settings): void {
  for (const entry of entries.values()) {
    applyFont(entry.host, settings)
    entry.view.dispatch({ effects: entry.wrap.reconfigure(settings.editor.wordWrap ? EditorView.lineWrapping : []) })
    entry.view.requestMeasure()
  }
}

export function dispose(tabId: string): void {
  const entry = entries.get(tabId)
  if (!entry) return
  clearTimeout(entry.dirtyTimer)
  clearTimeout(entry.cursorTimer)
  entry.view.destroy()
  entry.host.remove()
  entries.delete(tabId)
}
