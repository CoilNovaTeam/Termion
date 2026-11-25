// Файлы на сервере через SFTP (поверх того же SSH-подключения, что и терминал).
//
// Надёжность:
//  • чтение и запись идут параллельными блоками — быстро даже при большой задержке до сервера;
//  • сохранение проверяет, не изменил ли файл кто-то другой с момента открытия;
//  • сохранение атомарное (временный файл + posix-rename), с сохранением прав и владельца;
//    если так нельзя (нет прав на папку, сменился бы владелец, сервер без расширения) —
//    прямая запись в файл;
//  • запись через символическую ссылку идёт в настоящий файл, ссылка остаётся ссылкой;
//  • системные и домашняя папки защищены от удаления.

import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import type { Client, FileEntryWithStats, InputAttributes, SFTPWrapper, Stats } from 'ssh2'
import type { EolId, ReadTextResult, RemoteEntry, RemoteFileMeta, SaveTextResult, TextEncodingId } from '@shared/types'
import { decodeText, encodeText } from './textCodec'

export const MAX_TEXT_FILE = 5 * 1024 * 1024
const CHUNK = 32 * 1024
const PARALLEL = 8

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFREG = 0o100000
const S_IFLNK = 0o120000

export const SFTP_STATUS = { EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4, OP_UNSUPPORTED: 8 } as const

/** Папки, которые нельзя удалить целиком (внутри — можно). */
const PROTECTED = new Set([
  '/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib32', '/lib64', '/libx32', '/media', '/mnt', '/opt',
  '/proc', '/root', '/run', '/sbin', '/snap', '/srv', '/sys', '/tmp', '/usr', '/var'
])

export type RemoteFsErrorKind = 'not-found' | 'denied' | 'exists' | 'protected' | 'unsupported' | 'failed'

export class RemoteFsError extends Error {
  constructor(message: string, readonly kind: RemoteFsErrorKind) {
    super(message)
    this.name = 'RemoteFsError'
  }
}

const isDir = (mode: number) => (mode & S_IFMT) === S_IFDIR
const isFile = (mode: number) => (mode & S_IFMT) === S_IFREG
const isLink = (mode: number) => (mode & S_IFMT) === S_IFLNK
const kindOf = (mode: number): 'dir' | 'file' | 'other' => (isDir(mode) ? 'dir' : isFile(mode) ? 'file' : 'other')
const sftpCode = (err: unknown): number | undefined =>
  typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : undefined

export function toRemoteFsError(err: unknown, path: string): RemoteFsError {
  if (err instanceof RemoteFsError) return err
  switch (sftpCode(err)) {
    case SFTP_STATUS.NO_SUCH_FILE:
      return new RemoteFsError(`Нет такого файла или папки: ${path}`, 'not-found')
    case SFTP_STATUS.PERMISSION_DENIED:
      return new RemoteFsError(`Нет прав доступа: ${path}`, 'denied')
    case SFTP_STATUS.OP_UNSUPPORTED:
      return new RemoteFsError('Сервер не поддерживает эту операцию.', 'unsupported')
    case SFTP_STATUS.FAILURE:
      return new RemoteFsError(`Сервер не смог выполнить операцию: ${path}`, 'failed')
  }
  const message = err instanceof Error ? err.message : String(err)
  if (/No SFTP|subsystem/i.test(message)) return new RemoteFsError('На сервере выключен SFTP — файлы недоступны.', 'unsupported')
  return new RemoteFsError(message, 'failed')
}

function call<T>(fn: (cb: (err: Error | null | undefined, result: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => fn((err, result) => (err ? reject(err) : resolve(result))))
}

function done(fn: (cb: (err: Error | null | undefined) => void) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => fn((err) => (err ? reject(err) : resolve())))
}

export const metaOf = (st: Stats): RemoteFileMeta => ({ mtime: st.mtime, size: st.size, mode: st.mode })

const deaths = new WeakMap<SFTPWrapper, Promise<never>>()

/** Отклоняется, когда канал SFTP закрылся или сломался. */
function channelDeath(sftp: SFTPWrapper): Promise<never> {
  let dead = deaths.get(sftp)
  if (!dead) {
    dead = new Promise<never>((_, reject) => {
      sftp.on('error', (err: Error) => reject(new RemoteFsError(`Связь с сервером по SFTP прервалась: ${err.message}`, 'failed')))
      sftp.once('close', () => reject(new RemoteFsError('Связь с сервером по SFTP прервалась.', 'failed')))
    })
    dead.catch(() => undefined)
    deaths.set(sftp, dead)
  }
  return dead
}

/**
 * Дождаться операции, но не дольше, чем жив канал. Если канал оборвался (сервер прислал
 * слишком большой пакет, закрыл подсистему, пропала связь), ssh2 не вызывает колбэки
 * начатых составных операций — без этой проверки они ждали бы вечно.
 */
export function guard<T>(sftp: SFTPWrapper, work: Promise<T>): Promise<T> {
  work.catch(() => undefined)
  return Promise.race([work, channelDeath(sftp)])
}

/** Естественная сортировка: папки сверху, «file2» перед «file10», без учёта регистра. */
const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' })
export function compareEntries(a: RemoteEntry, b: RemoteEntry): number {
  const ad = a.type === 'dir' || a.target === 'dir'
  const bd = b.type === 'dir' || b.target === 'dir'
  if (ad !== bd) return ad ? -1 : 1
  return collator.compare(a.name, b.name)
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) await fn(items[index++])
  })
  await Promise.all(workers)
}

/** Читает файл целиком параллельными блоками; короткие ответы сервера дочитываются. */
export function readAll(sftp: SFTPWrapper, handle: Buffer, size: number): Promise<Buffer> {
  const out = Buffer.alloc(size)
  if (!size) return Promise.resolve(out)
  return new Promise<Buffer>((resolve, reject) => {
    let next = 0
    let inFlight = 0
    let end = size
    let failed = false
    const request = (offset: number, length: number) => {
      inFlight++
      sftp.read(handle, out, offset, length, offset, (err, bytesRead) => {
        inFlight--
        if (failed) return
        if (err) {
          failed = true
          reject(err)
          return
        }
        if (bytesRead === 0) end = Math.min(end, offset) // файл стал короче, пока читали
        else if (bytesRead < length && offset + bytesRead < end) request(offset + bytesRead, length - bytesRead)
        pump()
      })
    }
    const pump = () => {
      while (!failed && inFlight < PARALLEL && next < end) {
        const length = Math.min(CHUNK, end - next)
        request(next, length)
        next += length
      }
      if (!failed && inFlight === 0) resolve(out.subarray(0, end))
    }
    pump()
  })
}

/** Пишет буфер целиком параллельными блоками. */
export function writeAll(sftp: SFTPWrapper, handle: Buffer, data: Buffer): Promise<void> {
  if (!data.length) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    let next = 0
    let inFlight = 0
    let failed = false
    const pump = () => {
      while (!failed && inFlight < PARALLEL && next < data.length) {
        const offset = next
        const length = Math.min(CHUNK, data.length - offset)
        next += length
        inFlight++
        sftp.write(handle, data, offset, length, offset, (err) => {
          inFlight--
          if (failed) return
          if (err) {
            failed = true
            reject(err)
            return
          }
          pump()
        })
      }
      if (!failed && inFlight === 0 && next >= data.length) resolve()
    }
    pump()
  })
}

class SkipAtomic extends Error {}

export class RemoteFs {
  private channelPromise: Promise<SFTPWrapper> | null = null
  private homeDir: string | null = null
  private disposed = false

  constructor(private readonly client: Client) {}

  /** Основной SFTP-канал (открывается при первом обращении и переоткрывается, если закрылся). */
  channel(): Promise<SFTPWrapper> {
    if (this.disposed) return Promise.reject(new RemoteFsError('Подключение закрыто.', 'failed'))
    if (!this.channelPromise) {
      const promise = this.openChannel()
      this.channelPromise = promise
      const reset = () => {
        if (this.channelPromise === promise) this.channelPromise = null
      }
      // Канал оборвался — следующая операция откроет новый.
      promise.then((sftp) => channelDeath(sftp).catch(reset), reset)
    }
    return this.channelPromise
  }

  /** Отдельный канал для передачи файлов: его можно закрыть, чтобы отменить передачу. */
  openChannel(): Promise<SFTPWrapper> {
    return new Promise<SFTPWrapper>((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) {
          reject(toRemoteFsError(err, ''))
          return
        }
        channelDeath(sftp) // подписка на обрыв — сразу, до первых запросов
        resolve(sftp)
      })
    })
  }

  dispose(): void {
    this.disposed = true
    const pending = this.channelPromise
    this.channelPromise = null
    pending?.then((sftp) => sftp.end()).catch(() => undefined)
  }

  /** Операция на основном канале; если канал оборвётся, она сразу завершится ошибкой. */
  private async on<T>(fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    const sftp = await this.channel()
    return guard(sftp, fn(sftp))
  }

  async home(): Promise<string> {
    if (!this.homeDir) {
      this.homeDir = await this.on((sftp) =>
        call<string>((cb) => sftp.realpath('.', cb)).catch((err) => {
          throw toRemoteFsError(err, '~')
        })
      )
    }
    return this.homeDir
  }

  list(dir: string): Promise<RemoteEntry[]> {
    return this.on((sftp) => this.listOn(sftp, dir))
  }

  private async listOn(sftp: SFTPWrapper, dir: string): Promise<RemoteEntry[]> {
    let list: FileEntryWithStats[]
    try {
      list = await call<FileEntryWithStats[]>((cb) => sftp.readdir(dir, cb))
    } catch (err) {
      throw toRemoteFsError(err, dir)
    }
    const entries: RemoteEntry[] = list
      .filter((e) => e.filename !== '.' && e.filename !== '..')
      .map((e) => ({
        name: e.filename,
        path: posix.join(dir, e.filename),
        type: isLink(e.attrs.mode) ? 'link' : kindOf(e.attrs.mode),
        size: e.attrs.size,
        mtime: e.attrs.mtime,
        mode: e.attrs.mode
      }))
    // Для символических ссылок узнаём, на что они указывают.
    await mapLimit(
      entries.filter((e) => e.type === 'link'),
      8,
      async (e) => {
        try {
          const st = await call<Stats>((cb) => sftp.stat(e.path, cb))
          e.target = kindOf(st.mode)
          e.size = st.size
        } catch {
          e.target = 'broken'
        }
        try {
          e.linkTo = await call<string>((cb) => sftp.readlink(e.path, cb))
        } catch {
          // не страшно
        }
      }
    )
    return entries.sort(compareEntries)
  }

  stat(path: string): Promise<RemoteEntry> {
    return this.on(async (sftp) => {
      try {
        const st = await call<Stats>((cb) => sftp.stat(path, cb))
        return { name: posix.basename(path) || '/', path, type: kindOf(st.mode), size: st.size, mtime: st.mtime, mode: st.mode }
      } catch (err) {
        throw toRemoteFsError(err, path)
      }
    })
  }

  readText(path: string, maxBytes = MAX_TEXT_FILE): Promise<ReadTextResult> {
    return this.on((sftp) => this.readTextOn(sftp, path, maxBytes))
  }

  private async readTextOn(sftp: SFTPWrapper, path: string, maxBytes: number): Promise<ReadTextResult> {
    let handle: Buffer | null = null
    try {
      handle = await call<Buffer>((cb) => sftp.open(path, 'r', cb))
      const st = await call<Stats>((cb) => sftp.fstat(handle as Buffer, cb))
      if (isDir(st.mode)) throw new RemoteFsError('Это папка, а не файл.', 'failed')
      if (st.size > maxBytes) return { ok: false, reason: 'too-large', size: st.size }
      const data = await readAll(sftp, handle, st.size)
      const decoded = decodeText(data)
      if (decoded.binary) return { ok: false, reason: 'binary', size: st.size }
      return { ok: true, text: decoded.text, encoding: decoded.encoding, eol: decoded.eol, meta: metaOf(st) }
    } catch (err) {
      throw toRemoteFsError(err, path)
    } finally {
      if (handle) await done((cb) => sftp.close(handle as Buffer, cb)).catch(() => undefined)
    }
  }

  async writeText(
    path: string,
    text: string,
    encoding: TextEncodingId,
    eol: EolId,
    expected: RemoteFileMeta | null,
    force: boolean
  ): Promise<SaveTextResult> {
    const data = encodeText(text, encoding, eol)
    return this.on((sftp) => this.writeTextOn(sftp, path, data, expected, force))
  }

  private async writeTextOn(
    sftp: SFTPWrapper,
    path: string,
    data: Buffer,
    expected: RemoteFileMeta | null,
    force: boolean
  ): Promise<SaveTextResult> {
    try {
      const current = await this.statOrNull(sftp, path)
      if (!force && expected) {
        if (!current) return { ok: false, conflict: 'deleted' }
        if (current.mtime !== expected.mtime || current.size !== expected.size) return { ok: false, conflict: 'changed' }
      }
      // Ссылка: пишем в файл, на который она указывает, а сама ссылка остаётся.
      let target = path
      const link = await this.lstatOrNull(sftp, path)
      if (link && isLink(link.mode)) target = await call<string>((cb) => sftp.realpath(path, cb))

      let atomic = false
      if (this.supports(sftp, 'posix-rename@openssh.com')) atomic = await this.atomicWrite(sftp, target, data, current)
      if (!atomic) await this.directWrite(sftp, target, data, current ? undefined : 0o644)
      const after = await call<Stats>((cb) => sftp.stat(path, cb))
      return { ok: true, meta: metaOf(after), atomic }
    } catch (err) {
      throw toRemoteFsError(err, path)
    }
  }

  mkdir(path: string): Promise<void> {
    return this.on(async (sftp) => {
      if (await this.lstatOrNull(sftp, path)) throw new RemoteFsError(`«${posix.basename(path)}» уже существует.`, 'exists')
      await done((cb) => sftp.mkdir(path, {}, cb)).catch((err) => {
        throw toRemoteFsError(err, path)
      })
    })
  }

  createFile(path: string): Promise<void> {
    return this.on(async (sftp) => {
      if (await this.lstatOrNull(sftp, path)) throw new RemoteFsError(`«${posix.basename(path)}» уже существует.`, 'exists')
      try {
        const handle = await call<Buffer>((cb) => sftp.open(path, 'wx', { mode: 0o644 }, cb))
        await done((cb) => sftp.close(handle, cb))
      } catch (err) {
        throw toRemoteFsError(err, path)
      }
    })
  }

  rename(from: string, to: string): Promise<void> {
    return this.on(async (sftp) => {
      if (from === to) return
      if (await this.lstatOrNull(sftp, to)) throw new RemoteFsError(`«${posix.basename(to)}» уже существует.`, 'exists')
      await done((cb) => sftp.rename(from, to, cb)).catch((err) => {
        throw toRemoteFsError(err, from)
      })
    })
  }

  async remove(path: string): Promise<void> {
    if (PROTECTED.has(path) || path === (await this.home().catch(() => null))) {
      throw new RemoteFsError('Эту папку удалять нельзя: это системная или домашняя папка.', 'protected')
    }
    await this.on(async (sftp) => {
      try {
        const st = await call<Stats>((cb) => sftp.lstat(path, cb))
        if (isDir(st.mode)) await this.removeTree(sftp, path)
        else await done((cb) => sftp.unlink(path, cb))
      } catch (err) {
        throw toRemoteFsError(err, path)
      }
    })
  }

  /** Есть ли у сервера расширение OpenSSH (posix-rename, fsync…). */
  supports(sftp: SFTPWrapper, ext: string): boolean {
    const extensions = (sftp as unknown as { _extensions?: Record<string, string> })._extensions
    return !!extensions && Object.prototype.hasOwnProperty.call(extensions, ext)
  }

  // ---------- внутреннее ----------

  private async removeTree(sftp: SFTPWrapper, dir: string): Promise<void> {
    const items = await call<FileEntryWithStats[]>((cb) => sftp.readdir(dir, cb))
    for (const item of items) {
      if (item.filename === '.' || item.filename === '..') continue
      const p = posix.join(dir, item.filename)
      // Атрибуты из readdir — как у lstat: ссылку на папку удаляем как ссылку, внутрь не заходим.
      if (isDir(item.attrs.mode)) await this.removeTree(sftp, p)
      else await done((cb) => sftp.unlink(p, cb))
    }
    await done((cb) => sftp.rmdir(dir, cb))
  }

  private async statOrNull(sftp: SFTPWrapper, path: string): Promise<Stats | null> {
    try {
      return await call<Stats>((cb) => sftp.stat(path, cb))
    } catch (err) {
      if (sftpCode(err) === SFTP_STATUS.NO_SUCH_FILE) return null
      throw err
    }
  }

  private async lstatOrNull(sftp: SFTPWrapper, path: string): Promise<Stats | null> {
    try {
      return await call<Stats>((cb) => sftp.lstat(path, cb))
    } catch (err) {
      if (sftpCode(err) === SFTP_STATUS.NO_SUCH_FILE) return null
      throw err
    }
  }

  private async fsync(sftp: SFTPWrapper, handle: Buffer): Promise<void> {
    if (!this.supports(sftp, 'fsync@openssh.com')) return
    await call<unknown>((cb) => sftp.ext_openssh_fsync(handle, cb)).catch(() => undefined)
  }

  /**
   * Пишет во временный файл рядом и атомарно подменяет им оригинал.
   * false — атомарно нельзя (нет прав на папку или сменился бы владелец); тогда пишем напрямую.
   */
  private async atomicWrite(sftp: SFTPWrapper, target: string, data: Buffer, current: Stats | null): Promise<boolean> {
    const tmp = posix.join(posix.dirname(target), `.${posix.basename(target)}.termion-${randomBytes(4).toString('hex')}.tmp`)
    const mode = current ? current.mode & 0o7777 : 0o644
    let handle: Buffer | null
    try {
      handle = await call<Buffer>((cb) => sftp.open(tmp, 'wx', { mode } as InputAttributes, cb))
    } catch {
      return false
    }
    try {
      await writeAll(sftp, handle, data)
      if (current) {
        const mine = await call<Stats>((cb) => sftp.fstat(handle as Buffer, cb))
        if (mine.uid !== current.uid || mine.gid !== current.gid) {
          // Вернуть владельца может только root. Не получилось — пишем напрямую, чтобы не сменить владельца.
          await done((cb) => sftp.fsetstat(handle as Buffer, { uid: current.uid, gid: current.gid }, cb)).catch(() => {
            throw new SkipAtomic()
          })
        }
        await done((cb) => sftp.fsetstat(handle as Buffer, { mode }, cb)).catch(() => undefined)
      }
      await this.fsync(sftp, handle)
      await done((cb) => sftp.close(handle as Buffer, cb))
      handle = null
      await done((cb) => sftp.ext_openssh_rename(tmp, target, cb))
      return true
    } catch (err) {
      if (handle) await done((cb) => sftp.close(handle as Buffer, cb)).catch(() => undefined)
      await done((cb) => sftp.unlink(tmp, cb)).catch(() => undefined)
      if (err instanceof SkipAtomic) return false
      throw err
    }
  }

  private async directWrite(sftp: SFTPWrapper, target: string, data: Buffer, mode?: number): Promise<void> {
    const handle = await call<Buffer>((cb) =>
      mode === undefined ? sftp.open(target, 'w', cb) : sftp.open(target, 'w', { mode } as InputAttributes, cb)
    )
    try {
      await writeAll(sftp, handle, data)
      await this.fsync(sftp, handle)
    } finally {
      await done((cb) => sftp.close(handle, cb)).catch(() => undefined)
    }
  }
}
