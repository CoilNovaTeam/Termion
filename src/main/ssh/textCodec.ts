// Кодировки текстовых файлов: UTF-8, UTF-8 с BOM и Windows-1251 (старые русские конфиги).
// Окончания строк (LF или CRLF) запоминаются и восстанавливаются при сохранении.

import type { EolId, TextEncodingId } from '@shared/types'

export class CodecError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodecError'
  }
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf])

export type Decoded = { binary: true } | { binary: false; text: string; encoding: TextEncodingId; eol: EolId }

/** Нулевые байты в начале файла — признак двоичного файла (архив, картинка, программа). */
export function looksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

export function detectEol(text: string): EolId {
  let crlf = 0
  let lf = 0
  for (let i = text.indexOf('\n'); i !== -1 && crlf + lf < 20_000; i = text.indexOf('\n', i + 1)) {
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++
    else lf++
  }
  return crlf > lf ? 'crlf' : 'lf'
}

/** Текст для редактора: строки всегда разделены «\n», исходный разделитель — в eol. */
export function decodeText(buf: Buffer): Decoded {
  if (looksBinary(buf)) return { binary: true }
  let encoding: TextEncodingId = 'utf8'
  let body = buf
  if (buf.length >= 3 && buf.subarray(0, 3).equals(BOM)) {
    encoding = 'utf8-bom'
    body = buf.subarray(3)
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    if (encoding === 'utf8-bom') {
      text = new TextDecoder('utf-8').decode(body)
    } else {
      text = new TextDecoder('windows-1251').decode(body)
      encoding = 'cp1251'
    }
  }
  const eol = detectEol(text)
  return { binary: false, text: text.replace(/\r\n/g, '\n'), encoding, eol }
}

let cp1251: Map<number, number> | null = null

function encodeCp1251(text: string): Buffer {
  if (!cp1251) {
    cp1251 = new Map()
    const decoder = new TextDecoder('windows-1251')
    for (let b = 0; b < 256; b++) {
      const ch = decoder.decode(Uint8Array.of(b))
      if (ch !== '�') cp1251.set(ch.codePointAt(0) as number, b)
    }
  }
  const out = Buffer.alloc(text.length)
  let i = 0
  for (const ch of text) {
    const b = cp1251.get(ch.codePointAt(0) as number)
    if (b === undefined) {
      throw new CodecError(`Символ «${ch}» нельзя записать в кодировке Windows-1251. Переключите кодировку файла на UTF-8.`)
    }
    out[i++] = b
  }
  return out.subarray(0, i)
}

export function encodeText(text: string, encoding: TextEncodingId, eol: EolId): Buffer {
  const body = eol === 'crlf' ? text.replace(/\r?\n/g, '\r\n') : text
  switch (encoding) {
    case 'utf8':
      return Buffer.from(body, 'utf8')
    case 'utf8-bom':
      return Buffer.concat([BOM, Buffer.from(body, 'utf8')])
    case 'cp1251':
      return encodeCp1251(body)
  }
}
