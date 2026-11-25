// Перетаскивание из дерева файлов в Проводник.
//
// Окно кладёт в перетаскивание ссылку termion-dl://get/<token>/<имя> в формате DownloadURL
// (так Chromium перетаскивает загрузки). Когда её отпускают в Проводнике, Chromium сам
// скачивает ссылку во временный файл и отдаёт его Проводнику, а Проводник ждёт окончания
// скачивания. Поэтому недокачанный файл никогда не окажется у пользователя, сколько бы он
// ни весил, и ничего не скачивается, если файл просто перетащили внутри программы.
//
// Один файл отдаётся как есть. Папка или несколько объектов — одним zip-архивом: Windows не
// даёт обычной программе «пообещать» при перетаскивании папку, а один файл — можно.

import { posix } from 'node:path'
import { ReadableStream } from 'node:stream/web'
import type { FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2'
import { safeLocalName } from '@shared/remotePath'
import { zipStream, type ZipEntry } from '../zipStream'
import { guard, SFTP_STATUS, type RemoteFs } from './remoteFs'
import type { TrackedTransfer, TransferManager } from './transfers'

export const DRAG_SCHEME = 'termion-dl'

/** Сколько живёт ссылка: перетаскивание может закончиться и через несколько минут. */
const TTL = 30 * 60 * 1000
const CHUNK = 32 * 1024
/** Блоков в пути одновременно: 16 × 32 КБ — быстро даже при большой задержке до сервера. */
const DEPTH = 16

const S_IFMT = 0o170000
const isDir = (mode: number) => (mode & S_IFMT) === 0o040000
const isFile = (mode: number) => (mode & S_IFMT) === 0o100000
const isLink = (mode: number) => (mode & S_IFMT) === 0o120000

interface Ticket {
  owner: number
  connId: string
  paths: string[]
  title: string
  created: number
}

export interface DragOutDeps {
  /** Файлы и передачи подключения окна; бросает ошибку, если подключения нет. */
  resolve(owner: number, connId: string): { fs: RemoteFs; transfers: TransferManager }
}

function call<T>(fn: (cb: (err: Error | null | undefined, result: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => fn((err, result) => (err ? reject(err) : resolve(result))))
}

/** Прочитать до length байт с позиции offset; короткие ответы сервера дочитываются. Конец файла — меньше байт. */
async function readAt(sftp: SFTPWrapper, handle: Buffer, offset: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length)
  let got = 0
  while (got < length) {
    const n = await guard(
      sftp,
      new Promise<number>((resolve, reject) =>
        sftp.read(handle, buf, got, length - got, offset + got, (err, bytesRead) => (err ? reject(err) : resolve(bytesRead)))
      )
    )
    if (!n) break
    got += n
  }
  return got === length ? buf : buf.subarray(0, got)
}

/**
 * Файл с сервера по порядку блоками, с упреждающим чтением DEPTH блоков.
 * Отдаёт не больше size байт (размер на момент начала), даже если файл тем временем растёт.
 */
export async function* readRemoteFile(
  sftp: SFTPWrapper,
  path: string,
  size: number,
  onBytes: (n: number) => void,
  cancelled: () => boolean
): AsyncGenerator<Buffer> {
  const handle = await guard(sftp, call<Buffer>((cb) => sftp.open(path, 'r', cb)))
  try {
    let next = 0
    const queue: { length: number; data: Promise<Buffer> }[] = []
    const fill = () => {
      while (queue.length < DEPTH && next < size) {
        const offset = next
        const length = Math.min(CHUNK, size - offset)
        next += length
        const data = readAt(sftp, handle, offset, length)
        data.catch(() => undefined) // ошибку получит тот, кто дождётся этого блока
        queue.push({ length, data })
      }
    }
    fill()
    while (queue.length) {
      if (cancelled()) throw new Error('Передача отменена.')
      const { length, data } = queue.shift() as { length: number; data: Promise<Buffer> }
      const chunk = await data
      if (chunk.length) {
        onBytes(chunk.length)
        yield chunk
      }
      if (chunk.length < length) break // файл стал короче, пока читали — дальше читать нечего
      fill()
    }
  } finally {
    await guard(
      sftp,
      new Promise<void>((resolve) => sftp.close(handle, () => resolve()))
    ).catch(() => undefined)
  }
}

interface Planned {
  entry: Omit<ZipEntry, 'data'>
  remote: string | null
}

/** Список элементов архива: папки целиком; ссылки на папки обходятся только на верхнем уровне. */
async function planZip(sftp: SFTPWrapper, roots: string[], cancelled: () => boolean): Promise<Planned[]> {
  const out: Planned[] = []
  const used = new Set<string>()
  const walk = async (remote: string, name: string, top: boolean): Promise<void> => {
    if (cancelled()) throw new Error('Передача отменена.')
    let st = await guard(sftp, call<Stats>((cb) => sftp.lstat(remote, cb)))
    if (isLink(st.mode)) {
      try {
        st = await guard(sftp, call<Stats>((cb) => sftp.stat(remote, cb)))
      } catch {
        return // битая ссылка
      }
      if (isDir(st.mode) && !top) return // ссылки на папки внутри не обходим — можно зациклиться
    }
    if (isDir(st.mode)) {
      out.push({ entry: { name, dir: true, mtime: st.mtime, mode: st.mode, size: 0 }, remote: null })
      const items = await guard(sftp, call<FileEntryWithStats[]>((cb) => sftp.readdir(remote, cb)))
      items.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0))
      for (const item of items) {
        if (item.filename === '.' || item.filename === '..') continue
        await walk(posix.join(remote, item.filename), `${name}/${safeLocalName(item.filename)}`, false)
      }
    } else if (isFile(st.mode)) {
      out.push({ entry: { name, dir: false, mtime: st.mtime, mode: st.mode, size: st.size }, remote })
    }
    // сокеты, устройства и прочее в архив не попадают
  }
  for (const root of roots) {
    // Одинаковые имена на верхнем уровне (файлы из разных папок) — «имя (2)».
    const base = safeLocalName(posix.basename(root) || 'root')
    let name = base
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base} (${i})`
    used.add(name.toLowerCase())
    await walk(root, name, true)
  }
  return out
}

export class DragOutService {
  private readonly tickets = new Map<string, Ticket>()

  constructor(private readonly deps: DragOutDeps) {}

  /** Окно начало перетаскивание: запомнить, какие файлы отдавать по этой ссылке. */
  register(owner: number, token: string, connId: string, paths: string[], title: string): void {
    this.sweep()
    this.deps.resolve(owner, connId) // подключение есть и принадлежит этому окну
    this.tickets.set(token, { owner, connId, paths, title, created: Date.now() })
  }

  /** Обработчик протокола termion-dl: Chromium скачивает ссылку, когда её отпустили в Проводнике. */
  async handle(request: Request): Promise<Response> {
    const token = new URL(request.url).pathname.split('/')[1] ?? ''
    const ticket = this.tickets.get(token)
    if (!ticket || Date.now() - ticket.created > TTL) return new Response('Ссылка устарела.', { status: 404 })
    let fs: RemoteFs
    let transfers: TransferManager
    try {
      ;({ fs, transfers } = this.deps.resolve(ticket.owner, ticket.connId))
    } catch {
      return new Response('Нет подключения к серверу.', { status: 410 })
    }
    let sftp: SFTPWrapper
    try {
      sftp = await fs.openChannel()
    } catch (err) {
      return new Response(err instanceof Error ? err.message : String(err), { status: 502 })
    }
    const transfer = transfers.track(ticket.title)
    let single: Stats | null = null
    try {
      if (ticket.paths.length === 1) {
        const st = await guard(sftp, call<Stats>((cb) => sftp.stat(ticket.paths[0], cb)))
        if (isFile(st.mode)) single = st
      }
    } catch (err) {
      transfer.finish('failed', describe(err))
      sftp.end()
      return new Response(describe(err), { status: 404 })
    }
    const body = single ? this.fileBody(sftp, ticket.paths[0], single.size, transfer) : this.zipBody(sftp, ticket.paths, transfer)
    const stream = toWebStream(body, () => {
      // Поток бросили, не начав читать: генератор не запускался — убираем за ним сами.
      transfer.finish('cancelled')
      sftp.end()
    })
    return new Response(stream as never, {
      status: 200,
      headers: { 'Content-Type': single ? 'application/octet-stream' : 'application/zip' }
    })
  }

  private async *fileBody(sftp: SFTPWrapper, path: string, size: number, transfer: TrackedTransfer): AsyncGenerator<Buffer> {
    yield* this.run(sftp, transfer, async function* () {
      transfer.start(size, 1)
      yield* readRemoteFile(sftp, path, size, transfer.bytes, transfer.cancelled)
      transfer.fileDone()
    })
  }

  private async *zipBody(sftp: SFTPWrapper, paths: string[], transfer: TrackedTransfer): AsyncGenerator<Buffer> {
    yield* this.run(sftp, transfer, async function* () {
      const plan = await planZip(sftp, paths, transfer.cancelled)
      const files = plan.filter((p) => p.remote)
      transfer.start(
        files.reduce((n, p) => n + p.entry.size, 0),
        files.length
      )
      const entries: ZipEntry[] = plan.map(({ entry, remote }) => ({
        ...entry,
        data: remote
          ? async function* () {
              yield* readRemoteFile(sftp, remote, entry.size, transfer.bytes, transfer.cancelled)
              transfer.fileDone()
            }
          : undefined
      }))
      yield* zipStream(entries)
    })
  }

  /** Общая обвязка: итог передачи в списке и закрытие канала — при успехе, ошибке и отмене. */
  private async *run(sftp: SFTPWrapper, transfer: TrackedTransfer, work: () => AsyncGenerator<Buffer>): AsyncGenerator<Buffer> {
    let outcome: 'done' | 'failed' | 'cancelled' = 'cancelled' // если поток бросили на середине — это отмена
    let error: string | undefined
    try {
      yield* work()
      outcome = 'done'
    } catch (err) {
      outcome = transfer.cancelled() ? 'cancelled' : 'failed'
      error = describe(err)
      throw err
    } finally {
      transfer.finish(outcome, outcome === 'failed' ? error : undefined)
      sftp.end()
    }
  }

  private sweep(): void {
    const now = Date.now()
    for (const [token, t] of this.tickets) if (now - t.created > TTL) this.tickets.delete(token)
  }
}

/** Генератор как поток для Response: следующий кусок читается, только когда Chromium готов его принять. */
function toWebStream(gen: AsyncGenerator<Buffer>, abandon: () => void): ReadableStream<Uint8Array> {
  let started = false
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        started = true
        try {
          const { value, done } = await gen.next()
          if (done) controller.close()
          else controller.enqueue(value)
        } catch (err) {
          controller.error(err)
        }
      },
      async cancel() {
        if (!started) abandon()
        await gen.return(undefined).catch(() => undefined)
      }
    },
    { highWaterMark: 4 }
  )
}

function describe(err: unknown): string {
  const code = (err as { code?: unknown })?.code
  if (code === SFTP_STATUS.PERMISSION_DENIED) return 'Нет прав доступа.'
  if (code === SFTP_STATUS.NO_SUCH_FILE) return 'Файл или папка не найдены.'
  return err instanceof Error ? err.message : String(err)
}
