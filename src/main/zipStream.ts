// Потоковый ZIP без сжатия (метод «store»): данные идут прямо с сервера в архив, архив
// целиком в памяти не держится. Так перетаскиваются в Проводник папки и несколько
// объектов сразу — Windows не даёт программе «пообещать» папку, а один файл-архив — можно.
//
// Формат: имена в UTF-8 (флаг 11), CRC и размеры — в дескрипторе после данных (флаг 3),
// ZIP64 — для файлов от 4 ГБ, архивов больше 4 ГБ и больше 65 535 элементов.

import { crc32 } from 'node:zlib'

export interface ZipEntry {
  /** Путь внутри архива через «/», без «/» в начале и в конце. */
  name: string
  dir: boolean
  /** Время изменения, секунды Unix. */
  mtime: number
  /** Права в стиле Unix (сохраняются для распаковки в Linux и macOS). */
  mode: number
  /** Размер файла. Данных будет не больше — по нему же решается, нужен ли ZIP64. */
  size: number
  /** Содержимое файла (для папок не нужно). */
  data?: () => AsyncIterable<Buffer>
}

export interface ZipOptions {
  /** С какого размера файла включать ZIP64 (для тестов). */
  zip64Threshold?: number
}

const SIG_LOCAL = 0x04034b50
const SIG_DESCRIPTOR = 0x08074b50
const SIG_CENTRAL = 0x02014b50
const SIG_END = 0x06054b50
const SIG_END64 = 0x06064b50
const SIG_LOCATOR64 = 0x07064b50
const FLAG_DESCRIPTOR = 0x0008
const FLAG_UTF8 = 0x0800
const MAX16 = 0xffff
const MAX32 = 0xffffffff
/** Создан в Unix, формат 4.5 — тогда распаковщики берут права из старших 16 бит атрибутов. */
const MADE_BY = (3 << 8) | 45

interface Written {
  name: Buffer
  flags: number
  time: number
  date: number
  crc: number
  size: number
  offset: number
  dir: boolean
  mode: number
  big: boolean
}

/** Дата и время в формате MS-DOS (местное время, точность 2 секунды, годы 1980–2107). */
export function dosDateTime(seconds: number): { time: number; date: number } {
  const d = new Date((seconds > 0 ? seconds : Date.now() / 1000) * 1000)
  const year = d.getFullYear()
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 }
  if (year > 2107) return { time: (23 << 11) | (59 << 5) | 29, date: (127 << 9) | (12 << 5) | 31 }
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  }
}

/** Дополнительное поле ZIP64 (0x0001) с 8-байтовыми значениями. */
function zip64Extra(values: number[]): Buffer {
  const buf = Buffer.alloc(4 + values.length * 8)
  buf.writeUInt16LE(0x0001, 0)
  buf.writeUInt16LE(values.length * 8, 2)
  values.forEach((v, i) => buf.writeBigUInt64LE(BigInt(v), 4 + i * 8))
  return buf
}

function localHeader(name: Buffer, flags: number, time: number, date: number, big: boolean): Buffer {
  const extra = big ? zip64Extra([0, 0]) : Buffer.alloc(0)
  const h = Buffer.alloc(30)
  h.writeUInt32LE(SIG_LOCAL, 0)
  h.writeUInt16LE(big ? 45 : 20, 4)
  h.writeUInt16LE(flags, 6)
  h.writeUInt16LE(0, 8) // без сжатия
  h.writeUInt16LE(time, 10)
  h.writeUInt16LE(date, 12)
  h.writeUInt32LE(0, 14) // CRC — в дескрипторе
  h.writeUInt32LE(big ? MAX32 : 0, 18)
  h.writeUInt32LE(big ? MAX32 : 0, 22)
  h.writeUInt16LE(name.length, 26)
  h.writeUInt16LE(extra.length, 28)
  return Buffer.concat([h, name, extra])
}

function descriptor(crc: number, size: number, big: boolean): Buffer {
  const d = Buffer.alloc(big ? 24 : 16)
  d.writeUInt32LE(SIG_DESCRIPTOR, 0)
  d.writeUInt32LE(crc >>> 0, 4)
  if (big) {
    d.writeBigUInt64LE(BigInt(size), 8)
    d.writeBigUInt64LE(BigInt(size), 16)
  } else {
    d.writeUInt32LE(size, 8)
    d.writeUInt32LE(size, 12)
  }
  return d
}

function centralHeader(w: Written): Buffer {
  const sizeBig = w.big || w.size > MAX32
  const offsetBig = w.offset > MAX32
  const extraValues: number[] = []
  if (sizeBig) extraValues.push(w.size, w.size)
  if (offsetBig) extraValues.push(w.offset)
  const extra = extraValues.length ? zip64Extra(extraValues) : Buffer.alloc(0)
  const h = Buffer.alloc(46)
  h.writeUInt32LE(SIG_CENTRAL, 0)
  h.writeUInt16LE(MADE_BY, 4)
  h.writeUInt16LE(extraValues.length ? 45 : 20, 6)
  h.writeUInt16LE(w.flags, 8)
  h.writeUInt16LE(0, 10)
  h.writeUInt16LE(w.time, 12)
  h.writeUInt16LE(w.date, 14)
  h.writeUInt32LE(w.crc >>> 0, 16)
  h.writeUInt32LE(sizeBig ? MAX32 : w.size, 20)
  h.writeUInt32LE(sizeBig ? MAX32 : w.size, 24)
  h.writeUInt16LE(w.name.length, 28)
  h.writeUInt16LE(extra.length, 30)
  h.writeUInt16LE(0, 32) // комментарий
  h.writeUInt16LE(0, 34) // номер диска
  h.writeUInt16LE(0, 36) // внутренние атрибуты
  // Старшие 16 бит — права Unix, младшие — атрибуты DOS (0x10 — папка).
  const unixMode = (w.mode & 0o7777) | (w.dir ? 0o040000 : 0o100000)
  h.writeUInt32LE(((unixMode << 16) | (w.dir ? 0x10 : 0)) >>> 0, 38)
  h.writeUInt32LE(offsetBig ? MAX32 : w.offset, 42)
  return Buffer.concat([h, w.name, extra])
}

function end(entries: number, cdOffset: number, cdSize: number): Buffer[] {
  const need64 = entries > MAX16 - 1 || cdOffset > MAX32 - 1 || cdSize > MAX32 - 1
  const out: Buffer[] = []
  if (need64) {
    const end64Offset = cdOffset + cdSize
    const r = Buffer.alloc(56)
    r.writeUInt32LE(SIG_END64, 0)
    r.writeBigUInt64LE(44n, 4)
    r.writeUInt16LE(MADE_BY, 12)
    r.writeUInt16LE(45, 14)
    r.writeUInt32LE(0, 16)
    r.writeUInt32LE(0, 20)
    r.writeBigUInt64LE(BigInt(entries), 24)
    r.writeBigUInt64LE(BigInt(entries), 32)
    r.writeBigUInt64LE(BigInt(cdSize), 40)
    r.writeBigUInt64LE(BigInt(cdOffset), 48)
    const l = Buffer.alloc(20)
    l.writeUInt32LE(SIG_LOCATOR64, 0)
    l.writeUInt32LE(0, 4)
    l.writeBigUInt64LE(BigInt(end64Offset), 8)
    l.writeUInt32LE(1, 16)
    out.push(r, l)
  }
  const e = Buffer.alloc(22)
  e.writeUInt32LE(SIG_END, 0)
  e.writeUInt16LE(0, 4)
  e.writeUInt16LE(0, 6)
  e.writeUInt16LE(need64 ? MAX16 : entries, 8)
  e.writeUInt16LE(need64 ? MAX16 : entries, 10)
  e.writeUInt32LE(need64 ? MAX32 : cdSize, 12)
  e.writeUInt32LE(need64 ? MAX32 : cdOffset, 16)
  e.writeUInt16LE(0, 20)
  out.push(e)
  return out
}

/** Архив по списку элементов. Генератор: следующий кусок строится, только когда его попросят. */
export async function* zipStream(entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>, options: ZipOptions = {}): AsyncGenerator<Buffer> {
  const threshold = options.zip64Threshold ?? MAX32
  const written: Written[] = []
  let offset = 0
  const emit = (buf: Buffer): Buffer => {
    offset += buf.length
    return buf
  }

  for await (const entry of entries) {
    const name = Buffer.from(entry.dir ? `${entry.name}/` : entry.name, 'utf8')
    if (name.length > MAX16) throw new Error(`Слишком длинное имя в архиве: ${entry.name.slice(0, 60)}…`)
    const { time, date } = dosDateTime(entry.mtime)
    const big = !entry.dir && entry.size >= threshold
    const flags = FLAG_UTF8 | (entry.dir ? 0 : FLAG_DESCRIPTOR)
    const start = offset
    yield emit(localHeader(name, flags, time, date, big))

    let crc = 0
    let size = 0
    if (!entry.dir) {
      if (entry.data) {
        for await (const chunk of entry.data()) {
          if (!chunk.length) continue
          size += chunk.length
          if (size > entry.size) throw new Error(`Файл ${entry.name} оказался больше ожидаемого.`)
          crc = crc32(chunk, crc)
          yield emit(chunk)
        }
      }
      yield emit(descriptor(crc, size, big))
    }
    written.push({ name, flags, time, date, crc, size, offset: start, dir: entry.dir, mode: entry.mode, big })
  }

  const cdOffset = offset
  for (const w of written) yield emit(centralHeader(w))
  const cdSize = offset - cdOffset
  for (const buf of end(written.length, cdOffset, cdSize)) yield emit(buf)
}
