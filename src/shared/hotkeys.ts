// Горячие клавиши макросов. Сочетание определяется по физической клавише (event.code),
// поэтому Ctrl+Alt+1 и Ctrl+Alt+M работают и в русской раскладке.

export interface KeyLike {
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
  code: string
}

/** «Ctrl+Alt+1» по нажатию или null, если клавиша не подходит (стрелки, Enter, одни модификаторы). */
export function hotkeyOf(e: KeyLike): string | null {
  if (e.metaKey) return null
  let key: string | null = null
  if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5)
  else if (/^Numpad[0-9]$/.test(e.code)) key = e.code.slice(6)
  else if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3)
  else if (/^F([1-9]|1[0-2])$/.test(e.code)) key = e.code
  if (!key) return null
  return [e.ctrlKey ? 'Ctrl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : '', key].filter(Boolean).join('+')
}

/** Сочетания, которые уже заняты в Termion или нужны терминалу и редактору. */
const RESERVED = new Set([
  'Ctrl+Shift+N',
  'Ctrl+Shift+W',
  'Ctrl+Shift+D',
  'Ctrl+Shift+R',
  'Ctrl+Shift+T',
  'Ctrl+Shift+C',
  'Ctrl+Shift+V'
])

const HOTKEY_RE = /^(Ctrl\+)?(Alt\+)?(Shift\+)?([A-Z0-9]|F([1-9]|1[0-2]))$/

/** Почему сочетание не подходит для макроса, или null, если подходит. */
export function hotkeyProblem(hotkey: string): string | null {
  if (!HOTKEY_RE.test(hotkey)) return 'Нажмите сочетание, например Ctrl+Alt+1'
  if (RESERVED.has(hotkey)) return 'Это сочетание уже занято в Termion'
  const parts = hotkey.split('+')
  const key = parts.pop() as string
  const mods = parts.length
  const fKey = key.startsWith('F') && key.length > 1
  if (!mods) return fKey ? 'F-клавиши без Ctrl или Alt нужны программам на сервере (mc, htop)' : 'Добавьте Ctrl и Alt'
  // Одиночные Ctrl+буква и Alt+буква нужны bash, nano и vim (Ctrl+C, Alt+B и т. п.).
  if (!fKey && mods < 2) return 'Нужны два модификатора, например Ctrl+Alt+1: одиночные Ctrl и Alt нужны программам на сервере'
  return null
}
