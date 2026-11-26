// Терминалы компьютера: поиск оболочек и настоящий псевдотерминал Windows (ConPTY).

import { describe, expect, it } from 'vitest'
import type { ConnState } from '../src/shared/types'
import { LocalTerminal } from '../src/main/local/localTerminal'
import { detectShells, type ShellSpec } from '../src/main/local/shells'

const isWindows = process.platform === 'win32'

function startShell(shell: ShellSpec) {
  const states: ConnState[] = []
  const notices: string[] = []
  let output = ''
  let term: LocalTerminal | null = null
  term = new LocalTerminal(
    shell,
    {
      data: (chunk) => {
        output += chunk.toString('utf8')
        setImmediate(() => term?.ack(chunk.length))
      },
      state: (s) => states.push(s),
      notice: (_l, t) => notices.push(t)
    },
    { cols: 100, rows: 30 }
  )
  term.start()
  const wait = async (cond: () => boolean, what: string, timeout = 15_000) => {
    const start = Date.now()
    while (!cond()) {
      if (Date.now() - start > timeout) throw new Error(`${what}; вывод: ${output.slice(-400)}`)
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  return { term, states, notices, output: () => output, wait }
}

describe.skipIf(!isWindows)('терминалы компьютера (Windows)', () => {
  it('находит командную строку и PowerShell', async () => {
    const shells = await detectShells()
    const ids = shells.map((s) => s.id)
    expect(ids).toContain('cmd')
    expect(ids).toContain('powershell')
    expect(new Set(ids).size).toBe(ids.length) // без повторов
    for (const s of shells) expect(s.name).toBeTruthy()
  }, 30_000)

  it('командная строка: ввод, вывод с кириллицей, выход и код завершения', async () => {
    const cmd = (await detectShells()).find((s) => s.id === 'cmd') as ShellSpec
    const t = startShell(cmd)
    await t.wait(() => t.states.includes('connected'), 'запуск')
    t.term.write('echo TERMION-%USERNAME%-OK & echo Привет\r')
    await t.wait(() => /TERMION-.+-OK/.test(t.output()) && t.output().includes('Привет'), 'вывод команды')
    t.term.resize(60, 20)
    t.term.write('exit 3\r')
    await t.wait(() => t.states.includes('closed'), 'выход')
    expect(t.notices.join(' ')).toContain('кодом 3')
    t.term.dispose()
  }, 30_000)

  it('PowerShell: команда выполняется, закрытие вкладки завершает процесс', async () => {
    const ps = (await detectShells()).find((s) => s.id === 'powershell') as ShellSpec
    const t = startShell(ps)
    await t.wait(() => t.states.includes('connected'), 'запуск')
    t.term.write('Write-Output ("PS-" + (2 + 3))\r')
    await t.wait(() => t.output().includes('PS-5'), 'вывод команды')
    t.term.dispose()
    t.term.write('Write-Output "после закрытия"\r') // ничего не ломает
    expect(t.term.isActive).toBe(true) // состояние не меняется: окно уже закрыло вкладку
  }, 40_000)

  it('огромный вывод не копится без подтверждения (контроль потока)', async () => {
    const cmd = (await detectShells()).find((s) => s.id === 'cmd') as ShellSpec
    let received = 0
    let term: LocalTerminal | null = null
    const states: ConnState[] = []
    // Окно «не успевает»: подтверждаем получение не сразу.
    term = new LocalTerminal(cmd, { data: (c) => (received += c.length), state: (s) => states.push(s), notice: () => undefined }, { cols: 120, rows: 30 })
    term.start()
    term.write('for /L %i in (1,1,200000) do @echo line-%i-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\r')
    await new Promise((r) => setTimeout(r, 2500))
    const paused = received
    expect(paused).toBeLessThan(4 * 1024 * 1024) // остановился около порога, а не вылил всё
    term.ack(received) // окно догнало — вывод продолжается
    await new Promise((r) => setTimeout(r, 1000))
    expect(received).toBeGreaterThan(paused)
    term.dispose()
  }, 30_000)
})

describe.skipIf(!isWindows)('Git Bash и WSL (если установлены)', () => {
  it('Git Bash: bash отвечает и стартует в домашней папке', async (ctx) => {
    const bash = (await detectShells()).find((s) => s.id === 'gitbash')
    if (!bash) return ctx.skip()
    const t = startShell(bash)
    await t.wait(() => t.states.includes('connected'), 'запуск')
    t.term.write('echo "BASH-$((6*7))-$(basename "$HOME")"\r')
    await t.wait(() => t.output().includes('BASH-42-'), 'вывод bash')
    t.term.write('exit\r')
    await t.wait(() => t.states.includes('closed'), 'выход')
    t.term.dispose()
  }, 40_000)

  it('WSL: Linux отвечает', async (ctx) => {
    const wsl = (await detectShells()).find((s) => s.kind === 'wsl')
    if (!wsl) return ctx.skip()
    const t = startShell(wsl)
    await t.wait(() => t.states.includes('connected'), 'запуск')
    t.term.write('echo "WSL-$(uname -s)"\r')
    await t.wait(() => t.output().includes('WSL-Linux'), 'вывод WSL', 60_000)
    t.term.write('exit\r')
    await t.wait(() => t.states.includes('closed'), 'выход', 20_000)
    t.term.dispose()
  }, 90_000)
})
