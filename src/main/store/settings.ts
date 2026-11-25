import { join } from 'node:path'
import type { Settings } from '@shared/types'
import { DEFAULT_SETTINGS, normalizeSettings } from '@shared/validate'
import { JsonFile, type LoadResult } from './jsonFile'

export class SettingsStore {
  private readonly file: JsonFile<Settings>
  private current: Settings = structuredClone(DEFAULT_SETTINGS)

  constructor(dir: string) {
    this.file = new JsonFile<Settings>(
      join(dir, 'settings.json'),
      (raw) => ({ value: normalizeSettings(raw), issues: [] }),
      () => structuredClone(DEFAULT_SETTINGS)
    )
  }

  async load(): Promise<LoadResult<Settings>> {
    const result = await this.file.load()
    this.current = result.data
    return result
  }

  get(): Settings {
    return this.current
  }

  async save(raw: unknown): Promise<Settings> {
    this.current = normalizeSettings(raw)
    await this.file.save(this.current)
    return this.current
  }

  flush(): Promise<void> {
    return this.file.flush()
  }
}
