// Макросы: горячие клавиши, проверка данных, где виден макрос, что он печатает, хранение.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { hotkeyOf, hotkeyProblem } from '../src/shared/hotkeys'
import { macroApplies, macroChunks, scopeMissing } from '../src/shared/macro'
import type { Macro, TreeNode } from '../src/shared/types'
import { checkMacro, checkMacros, checkSession } from '../src/shared/validate'
import { MacrosStore } from '../src/main/store/macros'

const key = (code: string, mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {}) => ({
  code,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
  metaKey: !!mods.meta
})

describe('горячие клавиши', () => {
  it('по физической клавише — независимо от раскладки', () => {
    expect(hotkeyOf(key('Digit1', { ctrl: true, alt: true }))).toBe('Ctrl+Alt+1')
    expect(hotkeyOf(key('KeyM', { ctrl: true, alt: true }))).toBe('Ctrl+Alt+M') // в русской раскладке это «Ь»
    expect(hotkeyOf(key('Numpad5', { alt: true, shift: true }))).toBe('Alt+Shift+5')
    expect(hotkeyOf(key('F5', { ctrl: true }))).toBe('Ctrl+F5')
    expect(hotkeyOf(key('ArrowUp', { ctrl: true, alt: true }))).toBeNull()
    expect(hotkeyOf(key('ControlLeft', { ctrl: true }))).toBeNull()
    expect(hotkeyOf(key('Digit1', { meta: true }))).toBeNull()
  })

  it('не занимает то, что нужно терминалу, редактору и самой программе', () => {
    expect(hotkeyProblem('Ctrl+Alt+1')).toBeNull()
    expect(hotkeyProblem('Ctrl+Shift+5')).toBeNull()
    expect(hotkeyProblem('Ctrl+F5')).toBeNull()
    expect(hotkeyProblem('Ctrl+C')).toMatch(/два модификатора/) // прерывание в терминале
    expect(hotkeyProblem('Alt+B')).toMatch(/два модификатора/) // readline: слово назад
    expect(hotkeyProblem('F10')).toMatch(/F-клавиши/) // выход из mc
    expect(hotkeyProblem('Ctrl+Shift+N')).toMatch(/занято/)
    expect(hotkeyProblem('Ctrl+Alt+Enter')).toMatch(/Нажмите сочетание/)
  })
})

const tree: TreeNode[] = [
  {
    type: 'folder',
    id: 'f-prod',
    name: 'Продакшн',
    expanded: true,
    children: [
      { type: 'folder', id: 'f-web', name: 'Веб', expanded: true, children: [{ type: 'session', id: 's-web1', name: 'web-1', host: '203.0.113.10', port: 22, username: 'root', auth: 'key', keyPath: '' }] },
      { type: 'session', id: 's-db', name: 'db', host: '203.0.113.20', port: 22, username: 'root', auth: 'key', keyPath: '' }
    ]
  },
  { type: 'session', id: 's-test', name: 'test', host: '198.51.100.5', port: 22, username: 'dev', auth: 'password', keyPath: '' }
]

const macro = (scope: Macro['scope'], extra: Partial<Macro> = {}): Macro => ({
  id: 'm1',
  name: 'Проверка',
  commands: 'uptime',
  enter: true,
  delay: 0,
  scope,
  hotkey: '',
  ...extra
})

describe('где виден макрос', () => {
  const ssh = (sessionId: string) => ({ local: false, sessionId })
  const local = { local: true, sessionId: '' }

  it('везде, в папке (включая вложенные), в одной сессии, в терминалах компьютера', () => {
    expect(macroApplies(macro({ type: 'all' }), local, tree)).toBe(true)
    const prod = macro({ type: 'folder', id: 'f-prod' })
    expect(macroApplies(prod, ssh('s-web1'), tree)).toBe(true) // вложенная папка
    expect(macroApplies(prod, ssh('s-db'), tree)).toBe(true)
    expect(macroApplies(prod, ssh('s-test'), tree)).toBe(false)
    expect(macroApplies(prod, local, tree)).toBe(false)
    const one = macro({ type: 'session', id: 's-db' })
    expect(macroApplies(one, ssh('s-db'), tree)).toBe(true)
    expect(macroApplies(one, ssh('s-web1'), tree)).toBe(false)
    const pc = macro({ type: 'local' })
    expect(macroApplies(pc, local, tree)).toBe(true)
    expect(macroApplies(pc, ssh('s-db'), tree)).toBe(false)
  })

  it('папку удалили — макрос виден везде (с пометкой), а не теряется', () => {
    const orphan = macro({ type: 'folder', id: 'f-gone' })
    expect(scopeMissing(orphan, tree)).toBe(true)
    expect(macroApplies(orphan, ssh('s-test'), tree)).toBe(true)
    expect(scopeMissing(macro({ type: 'folder', id: 's-db' }), tree)).toBe(true) // это сессия, а не папка
  })
})

describe('что печатает макрос', () => {
  it('строки с Enter; без Enter в конце, если так выбрано; пустые строки в конце не нужны', () => {
    expect(macroChunks('cd /srv/app\ngit pull\n\n', true)).toEqual(['cd /srv/app\r', 'git pull\r'])
    expect(macroChunks('cd /srv/app\r\nrm -rf build', false)).toEqual(['cd /srv/app\r', 'rm -rf build'])
    expect(macroChunks('  echo отступ сохраняется', true)).toEqual(['  echo отступ сохраняется\r'])
    expect(macroChunks('a\n\nb', true)).toEqual(['a\r', '\r', 'b\r'])
  })
})

describe('проверка данных', () => {
  it('макрос: значения по умолчанию, неверная клавиша и пауза отбрасываются', () => {
    expect(checkMacro({ id: 'abcd1234', name: '  Логи  ', commands: 'docker logs -f app', scope: { type: 'folder', id: 'f-prod1' } })).toEqual({
      id: 'abcd1234',
      name: 'Логи',
      commands: 'docker logs -f app',
      enter: true,
      delay: 0,
      scope: { type: 'folder', id: 'f-prod1' },
      hotkey: ''
    })
    const m = checkMacro({ id: 'abcd1234', name: 'x', commands: 'ls', hotkey: 'Ctrl+C', delay: 123, enter: false, scope: { type: 'weird' } })
    expect(m).toMatchObject({ hotkey: '', delay: 0, enter: false, scope: { type: 'all' } })
    expect(checkMacro({ id: 'abcd1234', name: 'x', commands: '   ' })).toBe('нет команд')
  })

  it('список: с диска повреждённые записи пропускаются, из окна — ошибка; одна клавиша — один макрос', () => {
    const raw = [
      { id: 'aaaa1111', name: 'a', commands: 'ls', hotkey: 'Ctrl+Alt+1' },
      { id: 'bbbb2222', name: 'b', commands: 'pwd', hotkey: 'Ctrl+Alt+1' },
      { id: 'cccc3333', name: '', commands: 'x' }
    ]
    const { macros, dropped } = checkMacros(raw, false)
    expect(macros.map((m) => [m.id, m.hotkey])).toEqual([
      ['aaaa1111', 'Ctrl+Alt+1'],
      ['bbbb2222', '']
    ])
    expect(dropped).toHaveLength(1)
    expect(() => checkMacros(raw, true)).toThrow()
  })

  it('сессия хранит «после входа выполнить», если это id макроса', () => {
    const base = { type: 'session', id: 's-1abcd', name: 'web', host: '203.0.113.1', port: 22, username: 'root', auth: 'key', keyPath: '' }
    expect(checkSession({ ...base, onConnect: 'abcd1234' })).toMatchObject({ onConnect: 'abcd1234' })
    expect(checkSession({ ...base, onConnect: 42 })).not.toHaveProperty('onConnect')
  })
})

describe('хранение macros.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'termion-macros-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('сохраняет и читает, повреждённую запись пропускает', async () => {
    const store = new MacrosStore(dir)
    await store.load()
    await store.save([macro({ type: 'all' }, { id: 'abcd1234', hotkey: 'Ctrl+Alt+2' })])
    await store.flush()
    const again = new MacrosStore(dir)
    await again.load()
    expect(again.list).toEqual([macro({ type: 'all' }, { id: 'abcd1234', hotkey: 'Ctrl+Alt+2' })])

    const file = join(dir, 'macros.json')
    const data = JSON.parse(readFileSync(file, 'utf8'))
    data.macros.push({ id: 'broken!!', name: 1 })
    writeFileSync(file, JSON.stringify(data))
    const third = new MacrosStore(dir)
    const result = await third.load()
    expect(third.list).toHaveLength(1)
    expect(result.issues.length).toBe(1)
  })
})
