// Неизменяемые операции над деревом сессий. Каждая функция возвращает новое дерево,
// не трогая исходное, — это удобно для React и безопасно для сохранения.

import type { FolderNode, SessionNode, TreeNode } from './types'

export interface Located {
  node: TreeNode
  parent: FolderNode | null
  index: number
  /** Папки от корня до непосредственного родителя. */
  ancestors: FolderNode[]
}

export function newId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

export function locate(tree: readonly TreeNode[], id: string): Located | null {
  const visit = (list: readonly TreeNode[], parent: FolderNode | null, ancestors: FolderNode[]): Located | null => {
    for (let i = 0; i < list.length; i++) {
      const node = list[i]
      if (node.id === id) return { node, parent, index: i, ancestors }
      if (node.type === 'folder') {
        const found = visit(node.children, node, [...ancestors, node])
        if (found) return found
      }
    }
    return null
  }
  return visit(tree, null, [])
}

export function findSession(tree: readonly TreeNode[], id: string): SessionNode | null {
  const found = locate(tree, id)
  return found && found.node.type === 'session' ? found.node : null
}

export function walk(tree: readonly TreeNode[], fn: (node: TreeNode, depth: number) => void, depth = 0): void {
  for (const node of tree) {
    fn(node, depth)
    if (node.type === 'folder') walk(node.children, fn, depth + 1)
  }
}

export function countSessions(tree: readonly TreeNode[]): number {
  let n = 0
  walk(tree, (node) => {
    if (node.type === 'session') n++
  })
  return n
}

export function sessionIds(tree: readonly TreeNode[]): string[] {
  const ids: string[] = []
  walk(tree, (node) => {
    if (node.type === 'session') ids.push(node.id)
  })
  return ids
}

export function folders(tree: readonly TreeNode[]): { folder: FolderNode; depth: number }[] {
  const out: { folder: FolderNode; depth: number }[] = []
  walk(tree, (node, depth) => {
    if (node.type === 'folder') out.push({ folder: node, depth })
  })
  return out
}

/** Заменяет узел с указанным id результатом fn. */
export function updateNode(tree: readonly TreeNode[], id: string, fn: (node: TreeNode) => TreeNode): TreeNode[] {
  let changed = false
  const visit = (list: readonly TreeNode[]): TreeNode[] => {
    let out: TreeNode[] | null = null
    for (let i = 0; i < list.length; i++) {
      const node = list[i]
      let next: TreeNode = node
      if (node.id === id) {
        next = fn(node)
        changed = true
      } else if (node.type === 'folder') {
        const kids = visit(node.children)
        if (kids !== node.children) next = { ...node, children: kids }
      }
      if (next !== node) {
        out ??= list.slice()
        out[i] = next
      }
    }
    return out ?? (list as TreeNode[])
  }
  const result = visit(tree)
  return changed ? result : (tree as TreeNode[])
}

export function removeNode(tree: readonly TreeNode[], id: string): TreeNode[] {
  const visit = (list: readonly TreeNode[]): TreeNode[] => {
    const idx = list.findIndex((n) => n.id === id)
    if (idx >= 0) return [...list.slice(0, idx), ...list.slice(idx + 1)]
    let out: TreeNode[] | null = null
    for (let i = 0; i < list.length; i++) {
      const node = list[i]
      if (node.type !== 'folder') continue
      const kids = visit(node.children)
      if (kids !== node.children) {
        out ??= list.slice()
        out[i] = { ...node, children: kids }
      }
    }
    return out ?? (list as TreeNode[])
  }
  return visit(tree)
}

/**
 * Вставляет узел в папку parentId (null — корень) перед узлом beforeId
 * (null или не найден — в конец).
 */
export function insertNode(
  tree: readonly TreeNode[],
  node: TreeNode,
  parentId: string | null,
  beforeId: string | null = null
): TreeNode[] {
  const insertInto = (list: readonly TreeNode[]): TreeNode[] => {
    const idx = beforeId ? list.findIndex((n) => n.id === beforeId) : -1
    return idx >= 0 ? [...list.slice(0, idx), node, ...list.slice(idx)] : [...list, node]
  }
  if (parentId === null) return insertInto(tree)
  const parent = locate(tree, parentId)
  if (!parent || parent.node.type !== 'folder') throw new Error('Папка не найдена')
  return updateNode(tree, parentId, (f) => ({ ...(f as FolderNode), children: insertInto((f as FolderNode).children) }))
}

/** true, если candidateId находится внутри папки folderId (на любой глубине) или совпадает с ней. */
export function isInside(tree: readonly TreeNode[], folderId: string, candidateId: string): boolean {
  if (folderId === candidateId) return true
  const found = locate(tree, candidateId)
  return !!found && found.ancestors.some((a) => a.id === folderId)
}

/** Переносит узел. Папку нельзя перенести внутрь самой себя. */
export function moveNode(
  tree: readonly TreeNode[],
  id: string,
  parentId: string | null,
  beforeId: string | null = null
): TreeNode[] {
  const found = locate(tree, id)
  if (!found) throw new Error('Запись не найдена')
  if (beforeId === id) return tree as TreeNode[]
  if (parentId !== null && found.node.type === 'folder' && isInside(tree, id, parentId)) {
    throw new Error('Нельзя переместить папку внутрь самой себя')
  }
  const without = removeNode(tree, id)
  return insertNode(without, found.node, parentId, beforeId)
}

export function setAllExpanded(tree: readonly TreeNode[], expanded: boolean): TreeNode[] {
  return tree.map((node) =>
    node.type === 'folder' ? { ...node, expanded, children: setAllExpanded(node.children, expanded) } : node
  )
}

export interface FlatRow {
  node: TreeNode
  depth: number
  parentId: string | null
  /** Папка раскрыта в текущем представлении (с учётом фильтра). */
  open: boolean
}

export function sessionMatches(s: SessionNode, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return (
    s.name.toLowerCase().includes(q) ||
    s.host.toLowerCase().includes(q) ||
    `${s.username}@${s.host}`.toLowerCase().includes(q)
  )
}

/**
 * Плоский список видимых строк дерева. При фильтре показываются только подходящие
 * сессии и папки, в которых они лежат (папки раскрываются автоматически).
 */
export function flatten(tree: readonly TreeNode[], filter = ''): FlatRow[] {
  const query = filter.trim()
  const rows: FlatRow[] = []
  const hasMatch = (node: TreeNode): boolean =>
    node.type === 'session' ? sessionMatches(node, query) : node.children.some(hasMatch)
  const visit = (list: readonly TreeNode[], depth: number, parentId: string | null): void => {
    for (const node of list) {
      if (query && !hasMatch(node)) continue
      const open = node.type === 'folder' && (query ? true : node.expanded)
      rows.push({ node, depth, parentId, open })
      if (node.type === 'folder' && open) visit(node.children, depth + 1, node.id)
    }
  }
  visit(tree, 0, null)
  return rows
}
