// Главное окно: создание, запоминание размеров и положения, цвета системных кнопок.

import { BrowserWindow, screen, type Rectangle } from 'electron'
import { join } from 'node:path'
import type { ThemeId } from '@shared/types'
import { JsonFile } from './store/jsonFile'

export const TITLEBAR_HEIGHT = 36

/** Цвета заголовка окна и фона до загрузки интерфейса (совпадают с темами в CSS). */
const CHROME: Record<ThemeId, { titlebar: string; symbol: string; background: string }> = {
  graphite: { titlebar: '#0f1114', symbol: '#a2abb5', background: '#131518' },
  classic: { titlebar: '#c9d0d8', symbol: '#1b222a', background: '#d5dbe2' },
  light: { titlebar: '#eceef2', symbol: '#1d2330', background: '#f3f4f7' }
}

interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

const DEFAULT_STATE: WindowState = { width: 1280, height: 800, maximized: false }

function parseState(raw: unknown): { value: WindowState; issues: string[] } {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined)
  const value: WindowState = {
    x: num(r.x),
    y: num(r.y),
    width: Math.max(760, num(r.width) ?? DEFAULT_STATE.width),
    height: Math.max(480, num(r.height) ?? DEFAULT_STATE.height),
    maximized: r.maximized === true
  }
  return { value, issues: [] }
}

/** Окно должно быть заметно видно хотя бы на одном мониторе (мониторы могли отключить). */
function isVisibleOnSomeDisplay(b: Rectangle): boolean {
  return screen.getAllDisplays().some(({ workArea: a }) => {
    const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
    const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
    return w >= 160 && h >= 120
  })
}

export class WindowStateKeeper {
  private readonly file: JsonFile<WindowState>
  private state: WindowState = { ...DEFAULT_STATE }
  private timer: NodeJS.Timeout | null = null

  constructor(dir: string) {
    this.file = new JsonFile<WindowState>(join(dir, 'window-state.json'), parseState, () => ({ ...DEFAULT_STATE }))
  }

  async load(): Promise<void> {
    this.state = (await this.file.load()).data
  }

  bounds(): Partial<Rectangle> & { width: number; height: number } {
    const { x, y, width, height } = this.state
    if (x !== undefined && y !== undefined && isVisibleOnSomeDisplay({ x, y, width, height })) return { x, y, width, height }
    const area = screen.getPrimaryDisplay().workArea
    return { width: Math.min(width, area.width), height: Math.min(height, area.height) }
  }

  get maximized(): boolean {
    return this.state.maximized
  }

  track(win: BrowserWindow): void {
    const schedule = () => {
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => this.capture(win), 500)
    }
    win.on('resize', schedule)
    win.on('move', schedule)
    win.on('maximize', schedule)
    win.on('unmaximize', schedule)
  }

  capture(win: BrowserWindow): void {
    if (win.isDestroyed() || win.isMinimized()) return
    const b = win.isMaximized() ? win.getNormalBounds() : win.getBounds()
    this.state = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() }
    void this.file.save(this.state).catch(() => undefined)
  }

  async flush(win: BrowserWindow | null): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    if (win && !win.isDestroyed()) this.capture(win)
    await this.file.flush()
  }
}

export function applyWindowTheme(win: BrowserWindow, theme: ThemeId): void {
  if (win.isDestroyed()) return
  const c = CHROME[theme]
  win.setBackgroundColor(c.background)
  try {
    win.setTitleBarOverlay({ color: c.titlebar, symbolColor: c.symbol, height: TITLEBAR_HEIGHT })
  } catch {
    // на платформах без overlay — не страшно
  }
}

export interface CreateWindowOptions {
  theme: ThemeId
  state: WindowStateKeeper
  preload: string
  icon: string
  devTools: boolean
}

export function createMainWindow(opts: CreateWindowOptions): BrowserWindow {
  const c = CHROME[opts.theme]
  const win = new BrowserWindow({
    ...opts.state.bounds(),
    minWidth: 760,
    minHeight: 480,
    show: false,
    title: 'Termion',
    icon: opts.icon,
    backgroundColor: c.background,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: c.titlebar, symbolColor: c.symbol, height: TITLEBAR_HEIGHT },
    webPreferences: {
      preload: opts.preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: opts.devTools
    }
  })
  win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => undefined)
  opts.state.track(win)
  win.once('ready-to-show', () => {
    if (opts.state.maximized) win.maximize()
    win.show()
  })
  return win
}
