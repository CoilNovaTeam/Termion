import type { ITerminalInitOnlyOptions, ITerminalOptions, ITheme } from '@xterm/xterm'
import type { Settings, TerminalFont, ThemeId } from '@shared/types'

export const TERMINAL_THEMES: Record<ThemeId, ITheme> = {
  graphite: {
    background: '#0e1013',
    foreground: '#d6dce2',
    cursor: '#3fb6a8',
    cursorAccent: '#0e1013',
    selectionBackground: 'rgba(63, 182, 168, 0.32)',
    selectionInactiveBackground: 'rgba(63, 182, 168, 0.18)',
    black: '#1c2026',
    red: '#ef6b73',
    green: '#7fcf8e',
    yellow: '#e6c07b',
    blue: '#73a9ff',
    magenta: '#c792ea',
    cyan: '#5fd0c4',
    white: '#d6dce2',
    brightBlack: '#5c6670',
    brightRed: '#ff8a92',
    brightGreen: '#9be0a8',
    brightYellow: '#f0d49b',
    brightBlue: '#9cc2ff',
    brightMagenta: '#dcb0f5',
    brightCyan: '#86e3d8',
    brightWhite: '#ffffff'
  },
  classic: {
    background: '#1e1e1e',
    foreground: '#ececec',
    cursor: '#b4b4c0',
    cursorAccent: '#1e1e1e',
    selectionBackground: 'rgba(114, 170, 255, 0.35)',
    selectionInactiveBackground: 'rgba(114, 170, 255, 0.2)',
    black: '#2b2b2b',
    red: '#ff6b6b',
    green: '#6fd16f',
    yellow: '#f0c674',
    blue: '#72aaff',
    magenta: '#d28ef0',
    cyan: '#56d4dd',
    white: '#ececec',
    brightBlack: '#7a7a7a',
    brightRed: '#ff8f8f',
    brightGreen: '#8ee48e',
    brightYellow: '#f5d79a',
    brightBlue: '#9cc4ff',
    brightMagenta: '#e3b0f6',
    brightCyan: '#85e4ea',
    brightWhite: '#ffffff'
  },
  light: {
    background: '#ffffff',
    foreground: '#262b36',
    cursor: '#5b5ce6',
    cursorAccent: '#ffffff',
    selectionBackground: 'rgba(91, 92, 230, 0.22)',
    selectionInactiveBackground: 'rgba(91, 92, 230, 0.12)',
    black: '#262b36',
    red: '#d0394a',
    green: '#1f8f52',
    yellow: '#a86b00',
    blue: '#3461d1',
    magenta: '#8e44c9',
    cyan: '#0f8585',
    white: '#8b93a1',
    brightBlack: '#6b7280',
    brightRed: '#e0485a',
    brightGreen: '#23a35e',
    brightYellow: '#bf7c00',
    brightBlue: '#4a74e0',
    brightMagenta: '#a05ad8',
    brightCyan: '#139797',
    brightWhite: '#3d4451'
  }
}

export const FONT_LABELS: Record<TerminalFont, string> = {
  cascadia: 'Cascadia Mono',
  jetbrains: 'JetBrains Mono',
  consolas: 'Consolas'
}

export const FONT_STACKS: Record<TerminalFont, string> = {
  cascadia: '"Cascadia Mono", Consolas, monospace',
  jetbrains: '"JetBrains Mono", Consolas, monospace',
  consolas: 'Consolas, "Courier New", monospace'
}

// Встроенные шрифты подключены через @fontsource и разбиты по наборам символов.
// Загружаем латиницу, кириллицу и псевдографику заранее: иначе WebGL-отрисовщик
// успеет закешировать символы запасным шрифтом.
const BUNDLED: Partial<Record<TerminalFont, string>> = {
  cascadia: 'Cascadia Mono',
  jetbrains: 'JetBrains Mono'
}
const SAMPLE = 'AaZz09ЁёЯяĀāŁł─│┌┐└┘█▒'
const loading = new Map<TerminalFont, Promise<void>>()

export function ensureFont(font: TerminalFont): Promise<void> {
  const face = BUNDLED[font]
  if (!face) return Promise.resolve()
  let job = loading.get(font)
  if (!job) {
    job = Promise.all([
      document.fonts.load(`300 14px "${face}"`, SAMPLE),
      document.fonts.load(`600 14px "${face}"`, SAMPLE)
    ]).then(
      () => undefined,
      () => undefined
    )
    loading.set(font, job)
  }
  return job
}

export function terminalOptions(s: Settings): ITerminalOptions & ITerminalInitOnlyOptions {
  const bundled = !!BUNDLED[s.terminal.font]
  return {
    allowProposedApi: true,
    fontFamily: FONT_STACKS[s.terminal.font],
    fontSize: s.terminal.fontSize,
    lineHeight: s.terminal.lineHeight,
    letterSpacing: 0,
    fontWeight: bundled ? 300 : 'normal',
    fontWeightBold: bundled ? 600 : 'bold',
    cursorStyle: s.terminal.cursorStyle,
    cursorInactiveStyle: 'outline',
    cursorBlink: s.terminal.cursorBlink,
    scrollback: s.terminal.scrollback,
    theme: TERMINAL_THEMES[s.theme],
    drawBoldTextInBrightColors: true,
    minimumContrastRatio: 1,
    rightClickSelectsWord: false,
    altClickMovesCursor: true,
    smoothScrollDuration: 0,
    scrollOnUserInput: true,
    wordSeparator: ' ()[]{}\'",;<>|`'
  }
}
