// Передача файлов: скачивание на компьютер и загрузка на сервер (файлы и папки целиком).
//
//  • передачи идут по очереди, у каждой — свой SFTP-канал: отмена просто закрывает канал;
//  • файл пишется под временным именем и получает настоящее только после полной передачи —
//    оборванная передача не портит существующий файл;
//  • имена с сервера приводятся к допустимым в Windows и не могут выйти за пределы выбранной папки;
//  • символические ссылки на папки не обходятся (нет зацикливания).

import { promises as fs } from 'node:fs'
import { basename, dirname, join, posix } from 'node:path'
import type { FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2'
import type { TransferJob } from '@shared/types'
import { safeLocalName } from '@shared/remotePath'
import { newId } from '@shared/tree'
import { guard, SFTP_STATUS, type RemoteFs } from './remoteFs'

export interface DownloadPlan {
  remotePaths: string[]
  /** Папка на компьютере. */
  localDir: string
  /** Для одного файла — точный путь из окна «Сохранить как». */
  singleTarget?: string
  /** true — заменять существующие, false — пропускать. */
  overwrite: boolean
}

export interface UploadPlan {
  localPaths: string[]
  remoteDir: string
  overwrite: boolean
}

interface FileItem {
  from: string
  to: string
  size: number
}

export interface TrackedTransfer {
  id: string
  cancelled(): boolean
  start(totalBytes: number, totalFiles: number): void
  bytes(n: number): void
  fileDone(): void
  finish(state: 'done' | 'failed' | 'cancelled', error?: string): void
}

interface Running {
  job: TransferJob
  cancelled: boolean
  channel: SFTPWrapper | null
  lastEmit: number
}

const PART = '.termion-part'
const CHUNK = 32 * 1024
/** Сколько блоков в пути одновременно: 32 × 32 КБ — быстро даже при большой задержке до сервера. */
const PARALLEL = 32

export { safeLocalName }

function call<T>(fn: (cb: (err: Error | null | undefined, result: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => fn((err, result) => (err ? reject(err) : resolve(result))))
}

function done(fn: (cb: (err: Error | null | undefined) => void) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => fn((err) => (err ? reject(err) : resolve())))
}

const S_IFMT = 0o170000
const isDir = (mode: number) => (mode & S_IFMT) === 0o040000
const isLink = (mode: number) => (mode & S_IFMT) === 0o120000

async function localExists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Конвейер передачи: до PARALLEL блоков одновременно, запись по смещениям.
 * При отмене новые блоки не запрашиваются, уже отправленные дожидаются — файлы закрываются
 * аккуратно, и временный файл можно сразу удалить (в отличие от fastGet/fastPut из ssh2,
 * которые после отмены держат файлы до закрытия всего подключения).
 */
function pipeline(
  size: number,
  readChunk: (offset: number, length: number, done: (err: unknown, data: Buffer | null) => void) => void,
  writeChunk: (offset: number, data: Buffer) => Promise<void>,
  onBytes: (n: number) => void,
  cancelled: () => boolean
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let next = 0
    let end = size
    let inFlight = 0
    let failure: unknown = null
    let settled = false
    const settle = () => {
      if (settled || inFlight > 0) return
      if (failure) {
        settled = true
        reject(failure)
      } else if (cancelled() || next >= end) {
        settled = true
        resolve()
      }
    }
    const request = (offset: number, length: number) => {
      inFlight++
      readChunk(offset, length, (err, data) => {
        if (err || !data) {
          if (err) failure ??= err
          else end = Math.min(end, offset) // источник стал короче
          inFlight--
          pump()
          return
        }
        writeChunk(offset, data).then(
          () => {
            onBytes(data.length)
            inFlight--
            // Сервер вправе вернуть меньше, чем просили, — дочитываем остаток.
            if (data.length < length && offset + data.length < end && !failure && !cancelled()) {
              request(offset + data.length, length - data.length)
            }
            pump()
          },
          (e) => {
            failure ??= e
            inFlight--
            pump()
          }
        )
      })
    }
    const pump = () => {
      while (!failure && !cancelled() && inFlight < PARALLEL && next < end) {
        const length = Math.min(CHUNK, end - next)
        request(next, length)
        next += length
      }
      settle()
    }
    pump()
  })
}

async function downloadFile(sftp: SFTPWrapper, remote: string, local: string, size: number, onBytes: (n: number) => void, cancelled: () => boolean): Promise<void> {
  const handle = await call<Buffer>((cb) => sftp.open(remote, 'r', cb))
  let out: fs.FileHandle | null = null
  try {
    out = await fs.open(local, 'w')
    const file = out
    await pipeline(
      size,
      (offset, length, cb) => {
        const buf = Buffer.allocUnsafe(length)
        sftp.read(handle, buf, 0, length, offset, (err, bytesRead) => cb(err, err ? null : bytesRead ? buf.subarray(0, bytesRead) : null))
      },
      async (offset, data) => {
        await file.write(data, 0, data.length, offset)
      },
      onBytes,
      cancelled
    )
  } finally {
    await out?.close().catch(() => undefined)
    await done((cb) => sftp.close(handle, cb)).catch(() => undefined)
  }
}

async function uploadFile(sftp: SFTPWrapper, local: string, remote: string, size: number, onBytes: (n: number) => void, cancelled: () => boolean): Promise<void> {
  const input = await fs.open(local, 'r')
  let handle: Buffer | null = null
  try {
    handle = await call<Buffer>((cb) => sftp.open(remote, 'w', cb))
    const target = handle
    await pipeline(
      size,
      (offset, length, cb) => {
        const buf = Buffer.allocUnsafe(length)
        input.read(buf, 0, length, offset).then(
          ({ bytesRead }) => cb(null, bytesRead ? buf.subarray(0, bytesRead) : null),
          (err) => cb(err, null)
        )
      },
      (offset, data) => done((cb) => sftp.write(target, data, 0, data.length, offset, cb)),
      onBytes,
      cancelled
    )
  } finally {
    await input.close().catch(() => undefined)
    if (handle) await done((cb) => sftp.close(handle as Buffer, cb)).catch(() => undefined)
  }
}

export async function remoteExists(sftp: SFTPWrapper, path: string): Promise<boolean> {
  try {
    await call<Stats>((cb) => sftp.lstat(path, cb))
    return true
  } catch (err) {
    if ((err as { code?: number }).code === SFTP_STATUS.NO_SUCH_FILE) return false
    throw err
  }
}

const describe = (err: unknown): string => {
  const code = (err as { code?: unknown })?.code
  if (code === SFTP_STATUS.PERMISSION_DENIED || code === 'EACCES' || code === 'EPERM') return 'Нет прав доступа.'
  if (code === SFTP_STATUS.NO_SUCH_FILE || code === 'ENOENT') return 'Файл или папка не найдены.'
  if (code === 'ENOSPC') return 'На диске закончилось место.'
  if (code === SFTP_STATUS.FAILURE) return 'Сервер не смог записать файл (возможно, закончилось место).'
  return err instanceof Error ? err.message : String(err)
}

export class TransferManager {
  private readonly running = new Map<string, Running>()
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly connId: string,
    private readonly fs: RemoteFs,
    private readonly emit: (job: TransferJob) => void
  ) {}

  startDownload(plan: DownloadPlan): string {
    const title = plan.remotePaths.length === 1 ? posix.basename(plan.remotePaths[0]) : `Объектов: ${plan.remotePaths.length}`
    const r = this.create('download', title)
    r.job.localPath = plan.singleTarget ?? plan.localDir
    this.enqueue(r, () => this.download(r, plan))
    return r.job.id
  }

  startUpload(plan: UploadPlan): string {
    const title = plan.localPaths.length === 1 ? basename(plan.localPaths[0]) : `Объектов: ${plan.localPaths.length}`
    const r = this.create('upload', title)
    r.job.remoteDir = plan.remoteDir
    this.enqueue(r, () => this.upload(r, plan))
    return r.job.id
  }

  /**
   * Передача, которую ведёт кто-то вне очереди (поток для Проводника при перетаскивании):
   * идёт сразу, не дожидаясь других, но видна в списке и отменяется так же.
   */
  track(title: string): TrackedTransfer {
    const r = this.create('download', title)
    r.job.dragOut = true
    return {
      id: r.job.id,
      cancelled: () => r.cancelled,
      start: (totalBytes, totalFiles) => {
        r.job.state = 'running'
        r.job.totalBytes = totalBytes
        r.job.totalFiles = totalFiles
        this.progress(r, true)
      },
      bytes: (n) => {
        r.job.doneBytes += n
        this.progress(r)
      },
      fileDone: () => {
        r.job.doneFiles++
        this.progress(r)
      },
      finish: (state, error) => this.finish(r, state, error)
    }
  }

  /**
   * Отмена. Для интерфейса передача отменена сразу; уборка (закрытие файлов, удаление
   * временного файла) завершается в фоне — даже если связь с сервером зависла.
   */
  cancel(jobId: string): boolean {
    const r = this.running.get(jobId)
    if (!r) return false
    r.cancelled = true
    this.finish(r, 'cancelled')
    return true
  }

  cancelAll(): void {
    for (const id of [...this.running.keys()]) this.cancel(id)
  }

  // ---------- внутреннее ----------

  private bytes(r: Running): (n: number) => void {
    return (n) => {
      r.job.doneBytes += n
      this.progress(r)
    }
  }

  private create(kind: TransferJob['kind'], title: string): Running {
    const job: TransferJob = {
      id: newId(),
      connId: this.connId,
      kind,
      title,
      state: 'preparing',
      totalBytes: 0,
      doneBytes: 0,
      totalFiles: 0,
      doneFiles: 0,
      skipped: 0
    }
    const r: Running = { job, cancelled: false, channel: null, lastEmit: 0 }
    this.running.set(job.id, r)
    this.emit({ ...job })
    return r
  }

  private enqueue(r: Running, work: () => Promise<void>): void {
    this.queue = this.queue.then(async () => {
      if (r.cancelled) return
      try {
        r.channel = await this.fs.openChannel()
        if (r.cancelled) throw new Error('cancelled')
        await guard(r.channel, work())
        this.finish(r, r.cancelled ? 'cancelled' : 'done')
      } catch (err) {
        this.finish(r, r.cancelled ? 'cancelled' : 'failed', r.cancelled ? undefined : describe(err))
      } finally {
        r.channel?.end()
        r.channel = null
      }
    })
  }

  private finish(r: Running, state: TransferJob['state'], error?: string): void {
    if (!this.running.has(r.job.id)) return
    r.job.state = state
    if (error) r.job.error = error
    this.running.delete(r.job.id)
    this.emit({ ...r.job })
  }

  private progress(r: Running, force = false): void {
    const now = Date.now()
    if (!force && now - r.lastEmit < 150) return
    r.lastEmit = now
    this.emit({ ...r.job })
  }

  private async download(r: Running, plan: DownloadPlan): Promise<void> {
    const sftp = r.channel as SFTPWrapper
    const files: FileItem[] = []
    const dirs: string[] = []
    for (const remote of plan.remotePaths) {
      const local = plan.singleTarget ?? join(plan.localDir, safeLocalName(posix.basename(remote)))
      if (!plan.overwrite && (await localExists(local))) {
        r.job.skipped++
        continue
      }
      await this.collectRemote(sftp, remote, local, files, dirs, r, true)
    }
    r.job.state = 'running'
    r.job.totalFiles = files.length
    r.job.totalBytes = files.reduce((n, f) => n + f.size, 0)
    this.progress(r, true)

    for (const dir of dirs) await fs.mkdir(dir, { recursive: true })
    for (const file of files) {
      if (r.cancelled) return
      await fs.mkdir(dirname(file.to), { recursive: true })
      const part = file.to + PART
      const base = r.job.doneBytes
      try {
        await downloadFile(sftp, file.from, part, file.size, this.bytes(r), () => r.cancelled)
        if (r.cancelled) throw new Error('cancelled')
        await fs.rename(part, file.to)
      } catch (err) {
        await fs.rm(part, { force: true }).catch(() => undefined)
        throw err
      }
      r.job.doneFiles++
      r.job.doneBytes = base + file.size
      this.progress(r)
    }
  }

  private async collectRemote(
    sftp: SFTPWrapper,
    remote: string,
    local: string,
    files: FileItem[],
    dirs: string[],
    r: Running,
    top = false
  ): Promise<void> {
    if (r.cancelled) return
    let st = await call<Stats>((cb) => sftp.lstat(remote, cb))
    if (isLink(st.mode)) {
      try {
        st = await call<Stats>((cb) => sftp.stat(remote, cb))
      } catch {
        return // битая ссылка
      }
      // Явно выбранную ссылку на папку скачиваем; внутри папок такие ссылки не обходим — можно зациклиться.
      if (isDir(st.mode) && !top) return
    }
    if (isDir(st.mode)) {
      dirs.push(local)
      const items = await call<FileEntryWithStats[]>((cb) => sftp.readdir(remote, cb))
      for (const item of items) {
        if (item.filename === '.' || item.filename === '..') continue
        await this.collectRemote(sftp, posix.join(remote, item.filename), join(local, safeLocalName(item.filename)), files, dirs, r)
      }
      return
    }
    files.push({ from: remote, to: local, size: st.size })
  }

  private async upload(r: Running, plan: UploadPlan): Promise<void> {
    const sftp = r.channel as SFTPWrapper
    const atomic = this.fs.supports(sftp, 'posix-rename@openssh.com')
    const files: FileItem[] = []
    const dirs: string[] = []
    for (const local of plan.localPaths) {
      const remote = posix.join(plan.remoteDir, basename(local))
      if (!plan.overwrite && (await remoteExists(sftp, remote))) {
        r.job.skipped++
        continue
      }
      await this.collectLocal(local, remote, files, dirs, r)
    }
    r.job.state = 'running'
    r.job.totalFiles = files.length
    r.job.totalBytes = files.reduce((n, f) => n + f.size, 0)
    this.progress(r, true)

    for (const dir of dirs) {
      try {
        await done((cb) => sftp.mkdir(dir, {}, cb))
      } catch (err) {
        if (!(await remoteExists(sftp, dir))) throw err // уже есть — значит, сливаем содержимое
      }
    }
    for (const file of files) {
      if (r.cancelled) return
      const tmp = posix.join(posix.dirname(file.to), `.${posix.basename(file.to)}${PART}`)
      const base = r.job.doneBytes
      try {
        await uploadFile(sftp, file.from, tmp, file.size, this.bytes(r), () => r.cancelled)
        if (r.cancelled) throw new Error('cancelled')
        if (atomic) {
          await done((cb) => sftp.ext_openssh_rename(tmp, file.to, cb))
        } else {
          if (await remoteExists(sftp, file.to)) await done((cb) => sftp.unlink(file.to, cb))
          await done((cb) => sftp.rename(tmp, file.to, cb))
        }
      } catch (err) {
        await done((cb) => sftp.unlink(tmp, cb)).catch(() => undefined)
        throw err
      }
      r.job.doneFiles++
      r.job.doneBytes = base + file.size
      this.progress(r)
    }
  }

  private async collectLocal(local: string, remote: string, files: FileItem[], dirs: string[], r: Running): Promise<void> {
    if (r.cancelled) return
    const st = await fs.lstat(local)
    if (st.isSymbolicLink()) return // ссылки и точки соединения Windows не обходим
    if (st.isDirectory()) {
      dirs.push(remote)
      for (const entry of await fs.readdir(local, { withFileTypes: true })) {
        await this.collectLocal(join(local, entry.name), posix.join(remote, entry.name), files, dirs, r)
      }
      return
    }
    if (st.isFile()) files.push({ from: local, to: remote, size: st.size })
  }
}
