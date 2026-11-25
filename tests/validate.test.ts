import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, ValidationError, checkSession, checkTree, normalizeHost, normalizeSettings } from '../src/shared/validate'

const session = (over: Record<string, unknown> = {}) => ({
  type: 'session',
  id: 'abc',
  name: 'Prod',
  host: 'example.com',
  port: 22,
  username: 'root',
  auth: 'key',
  keyPath: '',
  ...over
})

describe('проверка данных', () => {
  it('нормализует адрес сервера', () => {
    expect(normalizeHost(' example.com ')).toBe('example.com')
    expect(normalizeHost('[2001:db8::1]')).toBe('2001:db8::1')
    expect(normalizeHost('fe80::1%eth0')).toBe('fe80::1%eth0')
    expect(normalizeHost('bad host')).toBeNull()
    expect(normalizeHost('')).toBeNull()
    expect(normalizeHost('a;rm -rf')).toBeNull()
  })

  it('проверяет сессию', () => {
    expect(checkSession(session())).toMatchObject({ host: 'example.com', port: 22 })
    expect(checkSession(session({ port: 70000 }))).toBe('некорректный порт')
    expect(checkSession(session({ port: '2222' }))).toMatchObject({ port: 2222 })
    expect(checkSession(session({ username: 'two words' }))).toBe('некорректное имя пользователя')
    expect(checkSession(session({ auth: 'magic' }))).toBe('неизвестный способ входа')
    expect(checkSession(session({ id: '../etc' }))).toBe('некорректный идентификатор')
    expect(checkSession(session({ keyPath: undefined }))).toMatchObject({ keyPath: '' })
  })

  it('строгий режим отвергает любые повреждения', () => {
    expect(() => checkTree([session({ port: 0 })], true)).toThrow(ValidationError)
    expect(() => checkTree([session(), session()], true)).toThrow(/повтор/)
    expect(() => checkTree('nope', true)).toThrow()
  })

  it('мягкий режим пропускает повреждённые записи и сохраняет остальные', () => {
    const { tree, dropped } = checkTree(
      [
        session({ id: 'ok1' }),
        session({ id: 'bad', host: 'two words' }),
        { type: 'folder', id: 'f1', name: 'Папка', expanded: false, children: [session({ id: 'ok2' }), 42] },
        { type: 'alien' }
      ],
      false
    )
    expect(tree.map((n) => n.id)).toEqual(['ok1', 'f1'])
    expect(tree[1].type === 'folder' && tree[1].children.map((n) => n.id)).toEqual(['ok2'])
    expect(dropped).toHaveLength(3)
  })

  it('ограничивает глубину вложенности', () => {
    let node: Record<string, unknown> = session({ id: 'deep' })
    for (let i = 0; i < 30; i++) node = { type: 'folder', id: `f${i}`, name: `f${i}`, children: [node] }
    expect(() => checkTree([node], true)).toThrow(/глубоко/)
  })

  it('настройки: неверные значения заменяются, числа ограничиваются', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    const s = normalizeSettings({ theme: 'neon', layout: 'ide', terminal: { fontSize: 99, scrollback: -5, cursorStyle: 'bar' } })
    expect(s.theme).toBe('graphite')
    expect(s.layout).toBe('ide')
    expect(s.terminal.fontSize).toBe(28)
    expect(s.terminal.scrollback).toBe(500)
    expect(s.terminal.cursorStyle).toBe('bar')
  })
})
