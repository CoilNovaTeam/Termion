import { describe, expect, it } from 'vitest'
import type { FolderNode, SessionNode, TreeNode } from '../src/shared/types'
import {
  countSessions,
  flatten,
  insertNode,
  isInside,
  locate,
  moveNode,
  newId,
  removeNode,
  setAllExpanded,
  updateNode
} from '../src/shared/tree'

const s = (id: string, name = id, host = `${id}.example.com`): SessionNode => ({
  type: 'session',
  id,
  name,
  host,
  port: 22,
  username: 'root',
  auth: 'password',
  keyPath: ''
})
const f = (id: string, children: TreeNode[], expanded = true): FolderNode => ({ type: 'folder', id, name: id, expanded, children })

const sample = (): TreeNode[] => [f('prod', [s('a'), s('b')]), f('clients', [f('acme', [s('c')], false)]), s('d')]

describe('операции с деревом', () => {
  it('находит узел с родителем и предками', () => {
    const found = locate(sample(), 'c')
    expect(found?.parent?.id).toBe('acme')
    expect(found?.ancestors.map((a) => a.id)).toEqual(['clients', 'acme'])
  })

  it('не изменяет исходное дерево', () => {
    const tree = sample()
    const snapshot = JSON.stringify(tree)
    removeNode(tree, 'a')
    insertNode(tree, s('x'), 'prod')
    moveNode(tree, 'd', 'acme')
    updateNode(tree, 'b', (n) => ({ ...n, name: 'B' }))
    expect(JSON.stringify(tree)).toBe(snapshot)
  })

  it('переносит сессию в папку перед указанным узлом', () => {
    const tree = moveNode(sample(), 'd', 'prod', 'b')
    const prod = locate(tree, 'prod')?.node as FolderNode
    expect(prod.children.map((n) => n.id)).toEqual(['a', 'd', 'b'])
    expect(tree.map((n) => n.id)).toEqual(['prod', 'clients'])
  })

  it('не даёт перенести папку внутрь самой себя', () => {
    expect(() => moveNode(sample(), 'clients', 'acme')).toThrow()
    expect(() => moveNode(sample(), 'clients', 'clients')).toThrow()
    expect(isInside(sample(), 'clients', 'c')).toBe(true)
    expect(isInside(sample(), 'prod', 'c')).toBe(false)
  })

  it('updateNode возвращает то же дерево, если узел не найден', () => {
    const tree = sample()
    expect(updateNode(tree, 'nope', (n) => n)).toBe(tree)
  })

  it('считает сессии и раскрывает/сворачивает все папки', () => {
    expect(countSessions(sample())).toBe(4)
    const collapsed = setAllExpanded(sample(), false)
    expect(flatten(collapsed).map((r) => r.node.id)).toEqual(['prod', 'clients', 'd'])
  })

  it('flatten учитывает свёрнутые папки и фильтр', () => {
    expect(flatten(sample()).map((r) => r.node.id)).toEqual(['prod', 'a', 'b', 'clients', 'acme', 'd'])
    // фильтр раскрывает свёрнутую папку с подходящей сессией
    const rows = flatten(sample(), 'c.example')
    expect(rows.map((r) => r.node.id)).toEqual(['clients', 'acme', 'c'])
    expect(rows.find((r) => r.node.id === 'acme')?.open).toBe(true)
    expect(flatten(sample(), 'root@d.example').map((r) => r.node.id)).toEqual(['d'])
  })

  it('newId выдаёт уникальные допустимые идентификаторы', () => {
    const ids = new Set(Array.from({ length: 500 }, newId))
    expect(ids.size).toBe(500)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{24}$/)
  })
})
