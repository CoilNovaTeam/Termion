// Тесты файлов на сервере (SFTP) и передач — на настоящем SSH/SFTP-сервере ssh2 поверх временной папки.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, type SFTPWrapper } from 'ssh2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TransferJob } from '../src/shared/types'
import { RemoteFs } from '../src/main/ssh/remoteFs'
import { decodeText, encodeText } from '../src/main/ssh/textCodec'
import { TransferManager, safeLocalName } from '../src/main/ssh/transfers'
import { TEST_HOME, TEST_USER, startTestServer, type TestServer } from './helpers/sshServer'

const PASSWORD = 'sftp-secret'
const CP1251_PRIVET = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]) // «Привет» в Windows-1251

const dirs: string[] = []
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

function connect(port: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c = new Client()
    c.on('ready', () => resolve(c))
      .on('error', reject)
      .connect({ host: '127.0.0.1', port, username: TEST_USER, password: PASSWORD, readyTimeout: 5000 })
  })
}

/** Включить расширения OpenSSH на стороне клиента (сервер ssh2 их обрабатывает, но не объявляет). */
async function enableOpenSshExtensions(fs: RemoteFs): Promise<SFTPWrapper> {
  const sftp = await fs.channel()
  const ext = (sftp as unknown as { _extensions: Record<string, string> })._extensions
  ext['posix-rename@openssh.com'] = '1'
  ext['fsync@openssh.com'] = '1'
  return sftp
}

let root: string
let server: TestServer
let client: Client
let fs: RemoteFs
const home = (name: string) => `${TEST_HOME}/${name}`
const real = (name: string) => server.real(home(name))

beforeAll(async () => {
  root = temp('termion-sftp-')
  server = await startTestServer({ password: PASSWORD, sftpRoot: root, ownerOf: (p) => (p.endsWith('.owned') ? 1000 : 0), denyChown: true })
  mkdirSync(real('app/src'), { recursive: true })
  writeFileSync(real('app/src/main.py'), 'print("hi")\n')
  writeFileSync(real('app/README.md'), '# app\n')
  writeFileSync(real('notes.txt'), 'Привет\nмир\n')
  writeFileSync(real('win.txt'), 'one\r\ntwo\r\n')
  writeFileSync(real('legacy.conf'), Buffer.concat([CP1251_PRIVET, Buffer.from('\n')]))
  writeFileSync(real('image.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]))
  writeFileSync(real('.env'), 'KEY=value\n')
  writeFileSync(real('file10.txt'), '10')
  writeFileSync(real('file2.txt'), '2')
  writeFileSync(real('config.owned'), 'owner=1000\n')
  client = await connect(server.port)
  fs = new RemoteFs(client)
})

afterAll(async () => {
  fs.dispose()
  client.end()
  await server.close()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

describe('кодировки', () => {
  it('UTF-8, UTF-8 с BOM, Windows-1251 и двоичные файлы', () => {
    expect(decodeText(Buffer.from('a\r\nb\r\n'))).toEqual({ binary: false, text: 'a\nb\n', encoding: 'utf8', eol: 'crlf' })
    expect(decodeText(Buffer.from('﻿привет'))).toMatchObject({ encoding: 'utf8-bom', text: 'привет' })
    expect(decodeText(CP1251_PRIVET)).toMatchObject({ encoding: 'cp1251', text: 'Привет' })
    expect(decodeText(Buffer.from([1, 0, 2]))).toEqual({ binary: true })
    expect(encodeText('Привет\n', 'cp1251', 'crlf')).toEqual(Buffer.concat([CP1251_PRIVET, Buffer.from('\r\n')]))
    expect(encodeText('x', 'utf8-bom', 'lf')).toEqual(Buffer.from([0xef, 0xbb, 0xbf, 0x78]))
    expect(() => encodeText('emoji 😀', 'cp1251', 'lf')).toThrow(/Windows-1251/)
  })

  it('имена файлов с сервера становятся безопасными для Windows', () => {
    expect(safeLocalName('a:b*c?.txt')).toBe('a_b_c_.txt')
    expect(safeLocalName('..')).toBe('_')
    expect(safeLocalName('..\\..\\evil')).toBe('.._.._evil')
    expect(safeLocalName('CON')).toBe('_CON')
    expect(safeLocalName('nul.txt')).toBe('_nul.txt')
    expect(safeLocalName('trailing. ')).toBe('trailing')
    expect(safeLocalName('обычный файл.log')).toBe('обычный файл.log')
  })
})

describe('RemoteFs', () => {
  it('домашняя папка и список: папки сверху, естественная сортировка, скрытые файлы', async () => {
    expect(await fs.home()).toBe(TEST_HOME)
    const list = await fs.list(TEST_HOME)
    const names = list.map((e) => e.name)
    expect(names[0]).toBe('app')
    expect(list[0].type).toBe('dir')
    expect(names).toContain('.env')
    expect(names.indexOf('file2.txt')).toBeLessThan(names.indexOf('file10.txt'))
    expect(list.find((e) => e.name === 'notes.txt')).toMatchObject({ type: 'file', path: home('notes.txt') })
  })

  it('читает текст в разных кодировках и отказывается от двоичных и огромных файлов', async () => {
    expect(await fs.readText(home('notes.txt'))).toMatchObject({ ok: true, text: 'Привет\nмир\n', encoding: 'utf8', eol: 'lf' })
    expect(await fs.readText(home('win.txt'))).toMatchObject({ ok: true, text: 'one\ntwo\n', eol: 'crlf' })
    expect(await fs.readText(home('legacy.conf'))).toMatchObject({ ok: true, text: 'Привет\n', encoding: 'cp1251' })
    expect(await fs.readText(home('image.bin'))).toEqual({ ok: false, reason: 'binary', size: 8 })
    expect(await fs.readText(home('notes.txt'), 4)).toMatchObject({ ok: false, reason: 'too-large' })
    await expect(fs.readText(home('nope.txt'))).rejects.toThrow(/Нет такого файла/)
  })

  it('читает и пишет большой файл параллельными блоками без искажений', async () => {
    const big = Buffer.alloc(1_500_000)
    for (let i = 0; i < big.length; i++) big[i] = 32 + (i % 90)
    writeFileSync(real('big.txt'), big)
    const read = await fs.readText(home('big.txt'))
    expect(read.ok && read.text.length).toBe(big.length)
    if (!read.ok) return
    const res = await fs.writeText(home('big.txt'), read.text.toUpperCase(), 'utf8', 'lf', read.meta, false)
    expect(res.ok).toBe(true)
    expect(readFileSync(real('big.txt'), 'utf8')).toBe(big.toString('utf8').toUpperCase())
  })

  it('сохраняет, сохраняя окончания строк и кодировку', async () => {
    const win = await fs.readText(home('win.txt'))
    if (!win.ok) throw new Error('не прочитан')
    await fs.writeText(home('win.txt'), win.text + 'three\n', win.encoding, win.eol, win.meta, false)
    expect(readFileSync(real('win.txt'), 'utf8')).toBe('one\r\ntwo\r\nthree\r\n')

    const legacy = await fs.readText(home('legacy.conf'))
    if (!legacy.ok) throw new Error('не прочитан')
    await fs.writeText(home('legacy.conf'), legacy.text, legacy.encoding, legacy.eol, legacy.meta, false)
    expect(readFileSync(real('legacy.conf'))).toEqual(Buffer.concat([CP1251_PRIVET, Buffer.from('\n')]))
  })

  it('обнаруживает, что файл изменили или удалили на сервере после открытия', async () => {
    writeFileSync(real('shared.txt'), 'v1\n')
    const opened = await fs.readText(home('shared.txt'))
    if (!opened.ok) throw new Error('не прочитан')
    writeFileSync(real('shared.txt'), 'changed by someone else\n')
    expect(await fs.writeText(home('shared.txt'), 'mine\n', 'utf8', 'lf', opened.meta, false)).toEqual({ ok: false, conflict: 'changed' })
    expect(readFileSync(real('shared.txt'), 'utf8')).toBe('changed by someone else\n')
    expect(await fs.writeText(home('shared.txt'), 'mine\n', 'utf8', 'lf', opened.meta, true)).toMatchObject({ ok: true })
    expect(readFileSync(real('shared.txt'), 'utf8')).toBe('mine\n')

    rmSync(real('shared.txt'))
    expect(await fs.writeText(home('shared.txt'), 'again\n', 'utf8', 'lf', opened.meta, false)).toEqual({ ok: false, conflict: 'deleted' })
  })

  it('без расширений OpenSSH пишет файл напрямую', async () => {
    const opened = await fs.readText(home('notes.txt'))
    if (!opened.ok) throw new Error('не прочитан')
    const res = await fs.writeText(home('notes.txt'), 'Привет, мир!\n', 'utf8', 'lf', opened.meta, false)
    expect(res).toMatchObject({ ok: true, atomic: false })
    expect(readFileSync(real('notes.txt'), 'utf8')).toBe('Привет, мир!\n')
  })

  it('с расширениями OpenSSH сохраняет атомарно и не оставляет временных файлов', async () => {
    const own = new RemoteFs(client)
    try {
      await enableOpenSshExtensions(own)
      writeFileSync(real('atomic.txt'), 'before\n')
      const opened = await own.readText(home('atomic.txt'))
      if (!opened.ok) throw new Error('не прочитан')
      const res = await own.writeText(home('atomic.txt'), 'after\n', 'utf8', 'lf', opened.meta, false)
      expect(res).toMatchObject({ ok: true, atomic: true })
      expect(readFileSync(real('atomic.txt'), 'utf8')).toBe('after\n')
      expect(readdirSync(real('.')).filter((n) => n.includes('.termion-'))).toEqual([])
    } finally {
      own.dispose()
    }
  })

  it('не меняет владельца файла: если вернуть владельца нельзя, пишет напрямую', async () => {
    const own = new RemoteFs(client)
    try {
      await enableOpenSshExtensions(own)
      const opened = await own.readText(home('config.owned'))
      if (!opened.ok) throw new Error('не прочитан')
      const res = await own.writeText(home('config.owned'), 'owner=1000\nedited=yes\n', 'utf8', 'lf', opened.meta, false)
      expect(res).toMatchObject({ ok: true, atomic: false })
      expect(readFileSync(real('config.owned'), 'utf8')).toBe('owner=1000\nedited=yes\n')
      const entry = (await own.list(TEST_HOME)).find((e) => e.name === 'config.owned')
      expect(entry).toBeTruthy()
      expect(readdirSync(real('.')).filter((n) => n.includes('.termion-'))).toEqual([])
    } finally {
      own.dispose()
    }
  })

  it('создаёт, переименовывает и удаляет; защищает системные и домашнюю папки', async () => {
    await fs.createFile(home('new.txt'))
    await expect(fs.createFile(home('new.txt'))).rejects.toThrow(/уже существует/)
    await fs.mkdir(home('folder'))
    await expect(fs.mkdir(home('folder'))).rejects.toThrow(/уже существует/)
    await fs.rename(home('new.txt'), home('folder/moved.txt'))
    expect(existsSync(real('folder/moved.txt'))).toBe(true)
    writeFileSync(real('other.txt'), 'x')
    await expect(fs.rename(home('other.txt'), home('folder/moved.txt'))).rejects.toThrow(/уже существует/)

    mkdirSync(real('folder/deep/deeper'), { recursive: true })
    writeFileSync(real('folder/deep/deeper/file.txt'), 'x')
    await fs.remove(home('folder'))
    expect(existsSync(real('folder'))).toBe(false)

    await expect(fs.remove('/')).rejects.toThrow(/нельзя/)
    await expect(fs.remove('/etc')).rejects.toThrow(/нельзя/)
    await expect(fs.remove(TEST_HOME)).rejects.toThrow(/нельзя/)
  })
})

describe('передача файлов', () => {
  const run = (start: (t: TransferManager, jobs: Map<string, TransferJob>) => string) =>
    new Promise<TransferJob>((resolve) => {
      const jobs = new Map<string, TransferJob>()
      let id = ''
      const transfers = new TransferManager('c1', fs, (job) => {
        jobs.set(job.id, job)
        if (job.id === id && ['done', 'failed', 'cancelled'].includes(job.state)) resolve(job)
      })
      id = start(transfers, jobs)
    })

  it('скачивает папку целиком', async () => {
    const local = temp('termion-dl-')
    const job = await run((t) => t.startDownload({ remotePaths: [home('app')], localDir: local, overwrite: true }))
    expect(job).toMatchObject({ state: 'done', totalFiles: 2, doneFiles: 2 })
    expect(readFileSync(join(local, 'app', 'src', 'main.py'), 'utf8')).toBe('print("hi")\n')
    expect(readFileSync(join(local, 'app', 'README.md'), 'utf8')).toBe('# app\n')
  })

  it('загружает папку на сервер и пропускает существующие файлы по выбору пользователя', async () => {
    const local = temp('termion-ul-')
    mkdirSync(join(local, 'site', 'css'), { recursive: true })
    writeFileSync(join(local, 'site', 'index.html'), '<h1>hi</h1>')
    writeFileSync(join(local, 'site', 'css', 'app.css'), 'body{}')
    writeFileSync(join(local, 'notes.txt'), 'local version')

    const job = await run((t) =>
      t.startUpload({ localPaths: [join(local, 'site'), join(local, 'notes.txt')], remoteDir: TEST_HOME, overwrite: false })
    )
    expect(job).toMatchObject({ state: 'done', doneFiles: 2, skipped: 1, remoteDir: TEST_HOME })
    expect(readFileSync(real('site/css/app.css'), 'utf8')).toBe('body{}')
    expect(readFileSync(real('notes.txt'), 'utf8')).not.toBe('local version')
    expect(readdirSync(real('site')).filter((n) => n.includes('.termion-'))).toEqual([])
  })

  it('отмена оставляет всё как было: без недокачанных файлов', async () => {
    writeFileSync(real('huge.bin'), Buffer.alloc(40 * 1024 * 1024, 7))
    const local = temp('termion-cancel-')
    const job = await run((t, jobs) => {
      const id = t.startDownload({ remotePaths: [home('huge.bin')], localDir: local, singleTarget: join(local, 'huge.bin'), overwrite: true })
      const timer = setInterval(() => {
        if ((jobs.get(id)?.doneBytes ?? 0) > 0) {
          clearInterval(timer)
          t.cancel(id)
        }
      }, 5)
      return id
    })
    expect(job.state).toBe('cancelled')
    // «Отменено» показывается сразу, уборка временного файла завершается следом — быстро.
    const start = Date.now()
    while (readdirSync(local).length && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 20))
    expect(readdirSync(local)).toEqual([])
  })
})

describe('большие папки и обрыв канала', () => {
  it('папка на 3000 файлов читается порциями целиком', async () => {
    mkdirSync(real('many'))
    for (let i = 0; i < 3000; i++) writeFileSync(join(real('many'), `f${i}.log`), '')
    const list = await fs.list(home('many'))
    expect(list).toHaveLength(3000)
    expect(list[0].name).toBe('f0.log')
    expect(list[2999].name).toBe('f2999.log') // естественная сортировка
  })

  it('если канал SFTP оборвался, операция завершается ошибкой, а не ждёт вечно', async () => {
    // Сервер, который отдаёт весь список одним пакетом больше допустимого (ssh2 рвёт канал).
    const broken = await startTestServer({ password: PASSWORD, sftpRoot: temp('termion-sftp-big-'), readdirBatch: Infinity })
    mkdirSync(broken.real(`${TEST_HOME}/huge`), { recursive: true })
    for (let i = 0; i < 5000; i++) writeFileSync(join(broken.real(`${TEST_HOME}/huge`), `file-${i}.log`), '')
    const c = await connect(broken.port)
    const bfs = new RemoteFs(c)
    try {
      const started = Date.now()
      await expect(bfs.list(`${TEST_HOME}/huge`)).rejects.toThrow(/SFTP прервалась/)
      expect(Date.now() - started).toBeLessThan(5000)
      // Следующая операция открывает новый канал и работает.
      expect((await bfs.list(TEST_HOME)).map((e) => e.name)).toContain('huge')
    } finally {
      bfs.dispose()
      c.end()
      await broken.close()
    }
  })
})
