import { join } from 'node:path'
import type { SessionNode, TreeNode } from '@shared/types'
import { checkTree } from '@shared/validate'
import { findSession } from '@shared/tree'
import { JsonFile, type LoadResult } from './jsonFile'

interface SessionsData {
  version: 1
  tree: TreeNode[]
}

const empty = (): SessionsData => ({ version: 1, tree: [] })

export class SessionsStore {
  private readonly file: JsonFile<SessionsData>
  private data: SessionsData = empty()

  constructor(dir: string) {
    this.file = new JsonFile<SessionsData>(
      join(dir, 'sessions.json'),
      (raw) => {
        const treeRaw = Array.isArray(raw) ? raw : typeof raw === 'object' && raw !== null ? (raw as { tree?: unknown }).tree : undefined
        if (treeRaw === undefined) throw new Error('В файле нет списка сессий')
        const { tree, dropped } = checkTree(treeRaw, false)
        return { value: { version: 1, tree }, issues: dropped }
      },
      empty
    )
  }

  async load(): Promise<LoadResult<SessionsData>> {
    const result = await this.file.load()
    this.data = result.data
    return result
  }

  get tree(): TreeNode[] {
    return this.data.tree
  }

  find(id: string): SessionNode | null {
    return findSession(this.data.tree, id)
  }

  /** Дерево должно быть уже проверено (checkTree в строгом режиме). */
  async save(tree: TreeNode[]): Promise<void> {
    this.data = { version: 1, tree }
    await this.file.save(this.data)
  }

  flush(): Promise<void> {
    return this.file.flush()
  }
}
