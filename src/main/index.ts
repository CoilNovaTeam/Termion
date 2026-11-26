// Точка входа главного процесса Termion.

import { app, BrowserWindow, dialog, Menu, protocol, safeStorage, session, shell } from 'electron'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import icon from '../../resources/icon.png?asset'
import { IPC } from '@shared/ipc'
import type { AppInfo, Settings } from '@shared/types'
import { registerIpc } from './ipc'
import { initLog, log } from './log'
import { DRAG_SCHEME, DragOutService } from './ssh/dragOut'
import { ConnectionManager } from './ssh/manager'
import { checkOpenSshKnownHosts } from './ssh/opensshKnownHosts'
import type { LoadResult } from './store/jsonFile'
import { KnownHostsStore } from './store/knownHosts'
import { SecretsStore, type Cipher } from './store/secrets'
import { MacrosStore } from './store/macros'
import { SessionsStore } from './store/sessions'
import { SettingsStore } from './store/settings'
import { WindowStateKeeper, applyWindowTheme, createMainWindow } from './window'

const isDev = !app.isPackaged
const OPENSSH_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'

// Отдельная папка данных для тестов и отладки.
if (process.env.TERMION_DATA_DIR) app.setPath('userData', process.env.TERMION_DATA_DIR)
// Служебные файлы Chromium — в подпапку, чтобы рядом с сессиями был порядок.
app.setPath('sessionData', join(app.getPath('userData'), 'Chromium'))

// Ссылки для перетаскивания файлов в Проводник (см. ssh/dragOut.ts). Регистрируется до запуска.
protocol.registerSchemesAsPrivileged([{ scheme: DRAG_SCHEME, privileges: { standard: true, secure: true, stream: true } }])

let mainWindow: BrowserWindow | null = null
let closing = false
let closeAck: (() => void) | null = null
let closeDecision: ((proceed: boolean) => void) | null = null

const cipher: Cipher = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
  decrypt: (encrypted) => safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
}

function findAgent(): string | null {
  if (process.platform === 'win32') return existsSync(OPENSSH_AGENT_PIPE) ? OPENSSH_AGENT_PIPE : null
  return process.env.SSH_AUTH_SOCK || null
}

/** Запрещает окну уходить на сторонние страницы, открывать окна и запрашивать разрешения. */
function harden(): void {
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (event, url) => {
      if (url !== contents.getURL()) event.preventDefault()
    })
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
  })
  const allowed = new Set(['clipboard-sanitized-write'])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))
}

function describeLoad(what: string, result: LoadResult<unknown>, notices: string[]): void {
  if (result.status === 'recovered') {
    notices.push(`Файл ${what} был повреждён и восстановлен из резервной копии. Повреждённая версия сохранена: ${result.corruptCopy}`)
  } else if (result.status === 'reset') {
    notices.push(`Файл ${what} повреждён, а резервной копии нет — начат пустой список. Копия файла: ${result.corruptCopy}`)
  } else if (result.issues.length) {
    notices.push(`В файле ${what} пропущено повреждённых записей: ${result.issues.length}. Исходный файл сохранён: ${result.corruptCopy}`)
  }
}

async function loadStore(what: string, load: () => Promise<LoadResult<unknown>>, notices: string[]): Promise<void> {
  try {
    describeLoad(what, await load(), notices)
  } catch (err) {
    log.error(`Не удалось прочитать файл ${what}`, err)
    notices.push(`Не удалось прочитать файл ${what}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Спрашивает интерфейс, можно ли закрываться. Интерфейс сразу подтверждает получение,
 * дописывает несохранённое и при необходимости спрашивает пользователя (несохранённые
 * файлы, активные подключения). Если интерфейс не отозвался за 2 секунды (завис или
 * упал), окно закрывается без него.
 */
function askRendererToClose(win: BrowserWindow, open: { connections: number; locals: number }): Promise<boolean> {
  if (win.isDestroyed() || win.webContents.isCrashed()) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    let acked = false
    const timer = setTimeout(() => {
      if (!acked) finish(true)
    }, 2000)
    function finish(proceed: boolean) {
      clearTimeout(timer)
      closeAck = null
      closeDecision = null
      resolve(proceed)
    }
    closeAck = () => {
      acked = true
      clearTimeout(timer)
    }
    closeDecision = finish
    win.webContents.send(IPC.evBeforeClose, open)
  })
}

async function bootstrap(): Promise<void> {
  app.setAppUserModelId('com.termion.app')
  await app.whenReady()

  const dataDir = app.getPath('userData')
  const homeDir = homedir()
  initLog(join(dataDir, 'logs'))
  log.info(`Termion ${app.getVersion()} (Electron ${process.versions.electron}) — запуск, данные: ${dataDir}`)
  Menu.setApplicationMenu(null)
  harden()

  const notices: string[] = []
  const sessions = new SessionsStore(dataDir)
  const macros = new MacrosStore(dataDir)
  const settings = new SettingsStore(dataDir)
  const knownHosts = new KnownHostsStore(dataDir)
  const secrets = new SecretsStore(dataDir, cipher, (m) => log.warn(m))
  const windowState = new WindowStateKeeper(dataDir)
  await Promise.all([
    loadStore('сессий', () => sessions.load(), notices),
    loadStore('макросов', () => macros.load(), notices),
    loadStore('настроек', () => settings.load(), notices),
    loadStore('ключей серверов', () => knownHosts.load(), notices),
    loadStore('паролей', () => secrets.load(), notices),
    windowState.load().catch((err) => log.warn('window-state', err))
  ])
  for (const n of notices) log.warn(n)

  const manager = new ConnectionManager({
    findSession: (id) => sessions.find(id),
    secrets,
    knownHosts,
    checkOpenSsh: (host, port, keyType, key) => checkOpenSshKnownHosts(homeDir, host, port, keyType, key),
    homeDir,
    findAgent
  })

  const dragOut = new DragOutService({
    resolve: (owner, connId) => ({ fs: manager.remoteFs(owner, connId), transfers: manager.transfers(owner, connId) })
  })
  protocol.handle(DRAG_SCHEME, (request) => dragOut.handle(request))

  const flushAll = () =>
    Promise.allSettled([sessions.flush(), macros.flush(), settings.flush(), knownHosts.flush(), secrets.flush(), windowState.flush(mainWindow)])

  registerIpc({
    isTrusted: (sender) => !!mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents,
    sessions,
    macros,
    secrets,
    settings,
    manager,
    dataDir,
    homeDir,
    appInfo: (): AppInfo => ({
      version: app.getVersion(),
      dataDir,
      electron: process.versions.electron,
      platform: process.platform,
      startupNotices: notices
    }),
    onSettingsSaved: (s: Settings) => {
      if (mainWindow) applyWindowTheme(mainWindow, s.theme)
    },
    onCloseAck: () => closeAck?.(),
    onCloseReady: (_sender, proceed) => closeDecision?.(proceed),
    dragOut
  })

  const win = createMainWindow({
    theme: settings.get().theme,
    state: windowState,
    preload: join(__dirname, '../preload/index.js'),
    icon,
    devTools: isDev || process.env.TERMION_DEVTOOLS === '1'
  })
  mainWindow = win

  // Windows завершает сеанс (выключение, перезагрузка) — не мешаем, данные и так пишутся сразу.
  let sessionEnding = false
  win.on('query-session-end', () => {
    sessionEnding = true
  })

  win.on('close', (event) => {
    if (sessionEnding) {
      manager.disposeAll()
      return
    }
    // win.destroy() событие close не вызывает, поэтому закрытие всегда идёт через этот обработчик.
    event.preventDefault()
    if (closing) return
    closing = true
    void (async () => {
      const proceed = await askRendererToClose(win, manager.activeCount())
      if (!proceed) {
        closing = false
        return
      }
      manager.disposeAll()
      await flushAll()
      win.destroy()
    })().catch((err) => {
      log.error('Ошибка при закрытии окна', err)
      win.destroy()
    })
  })
  win.on('closed', () => {
    mainWindow = null
  })

  win.webContents.on('render-process-gone', (_e, details) => {
    log.error(`Процесс окна завершился: ${details.reason}`)
    closeDecision?.(true) // если ждали ответа о закрытии — ответа уже не будет
    manager.disposeOwner(win.webContents.id)
    if (details.reason !== 'clean-exit' && !win.isDestroyed()) win.webContents.reload()
  })
  win.on('unresponsive', () => log.warn('Окно не отвечает'))

  if (isDev) {
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools()
    })
  }

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (isDev && devUrl) await win.loadURL(devUrl)
  else await win.loadFile(join(__dirname, '../renderer/index.html'))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  app.on('window-all-closed', () => app.quit())
  bootstrap().catch((err) => {
    log.error('Запуск не удался', err)
    dialog.showErrorBox('Termion', `Не удалось запустить программу:\n${err instanceof Error ? err.message : String(err)}`)
    app.exit(1)
  })
}
