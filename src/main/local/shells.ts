// Терминалы компьютера: какие оболочки установлены в Windows.
// Ищем PowerShell 7, Windows PowerShell, командную строку, Git Bash, MSYS2, Cygwin и
// дистрибутивы WSL. Список кэшируется: поиск WSL занимает заметное время.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { LocalShell } from '@shared/types'

export interface ShellSpec extends LocalShell {
  file: string
  args: string[]
  env?: Record<string, string>
}

const env = (name: string): string | undefined => process.env[name] || undefined

function run(file: string, args: string[], timeout: number, extraEnv: Record<string, string> = {}): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, encoding: 'buffer', env: { ...process.env, ...extraEnv } }, (err, stdout) =>
      resolve(err && !stdout?.length ? null : stdout)
    )
  })
}

/** Первый существующий файл из списка. */
const firstExisting = (paths: Array<string | undefined>): string | null => paths.find((p): p is string => !!p && existsSync(p)) ?? null

/** Поиск программы в PATH. */
function inPath(exe: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(';')) {
    if (!dir) continue
    const p = join(dir.replace(/^"|"$/g, ''), exe)
    if (existsSync(p)) return p
  }
  return null
}

/** Папка установки Git for Windows из реестра (или null). */
async function gitInstallPath(): Promise<string | null> {
  for (const hive of ['HKLM', 'HKCU']) {
    const out = await run('reg.exe', ['query', `${hive}\\SOFTWARE\\GitForWindows`, '/v', 'InstallPath'], 3000)
    const m = out ? /InstallPath\s+REG_\w+\s+(.+)/i.exec(out.toString('utf8')) : null
    if (m) return m[1].trim()
  }
  return null
}

/** Имена дистрибутивов WSL (служебные дистрибутивы Docker Desktop пропускаются). */
async function wslDistros(wsl: string): Promise<string[]> {
  const out = await run(wsl, ['--list', '--quiet'], 6000, { WSL_UTF8: '1' })
  if (!out?.length) return []
  // Старые версии WSL отвечают в UTF-16 несмотря на WSL_UTF8.
  const text = out.includes(0) ? out.toString('utf16le') : out.toString('utf8')
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\0/g, '').trim())
    .filter((l) => l && !/^docker-desktop/i.test(l) && !/\s/.test(l))
}

export async function detectShells(): Promise<ShellSpec[]> {
  if (process.platform !== 'win32') {
    const shell = env('SHELL') ?? '/bin/sh'
    return [{ id: 'default', name: 'Терминал', kind: 'sh', path: shell, file: shell, args: ['-l'] }]
  }
  const sysRoot = env('SystemRoot') ?? 'C:\\Windows'
  const sys32 = join(sysRoot, 'System32')
  const programFiles = env('ProgramFiles') ?? 'C:\\Program Files'
  const programFilesX86 = env('ProgramFiles(x86)')
  const localAppData = env('LOCALAPPDATA')
  const shells: ShellSpec[] = []

  const pwsh = firstExisting([join(programFiles, 'PowerShell', '7', 'pwsh.exe'), join(programFiles, 'PowerShell', '7-preview', 'pwsh.exe')]) ?? inPath('pwsh.exe')
  if (pwsh) shells.push({ id: 'pwsh', name: 'PowerShell 7', kind: 'pwsh', path: pwsh, file: pwsh, args: ['-NoLogo'] })

  const winPs = join(sys32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (existsSync(winPs)) shells.push({ id: 'powershell', name: 'Windows PowerShell', kind: 'powershell', path: winPs, file: winPs, args: ['-NoLogo'] })

  const cmd = firstExisting([env('ComSpec'), join(sys32, 'cmd.exe')])
  if (cmd) shells.push({ id: 'cmd', name: 'Командная строка', kind: 'cmd', path: cmd, file: cmd, args: [] })

  const gitRoot = await gitInstallPath()
  const gitBash = firstExisting([
    gitRoot ? join(gitRoot, 'bin', 'bash.exe') : undefined,
    join(programFiles, 'Git', 'bin', 'bash.exe'),
    programFilesX86 ? join(programFilesX86, 'Git', 'bin', 'bash.exe') : undefined,
    localAppData ? join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe') : undefined,
    env('USERPROFILE') ? join(env('USERPROFILE') as string, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe') : undefined
  ])
  // CHERE_INVOKING — чтобы bash --login не уходил из папки, где его запустили.
  if (gitBash) shells.push({ id: 'gitbash', name: 'Git Bash', kind: 'gitbash', path: gitBash, file: gitBash, args: ['--login', '-i'], env: { CHERE_INVOKING: '1' } })

  const msys = firstExisting(['C:\\msys64\\usr\\bin\\bash.exe'])
  if (msys) shells.push({ id: 'msys2', name: 'MSYS2', kind: 'msys2', path: msys, file: msys, args: ['--login', '-i'], env: { CHERE_INVOKING: '1', MSYSTEM: 'UCRT64' } })

  const cygwin = firstExisting(['C:\\cygwin64\\bin\\bash.exe'])
  if (cygwin) shells.push({ id: 'cygwin', name: 'Cygwin', kind: 'cygwin', path: cygwin, file: cygwin, args: ['--login', '-i'], env: { CHERE_INVOKING: '1' } })

  const wsl = join(sys32, 'wsl.exe')
  if (existsSync(wsl)) {
    for (const distro of await wslDistros(wsl)) {
      // «Ubuntu-20.04» → «Ubuntu 20.04»
      const name = distro.replace(/-(\d)/, ' $1')
      shells.push({ id: `wsl:${distro}`, name, kind: 'wsl', path: `${wsl} -d ${distro}`, file: wsl, args: ['-d', distro, '--cd', '~'] })
    }
  }
  return shells
}

let cache: Promise<ShellSpec[]> | null = null

/** Найденные оболочки (поиск — один раз; refresh — искать заново, например после установки WSL). */
export function listShells(refresh = false): Promise<ShellSpec[]> {
  if (!cache || refresh) cache = detectShells().catch(() => [])
  return cache
}
