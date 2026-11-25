import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonFile } from '../src/main/store/jsonFile'

interface Data {
  items: number[]
}

const parse = (raw: unknown) => {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as Data).items)) throw new Error('bad')
  return { value: raw as Data, issues: [] }
}

const dirs: string[] = []
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'termion-json-'))
  dirs.push(dir)
  return join(dir, 'data.json')
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('JsonFile', () => {
  it('нет файла — значения по умолчанию', async () => {
    const file = new JsonFile<Data>(tempFile(), parse, () => ({ items: [] }))
    expect(await file.load()).toMatchObject({ status: 'missing', data: { items: [] } })
  })

  it('сохраняет и читает, оставляя резервную копию предыдущей версии', async () => {
    const path = tempFile()
    const file = new JsonFile<Data>(path, parse, () => ({ items: [] }))
    await file.save({ items: [1] })
    await file.save({ items: [1, 2] })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ items: [1, 2] })
    expect(JSON.parse(readFileSync(`${path}.bak`, 'utf8'))).toEqual({ items: [1] })
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })

  it('параллельные сохранения выполняются по очереди, побеждает последнее', async () => {
    const path = tempFile()
    const file = new JsonFile<Data>(path, parse, () => ({ items: [] }))
    await Promise.all(Array.from({ length: 25 }, (_, i) => file.save({ items: [i] })))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ items: [24] })
  })

  it('данные сериализуются в момент вызова save', async () => {
    const path = tempFile()
    const file = new JsonFile<Data>(path, parse, () => ({ items: [] }))
    const data = { items: [1] }
    const job = file.save(data)
    data.items.push(2)
    await job
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ items: [1] })
  })

  it('повреждённый файл: восстановление из .bak и копия повреждённой версии', async () => {
    const path = tempFile()
    const file = new JsonFile<Data>(path, parse, () => ({ items: [] }))
    await file.save({ items: [7] })
    await file.save({ items: [8] })
    writeFileSync(path, '{ "items": [8, ', 'utf8') // обрыв записи
    const result = await file.load()
    expect(result.status).toBe('recovered')
    expect(result.data).toEqual({ items: [7] })
    expect(result.corruptCopy && existsSync(result.corruptCopy)).toBe(true)
  })

  it('повреждён и файл, и копия — пустые данные, файл не удаляется', async () => {
    const path = tempFile()
    writeFileSync(path, 'not json', 'utf8')
    const file = new JsonFile<Data>(path, parse, () => ({ items: [] }))
    const result = await file.load()
    expect(result.status).toBe('reset')
    expect(readdirSync(join(path, '..')).some((n) => n.startsWith('data.json.corrupt-'))).toBe(true)
  })

  it('читает файл с BOM', async () => {
    const path = tempFile()
    writeFileSync(path, '﻿{"items":[3]}', 'utf8')
    const file = new JsonFile<Data>(path, parse, () => ({ items: [] }))
    expect((await file.load()).data).toEqual({ items: [3] })
  })
})
