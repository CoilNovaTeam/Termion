import { join } from 'node:path'
import type { Macro } from '@shared/types'
import { checkMacros } from '@shared/validate'
import { JsonFile, type LoadResult } from './jsonFile'

interface MacrosData {
  version: 1
  macros: Macro[]
}

const empty = (): MacrosData => ({ version: 1, macros: [] })

/** Макросы в macros.json: та же атомарная запись с резервной копией, что и у сессий. */
export class MacrosStore {
  private readonly file: JsonFile<MacrosData>
  private data: MacrosData = empty()

  constructor(dir: string) {
    this.file = new JsonFile<MacrosData>(
      join(dir, 'macros.json'),
      (raw) => {
        const list = typeof raw === 'object' && raw !== null ? (raw as { macros?: unknown }).macros : undefined
        if (list === undefined) throw new Error('В файле нет списка макросов')
        const { macros, dropped } = checkMacros(list, false)
        return { value: { version: 1, macros }, issues: dropped }
      },
      empty
    )
  }

  async load(): Promise<LoadResult<MacrosData>> {
    const result = await this.file.load()
    this.data = result.data
    return result
  }

  get list(): Macro[] {
    return this.data.macros
  }

  /** Список должен быть уже проверен (checkMacros в строгом режиме). */
  async save(macros: Macro[]): Promise<void> {
    this.data = { version: 1, macros }
    await this.file.save(this.data)
  }

  flush(): Promise<void> {
    return this.file.flush()
  }
}
