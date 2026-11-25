// Обработчики IPC. Каждый вызов проверяет отправителя (только главный фрейм нашего окна)
// и данные. Ошибки возвращаются в окно с понятным текстом и пишутся в журнал.

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import { existsSync, promises as fsp } from 'node:fs'
import { dirname, isAbsolute, join, posix } from 'node:path'
import { IPC } from '@shared/ipc'
import type { AppInfo, EolId, RemoteFileMeta, Settings, TextEncodingId } from '@shared/types'
import { sessionIds } from '@shared/tree'
import { LIMITS, checkFileName, checkTree, isValidId, normalizeRemotePath } from '@shared/validate'
import { log } from './log'
import type { ConnectionManager } from './ssh/manager'
import { safeLocalName } from './ssh/transfers'
import type { SecretsStore } from './store/secrets'
import type { SessionsStore } from './store/sessions'
import type { SettingsStore } from './store/settings'
import type { DragOutService } from './ssh/dragOut'

export interface IpcContext {
  isTrusted(sender: Electron.WebContents): boolean
  sessions: SessionsStore
  secrets: SecretsStore
  settings: SettingsStore
  manager: ConnectionManager
  appInfo(): AppInfo
  dataDir: string
  homeDir: string
  onSettingsSaved(settings: Settings): void
  onCloseAck(sender: Electron.WebContents): void
  onCloseReady(sender: Electron.WebContents, proceed: boolean): void
  dragOut: DragOutService
}

const MAX_CLIPBOARD = 16 * 1024 * 1024
const MAX_TEXT_SAVE = 20 * 1024 * 1024
const ENCODINGS: readonly TextEncodingId[] = ['utf8', 'utf8-bom', 'cp1251']
const EOLS: readonly EolId[] = ['lf', 'crlf']

const asRecord = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {})

function remotePath(v: unknown): string {
  const p = normalizeRemotePath(v)
  if (!p) throw new Error('Некорректный путь на сервере.')
  return p
}

/** Путь для нового файла/папки или нового имени: проверяется последняя часть. */
function newRemotePath(v: unknown): string {
  const p = remotePath(v)
  const problem = checkFileName(posix.basename(p))
  if (problem) throw new Error(problem)
  return p
}

function fileMeta(v: unknown): RemoteFileMeta | null {
  if (v === null || v === undefined) return null
  const r = asRecord(v)
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : NaN)
  const meta = { mtime: num(r.mtime), size: num(r.size), mode: num(r.mode) }
  if (Object.values(meta).some(Number.isNaN)) throw new Error('Некорректные сведения о файле.')
  return meta
}

/** Спросить, что делать с уже существующими файлами. null — отмена. */
async function askOverwrite(win: BrowserWindow | null, names: string[], where: string): Promise<boolean | null> {
  if (!names.length) return true
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    title: 'Termion',
    message: names.length === 1 ? `«${names[0]}» уже есть ${where}.` : `${names.length} из выбранных объектов уже есть ${where}.`,
    detail:
      (names.length > 1 ? names.slice(0, 8).join('\n') + (names.length > 8 ? '\n…' : '') + '\n\n' : '') +
      'Заменить их или пропустить?',
    buttons: ['Заменить', 'Пропустить', 'Отмена'],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  }
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
  return response === 2 ? null : response === 0
}

export function registerIpc(ctx: IpcContext): void {
  const trusted = (e: IpcMainEvent | IpcMainInvokeEvent): boolean =>
    ctx.isTrusted(e.sender) && !!e.senderFrame && e.senderFrame === e.sender.mainFrame

  const handle = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, async (e, ...args) => {
      if (!trusted(e)) throw new Error('Запрос отклонён.')
      try {
        return await fn(e, ...args)
      } catch (err) {
        log.warn(`IPC ${channel}`, err)
        throw new Error(err instanceof Error ? err.message : String(err))
      }
    })
  }

  const on = (channel: string, fn: (e: IpcMainEvent, ...args: unknown[]) => void) => {
    ipcMain.on(channel, (e, ...args) => {
      if (!trusted(e)) return
      try {
        fn(e, ...args)
      } catch (err) {
        log.warn(`IPC ${channel}`, err)
      }
    })
  }

  // ---------- приложение ----------
  handle(IPC.appInfo, () => ctx.appInfo())
  handle(IPC.openDataDir, async () => {
    const error = await shell.openPath(ctx.dataDir)
    if (error) throw new Error(error)
  })
  handle(IPC.openExternal, async (_e, url) => {
    if (typeof url !== 'string' || url.length > 4096) return
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') await shell.openExternal(parsed.toString())
  })
  handle(IPC.showInFolder, (_e, path) => {
    if (typeof path === 'string' && isAbsolute(path) && existsSync(path)) shell.showItemInFolder(path)
  })
  on(IPC.appCloseAck, (e) => ctx.onCloseAck(e.sender))
  on(IPC.appCloseReady, (e, proceed) => ctx.onCloseReady(e.sender, proceed !== false))

  // ---------- сессии ----------
  handle(IPC.sessionsLoad, () => ctx.sessions.tree)
  handle(IPC.sessionsSave, async (_e, raw) => {
    const { tree } = checkTree(raw, true)
    await ctx.sessions.save(tree)
    await ctx.secrets.pruneSessions(new Set(sessionIds(tree)))
  })

  // ---------- пароли ----------
  handle(IPC.secretsStatus, (_e, id) => {
    if (!isValidId(id)) throw new Error('Некорректный идентификатор сессии.')
    return ctx.secrets.status(id)
  })
  handle(IPC.secretsSetPassword, async (_e, id, password) => {
    if (!isValidId(id) || !ctx.sessions.find(id)) throw new Error('Сессия не найдена.')
    if (password !== null && (typeof password !== 'string' || password.length > LIMITS.passwordLength)) {
      throw new Error('Некорректный пароль.')
    }
    await ctx.secrets.setPassword(id, password)
  })

  // ---------- настройки ----------
  handle(IPC.settingsLoad, () => ctx.settings.get())
  handle(IPC.settingsSave, async (_e, raw) => {
    const saved = await ctx.settings.save(raw)
    ctx.onSettingsSaved(saved)
  })

  // ---------- системные окна и буфер обмена ----------
  handle(IPC.dialogPickKey, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Выберите приватный SSH-ключ',
      defaultPath: join(ctx.homeDir, '.ssh'),
      buttonLabel: 'Выбрать',
      properties: ['openFile', 'showHiddenFiles', 'dontAddToRecent'],
      filters: [
        { name: 'Все файлы', extensions: ['*'] },
        { name: 'Ключи PuTTY', extensions: ['ppk'] }
      ]
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
  })
  handle(IPC.clipboardRead, () => clipboard.readText())
  on(IPC.clipboardWrite, (_e, text) => {
    if (typeof text === 'string' && text.length <= MAX_CLIPBOARD) clipboard.writeText(text)
  })

  // ---------- SSH ----------
  handle(IPC.sshConnect, (e, req) => {
    const r = asRecord(req)
    ctx.manager.connect(e.sender, r.connId, r.sessionId, r.cols, r.rows)
  })
  on(IPC.sshWrite, (e, connId, data, binary) => ctx.manager.write(e.sender.id, connId, data, binary))
  on(IPC.sshResize, (e, connId, cols, rows) => ctx.manager.resize(e.sender.id, connId, cols, rows))
  on(IPC.sshAck, (e, connId, bytes) => ctx.manager.ack(e.sender.id, connId, bytes))
  on(IPC.sshDisconnect, (e, connId) => ctx.manager.disconnect(e.sender.id, connId))
  handle(IPC.sshReset, (e) => ctx.manager.disposeOwner(e.sender.id))
  handle(IPC.sshStats, (e, connId, mode) => {
    if (mode !== 'light' && mode !== 'full') throw new Error('Неизвестный режим.')
    return ctx.manager.stats(e.sender.id, connId, mode)
  })
  on(IPC.sshPromptResponse, (e, promptId, response) => ctx.manager.respond(e.sender.id, promptId, response))

  // ---------- файлы на сервере ----------
  handle(IPC.sftpCall, async (e, op, rawArgs) => {
    const a = asRecord(rawArgs)
    const owner = e.sender.id
    const fs = () => ctx.manager.remoteFs(owner, a.connId)
    switch (op) {
      case 'home':
        return fs().home()
      case 'list':
        return fs().list(remotePath(a.path))
      case 'stat':
        return fs().stat(remotePath(a.path))
      case 'readText':
        return fs().readText(remotePath(a.path))
      case 'writeText': {
        if (typeof a.text !== 'string' || a.text.length > MAX_TEXT_SAVE) throw new Error('Файл слишком большой для сохранения.')
        if (!ENCODINGS.includes(a.encoding as TextEncodingId)) throw new Error('Неизвестная кодировка.')
        if (!EOLS.includes(a.eol as EolId)) throw new Error('Неизвестный формат окончаний строк.')
        return fs().writeText(remotePath(a.path), a.text, a.encoding as TextEncodingId, a.eol as EolId, fileMeta(a.expected), a.force === true)
      }
      case 'mkdir':
        return fs().mkdir(newRemotePath(a.path))
      case 'createFile':
        return fs().createFile(newRemotePath(a.path))
      case 'rename':
        return fs().rename(remotePath(a.from), newRemotePath(a.to))
      case 'remove':
        return fs().remove(remotePath(a.path))
      case 'download':
        return startDownload(e, a)
      case 'upload':
        return startUpload(e, a)
      default:
        throw new Error('Неизвестная операция с файлами.')
    }
  })
  on(IPC.sftpCancelTransfer, (e, jobId) => ctx.manager.cancelTransfer(e.sender.id, jobId))
  on(IPC.dragOutRegister, (e, token, connId, rawPaths, title) => {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw new Error('Некорректная ссылка.')
    if (typeof connId !== 'string') throw new Error('Нет подключения.')
    if (!Array.isArray(rawPaths) || !rawPaths.length || rawPaths.length > 1000) throw new Error('Нет файлов.')
    if (typeof title !== 'string' || !title || title.length > 300) throw new Error('Некорректное имя.')
    ctx.dragOut.register(e.sender.id, token, connId, rawPaths.map(remotePath), title)
  })

  async function startDownload(e: IpcMainInvokeEvent, a: Record<string, unknown>): Promise<string | null> {
    if (!Array.isArray(a.paths) || !a.paths.length || a.paths.length > 1000) throw new Error('Не выбраны файлы для скачивания.')
    const paths = a.paths.map(remotePath)
    const fs = ctx.manager.remoteFs(e.sender.id, a.connId)
    const transfers = ctx.manager.transfers(e.sender.id, a.connId)
    const win = BrowserWindow.fromWebContents(e.sender)
    const downloads = app.getPath('downloads')

    if (paths.length === 1) {
      const entry = await fs.stat(paths[0])
      if (entry.type === 'file') {
        const options: Electron.SaveDialogOptions = {
          title: 'Сохранить файл на компьютер',
          defaultPath: join(downloads, safeLocalName(entry.name)),
          buttonLabel: 'Сохранить'
        }
        const res = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
        if (res.canceled || !res.filePath) return null
        // окно «Сохранить как» само спрашивает о замене существующего файла
        return transfers.startDownload({ remotePaths: paths, localDir: dirname(res.filePath), singleTarget: res.filePath, overwrite: true })
      }
    }
    const options: Electron.OpenDialogOptions = {
      title: 'Куда сохранить?',
      defaultPath: downloads,
      buttonLabel: 'Сохранить сюда',
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent']
    }
    const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (res.canceled || !res.filePaths[0]) return null
    const dir = res.filePaths[0]
    const existing = paths.map((p) => safeLocalName(posix.basename(p))).filter((name) => existsSync(join(dir, name)))
    const overwrite = await askOverwrite(win, existing, 'в этой папке')
    if (overwrite === null) return null
    return transfers.startDownload({ remotePaths: paths, localDir: dir, overwrite })
  }

  async function startUpload(e: IpcMainInvokeEvent, a: Record<string, unknown>): Promise<string | null> {
    const remoteDir = remotePath(a.remoteDir)
    const fs = ctx.manager.remoteFs(e.sender.id, a.connId)
    const transfers = ctx.manager.transfers(e.sender.id, a.connId)
    const win = BrowserWindow.fromWebContents(e.sender)
    const source = asRecord(a.source)
    let localPaths: string[]
    if (source.kind === 'paths') {
      if (!Array.isArray(source.paths) || !source.paths.length || source.paths.length > 1000) throw new Error('Не выбраны файлы для загрузки.')
      localPaths = []
      for (const p of source.paths) {
        if (typeof p !== 'string' || !isAbsolute(p)) throw new Error('Некорректный путь к файлу на компьютере.')
        await fsp.stat(p) // файл должен существовать
        localPaths.push(p)
      }
    } else {
      const folder = source.kind === 'pick-folder'
      const options: Electron.OpenDialogOptions = {
        title: folder ? 'Выберите папку для загрузки на сервер' : 'Выберите файлы для загрузки на сервер',
        buttonLabel: 'Загрузить',
        properties: folder ? ['openDirectory', 'dontAddToRecent'] : ['openFile', 'multiSelections', 'dontAddToRecent']
      }
      const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      if (res.canceled || !res.filePaths.length) return null
      localPaths = res.filePaths
    }
    const sftp = await fs.channel()
    const existing: string[] = []
    for (const p of localPaths) {
      const name = p.split(/[\\/]/).pop() as string
      try {
        await new Promise<void>((resolve, reject) => sftp.lstat(posix.join(remoteDir, name), (err) => (err ? reject(err) : resolve())))
        existing.push(name)
      } catch {
        // нет такого — хорошо
      }
    }
    const overwrite = await askOverwrite(win, existing, 'на сервере в этой папке')
    if (overwrite === null) return null
    return transfers.startUpload({ localPaths, remoteDir, overwrite })
  }
}
