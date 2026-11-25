// Перетаскивание в Проводник: потоковый ZIP и выдача файлов по ссылке termion-dl.
// ZIP проверяется своим разбором и настоящими распаковщиками Windows (tar, Expand-Archive
// и движок архивов самого Проводника) — именно ими пользователь откроет архив.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { Client } from 'ssh2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TransferJob } from '../src/shared/types'
import { DragOutService } from '../src/main/ssh/dragOut'
import { RemoteFs } from '../src/main/ssh/remoteFs'
import { TransferManager } from '../src/main/ssh/transfers'
import { zipStream, type ZipEntry } from '../src/main/zipStream'
import { TEST_HOME, TEST_USER, startTestServer, type TestServer } from './helpers/sshServer'

const PASSWORD = 'drag-secret'
const isWindows = process.platform === 'win32'
const dirs: string[] = []
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const c of chunks) parts.push(Buffer.from(c))
  return Buffer.concat(parts)
}

interface Parsed {
  name: string
  dir: boolean
  data: Buffer
}

/** Свой разбор ZIP по центральному каталогу (с ZIP64) — с проверкой CRC каждого файла. */
function parseZip(zip: Buffer): Parsed[] {
  let eocd = zip.length - 22
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--
  if (eocd < 0) throw new Error('нет конца центрального каталога')
  let count = zip.readUInt16LE(eocd + 10)
  let cdOffset = zip.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20
    expect(zip.readUInt32LE(locator)).toBe(0x07064b50)
    const end64 = Number(zip.readBigUInt64LE(locator + 8))
    expect(zip.readUInt32LE(end64)).toBe(0x06064b50)
    count = Number(zip.readBigUInt64LE(end64 + 32))
    cdOffset = Number(zip.readBigUInt64LE(end64 + 48))
  }
  const out: Parsed[] = []
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(p)).toBe(0x02014b50)
    const flags = zip.readUInt16LE(p + 8)
    expect(flags & 0x0800).toBe(0x0800) // имена в UTF-8
    const crc = zip.readUInt32LE(p + 16)
    let size = zip.readUInt32LE(p + 24)
    const nameLen = zip.readUInt16LE(p + 28)
    const extraLen = zip.readUInt16LE(p + 30)
    const commentLen = zip.readUInt16LE(p + 32)
    let offset = zip.readUInt32LE(p + 42)
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    const extra = zip.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen)
    if (extra.length >= 4 && extra.readUInt16LE(0) === 0x0001) {
      let q = 4
      if (size === 0xffffffff) {
        size = Number(extra.readBigUInt64LE(q))
        q += 16 // исходный и сжатый размеры
      }
      if (offset === 0xffffffff) offset = Number(extra.readBigUInt64LE(q))
    }
    expect(zip.readUInt32LE(offset)).toBe(0x04034b50)
    const dataStart = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28)
    const data = zip.subarray(dataStart, dataStart + size)
    if (!name.endsWith('/')) expect(crc32(data) >>> 0).toBe(crc)
    out.push({ name: name.replace(/\/$/, ''), dir: name.endsWith('/'), data })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

const sample = (): ZipEntry[] => {
  const big = Buffer.alloc(300 * 1024)
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 251
  const file = (name: string, data: Buffer): ZipEntry => ({
    name,
    dir: false,
    mtime: 1_764_000_000,
    mode: 0o100644,
    size: data.length,
    data: async function* () {
      for (let i = 0; i < data.length; i += 7000) yield data.subarray(i, i + 7000)
    }
  })
  return [
    { name: 'сайт', dir: true, mtime: 1_764_000_000, mode: 0o040755, size: 0 },
    file('сайт/index.html', Buffer.from('<h1>Привет</h1>\n')),
    file('сайт/пустой.txt', Buffer.alloc(0)),
    { name: 'сайт/logs', dir: true, mtime: 1_764_000_000, mode: 0o040755, size: 0 },
    file('сайт/logs/big.bin', big),
    file('readme.md', Buffer.from('# ok\n'))
  ]
}

describe('потоковый ZIP', () => {
  it('структура, CRC и имена в UTF-8 — по своему разбору', async () => {
    const zip = await collect(zipStream(sample()))
    const parsed = parseZip(zip)
    expect(parsed.map((e) => e.name)).toEqual(['сайт', 'сайт/index.html', 'сайт/пустой.txt', 'сайт/logs', 'сайт/logs/big.bin', 'readme.md'])
    expect(parsed[1].data.toString()).toBe('<h1>Привет</h1>\n')
    expect(parsed[4].data.length).toBe(300 * 1024)
  })

  it('ZIP64 (файлы «больше 4 ГБ» — порог снижен для теста)', async () => {
    const zip = await collect(zipStream(sample(), { zip64Threshold: 1 }))
    const parsed = parseZip(zip)
    expect(parsed.find((e) => e.name === 'сайт/logs/big.bin')?.data.length).toBe(300 * 1024)
  })

  it('файл не может оказаться больше заявленного', async () => {
    const entries: ZipEntry[] = [
      { name: 'a', dir: false, mtime: 0, mode: 0o644, size: 2, data: async function* () { yield Buffer.from('abc') } }
    ]
    await expect(collect(zipStream(entries))).rejects.toThrow(/больше ожидаемого/)
  })

  describe.skipIf(!isWindows)('распаковка средствами Windows', () => {
    const check = (outDir: string) => {
      expect(readFileSync(join(outDir, 'сайт', 'index.html'), 'utf8')).toBe('<h1>Привет</h1>\n')
      expect(readFileSync(join(outDir, 'сайт', 'пустой.txt')).length).toBe(0)
      expect(readFileSync(join(outDir, 'сайт', 'logs', 'big.bin')).length).toBe(300 * 1024)
      expect(readFileSync(join(outDir, 'readme.md'), 'utf8')).toBe('# ok\n')
    }

    for (const [label, threshold] of [
      ['обычный', undefined],
      ['ZIP64', 1]
    ] as const) {
      it(`${label}: tar и Expand-Archive`, async () => {
        const dir = temp('termion-zip-')
        const zipPath = join(dir, 'archive.zip')
        writeFileSync(zipPath, await collect(zipStream(sample(), { zip64Threshold: threshold })))
        const byTar = join(dir, 'tar')
        mkdirSync(byTar)
        execFileSync('C:\\Windows\\System32\\tar.exe', ['-xf', zipPath, '-C', byTar])
        check(byTar)
        const byPs = join(dir, 'ps')
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${byPs}'`])
        check(byPs)
      }, 60_000)
    }

    it('архив открывается Проводником (его движком ZIP): имена на русском читаются', async () => {
      const dir = temp('termion-zip-shell-')
      const zipPath = join(dir, 'archive.zip')
      writeFileSync(zipPath, await collect(zipStream(sample())))
      const script = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        '$shell = New-Object -ComObject Shell.Application',
        `$zip = $shell.NameSpace('${zipPath}')`,
        '$names = @(); foreach ($i in $zip.Items()) { $names += $i.Name }',
        "$site = $zip.Items() | Where-Object { $_.IsFolder } | Select-Object -First 1",
        'foreach ($i in $site.GetFolder.Items()) { $names += ($site.Name + "/" + $i.Name) }',
        '$names -join "|"'
      ].join('; ')
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim()
      const names = out.split('|').map((n) => n.replace(/\.(html|txt|md)$/, (m) => m)) // Проводник может скрывать расширения
      expect(names.some((n) => n.startsWith('сайт'))).toBe(true)
      expect(names.some((n) => n.startsWith('сайт/пустой'))).toBe(true)
      expect(names.some((n) => n.startsWith('readme'))).toBe(true)
    }, 60_000)
  })
})

describe('выдача файлов для Проводника', () => {
  let server: TestServer
  let client: Client
  let fs: RemoteFs
  let transfers: TransferManager
  const jobs: TransferJob[] = []
  let service: DragOutService

  beforeAll(async () => {
    server = await startTestServer({ password: PASSWORD, sftpRoot: temp('termion-dragout-') })
    const real = (p: string) => server.real(`${TEST_HOME}/${p}`)
    mkdirSync(real('site/css'), { recursive: true })
    writeFileSync(real('site/index.html'), '<h1>Привет</h1>\n')
    writeFileSync(real('site/css/style.css'), 'body{}\n')
    const big = Buffer.alloc(1024 * 1024 + 123)
    for (let i = 0; i < big.length; i++) big[i] = (i * 7) % 256
    writeFileSync(real('backup.bin'), big)
    writeFileSync(real('notes.txt'), 'заметки\n')
    client = await new Promise<Client>((resolve, reject) => {
      const c = new Client()
      c.on('ready', () => resolve(c))
        .on('error', reject)
        .connect({ host: '127.0.0.1', port: server.port, username: TEST_USER, password: PASSWORD, readyTimeout: 5000 })
    })
    fs = new RemoteFs(client)
    transfers = new TransferManager('c1', fs, (job) => jobs.push(job))
    service = new DragOutService({
      resolve: (owner, connId) => {
        if (owner !== 1 || connId !== 'c1') throw new Error('нет подключения')
        return { fs, transfers }
      }
    })
  })

  afterAll(async () => {
    fs.dispose()
    client.end()
    await server.close()
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  const fetchToken = async (token: string) => {
    const res = await service.handle({ url: `termion-dl://get/${token}/x` } as Request)
    return { res, body: res.body ? await collect(res.body as unknown as AsyncIterable<Uint8Array>) : Buffer.alloc(0) }
  }

  it('один файл отдаётся как есть, передача видна в списке', async () => {
    service.register(1, 'tok-file-0000000001', 'c1', [`${TEST_HOME}/backup.bin`], 'backup.bin')
    const { res, body } = await fetchToken('tok-file-0000000001')
    expect(res.status).toBe(200)
    expect(body.equals(readFileSync(server.real(`${TEST_HOME}/backup.bin`)))).toBe(true)
    const last = jobs.filter((j) => j.title === 'backup.bin').pop()
    expect(last).toMatchObject({ state: 'done', dragOut: true, doneBytes: 1024 * 1024 + 123 })
  })

  it('папка и несколько объектов — одним zip-архивом', async () => {
    service.register(1, 'tok-zip-00000000001', 'c1', [`${TEST_HOME}/site`, `${TEST_HOME}/notes.txt`], 'tester.zip')
    const { res, body } = await fetchToken('tok-zip-00000000001')
    expect(res.headers.get('content-type')).toBe('application/zip')
    const parsed = parseZip(body)
    expect(parsed.map((e) => e.name)).toEqual(['site', 'site/css', 'site/css/style.css', 'site/index.html', 'notes.txt'])
    expect(parsed.find((e) => e.name === 'site/index.html')?.data.toString()).toBe('<h1>Привет</h1>\n')
    expect(jobs.filter((j) => j.title === 'tester.zip').pop()).toMatchObject({ state: 'done', totalFiles: 3, doneFiles: 3 })
  })

  it('чужая или неизвестная ссылка — отказ', async () => {
    expect(() => service.register(2, 'tok-alien-000000001', 'c1', [`${TEST_HOME}/notes.txt`], 'n')).toThrow()
    const { res } = await fetchToken('tok-unknown-00000001')
    expect(res.status).toBe(404)
  })

  it('отмена из списка передач обрывает поток', async () => {
    service.register(1, 'tok-cancel-00000001', 'c1', [`${TEST_HOME}/backup.bin`], 'cancel.bin')
    const res = await service.handle({ url: 'termion-dl://get/tok-cancel-00000001/x' } as Request)
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    await reader.read() // поток пошёл
    const job = jobs.filter((j) => j.title === 'cancel.bin').pop() as TransferJob
    transfers.cancel(job.id)
    await expect(
      (async () => {
        for (;;) {
          const { done } = await reader.read()
          if (done) break
        }
      })()
    ).rejects.toThrow(/отменена/)
    expect(jobs.filter((j) => j.title === 'cancel.bin').pop()?.state).toBe('cancelled')
    expect(existsSync(server.real(`${TEST_HOME}/backup.bin`))).toBe(true) // на сервере ничего не тронуто
  })
})
