// Оформление редактора на CSS-переменных: тема программы переключает и редактор.

import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier, t.self], color: 'var(--e-kw)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.docString], color: 'var(--e-str)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--e-com)', fontStyle: 'italic' },
  { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom, t.unit], color: 'var(--e-num)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: 'var(--e-fn)' },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: 'var(--e-type)' },
  { tag: [t.propertyName, t.labelName], color: 'var(--e-prop)' },
  { tag: [t.special(t.variableName), t.definition(t.variableName), t.local(t.variableName)], color: 'var(--e-var)' },
  { tag: [t.tagName, t.angleBracket], color: 'var(--e-tag)' },
  { tag: [t.attributeName], color: 'var(--e-attr)' },
  { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4], color: 'var(--e-head)', fontWeight: '600' },
  { tag: [t.link, t.url], color: 'var(--e-link)', textDecoration: 'underline' },
  { tag: [t.meta, t.processingInstruction, t.annotation, t.documentMeta], color: 'var(--e-meta)' },
  { tag: [t.operator, t.derefOperator], color: 'var(--e-op)' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.inserted, color: 'var(--e-str)' },
  { tag: t.deleted, color: 'var(--e-err)' },
  { tag: t.changed, color: 'var(--e-type)' },
  { tag: t.invalid, color: 'var(--e-err)' }
])

const base = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--e-fg)',
    backgroundColor: 'var(--e-bg)',
    fontSize: 'var(--ed-font-size)'
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--ed-font)',
    lineHeight: '1.55'
  },
  '.cm-content': {
    caretColor: 'var(--e-cursor)',
    fontWeight: 'var(--ed-weight)',
    paddingBottom: '40vh'
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--e-cursor)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--e-sel) !important'
  },
  '.cm-gutters': {
    backgroundColor: 'var(--e-gutter-bg)',
    color: 'var(--e-gutter)',
    border: 'none',
    borderRight: '1px solid var(--border)'
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 14px', minWidth: '44px' },
  '.cm-activeLine': { backgroundColor: 'var(--e-active)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--e-active)', color: 'var(--e-fg)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--e-match)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--e-match)', outline: '1px solid var(--e-gutter)' },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'var(--err-soft)' },
  '.cm-searchMatch': { backgroundColor: 'var(--e-match)', outline: '1px solid var(--warn)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--e-sel)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--bg-panel-2)', border: '1px solid var(--border-strong)', color: 'var(--text-dim)' },
  '.cm-foldGutter .cm-gutterElement': { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '16px', color: 'var(--e-gutter)', cursor: 'pointer' },
  // Как в VS Code: значки сворачивания видны при наведении на поле слева; свёрнутые — всегда.
  '.cm-fold-marker': { display: 'grid', placeItems: 'center', opacity: '0', transition: 'opacity 0.15s, transform 0.12s' },
  '.cm-fold-marker.open': { transform: 'rotate(90deg)' },
  '.cm-gutters:hover .cm-fold-marker, .cm-fold-marker:not(.open)': { opacity: '1' },
  '.cm-fold-marker:hover': { color: 'var(--e-fg)' },
  '.cm-tooltip': { backgroundColor: 'var(--bg-panel)', border: '1px solid var(--border-strong)', color: 'var(--text)' },
  '.cm-panels': { backgroundColor: 'var(--bg-panel)', color: 'var(--text)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' }
})

/** Русские надписи панелей поиска, замены и перехода к строке. */
const phrases = EditorState.phrases.of({
  Find: 'Найти',
  Replace: 'Заменить',
  next: 'далее',
  previous: 'назад',
  all: 'все',
  'match case': 'учитывать регистр',
  regexp: 'рег. выражение',
  'by word': 'слово целиком',
  replace: 'заменить',
  'replace all': 'заменить все',
  close: 'закрыть',
  'current match': 'текущее совпадение',
  'on line': 'в строке',
  'replaced match on line $': 'заменено совпадение в строке $',
  'replaced $ matches': 'заменено совпадений: $',
  'Go to line': 'Перейти к строке',
  go: 'перейти',
  'Folded lines': 'Свёрнутые строки',
  'Unfolded lines': 'Развёрнутые строки',
  to: 'до',
  'folded code': 'свёрнутый код',
  unfold: 'развернуть',
  'Fold line': 'Свернуть',
  'Unfold line': 'Развернуть',
  'Control character': 'Управляющий символ'
})

export const editorTheme: Extension = [base, syntaxHighlighting(highlight), phrases]
