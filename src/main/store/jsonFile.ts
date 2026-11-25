// Надёжное хранение JSON на диске:
//  • запись атомарная: сначала во временный файл с fsync, затем переименование;
//  • перед каждой записью предыдущая версия сохраняется в .bak;
//  • повреждённый файл не теряется: копируется в .corrupt-<время>, данные берутся из .bak;
//  • записи выстраиваются в очередь и никогда не идут параллельно;
//  • временные блокировки файла (антивирус, индексатор Windows) переживаются повторами.

import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

export interface ParseResult<T> {
  value: T
  /** Некритичные проблемы: записи, пропущенные при мягкой проверке. */
  issues: string[]
}

export type LoadStatus = 'ok' | 'missing' | 'recovered' | 'reset'

export interface LoadResult<T> {
  data: T
  status: LoadStatus
  issues: string[]
  /** Куда сохранена копия повреждённого файла. */
  corruptCopy?: string
}

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'EMFILE', 'ENFILE'])

const errCode = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function withRetry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      last = err
      if (!RETRY_CODES.has(errCode(err) ?? '')) throw err
      await sleep(30 * (i + 1))
    }
  }
  throw last
}

const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

export class JsonFile<T> {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    readonly file: string,
    private readonly parse: (raw: unknown) => ParseResult<T>,
    private readonly fallback: () => T
  ) {}

  async load(): Promise<LoadResult<T>> {
    let text: string
    try {
      text = await fs.readFile(this.file, 'utf8')
    } catch (err) {
      if (errCode(err) === 'ENOENT') return { data: this.fallback(), status: 'missing', issues: [] }
      throw err
    }
    try {
      const { value, issues } = this.parse(JSON.parse(stripBom(text)))
      if (issues.length) {
        // Часть записей не прошла проверку — сохраняем оригинал, чтобы ничего не потерять.
        const copy = `${this.file}.damaged-${stamp()}`
        await fs.copyFile(this.file, copy).catch(() => undefined)
        return { data: value, status: 'ok', issues, corruptCopy: copy }
      }
      return { data: value, status: 'ok', issues }
    } catch (err) {
      const corruptCopy = `${this.file}.corrupt-${stamp()}`
      await fs.copyFile(this.file, corruptCopy).catch(() => undefined)
      try {
        const backup = await fs.readFile(`${this.file}.bak`, 'utf8')
        const { value, issues } = this.parse(JSON.parse(stripBom(backup)))
        return { data: value, status: 'recovered', issues, corruptCopy }
      } catch {
        return {
          data: this.fallback(),
          status: 'reset',
          issues: [err instanceof Error ? err.message : String(err)],
          corruptCopy
        }
      }
    }
  }

  /** Ставит запись в очередь. Данные сериализуются сразу, поэтому их можно менять после вызова. */
  save(data: T): Promise<void> {
    const text = JSON.stringify(data, null, 2) + '\n'
    const job = this.queue.then(() => this.write(text))
    this.queue = job.catch(() => undefined)
    return job
  }

  /** Дождаться завершения всех поставленных в очередь записей. */
  async flush(): Promise<void> {
    await this.queue
  }

  private async write(text: string): Promise<void> {
    await fs.mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    const handle = await fs.open(tmp, 'w')
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await withRetry(() => fs.copyFile(this.file, `${this.file}.bak`))
    } catch (err) {
      if (errCode(err) !== 'ENOENT') throw err
    }
    await withRetry(() => fs.rename(tmp, this.file))
  }
}
