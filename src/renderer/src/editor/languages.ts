// Подсветка синтаксиса: язык определяется по имени файла, особым именам и строке «#!».
// Модули языков загружаются по требованию — только когда открыт файл такого типа.

import type { Extension } from '@codemirror/state'
import { StreamLanguage, type StreamParser } from '@codemirror/language'

export interface LanguageInfo {
  id: string
  label: string
}

const PLAIN: LanguageInfo = { id: 'text', label: 'Текст' }

const BY_EXT: Record<string, LanguageInfo> = {
  js: { id: 'javascript', label: 'JavaScript' },
  mjs: { id: 'javascript', label: 'JavaScript' },
  cjs: { id: 'javascript', label: 'JavaScript' },
  jsx: { id: 'jsx', label: 'JavaScript (JSX)' },
  ts: { id: 'typescript', label: 'TypeScript' },
  mts: { id: 'typescript', label: 'TypeScript' },
  cts: { id: 'typescript', label: 'TypeScript' },
  tsx: { id: 'tsx', label: 'TypeScript (TSX)' },
  json: { id: 'json', label: 'JSON' },
  jsonc: { id: 'json', label: 'JSON' },
  py: { id: 'python', label: 'Python' },
  pyw: { id: 'python', label: 'Python' },
  pyi: { id: 'python', label: 'Python' },
  yml: { id: 'yaml', label: 'YAML' },
  yaml: { id: 'yaml', label: 'YAML' },
  html: { id: 'html', label: 'HTML' },
  htm: { id: 'html', label: 'HTML' },
  php: { id: 'html', label: 'PHP / HTML' },
  xml: { id: 'xml', label: 'XML' },
  svg: { id: 'xml', label: 'SVG' },
  xsd: { id: 'xml', label: 'XML' },
  plist: { id: 'xml', label: 'XML' },
  css: { id: 'css', label: 'CSS' },
  scss: { id: 'css', label: 'SCSS' },
  less: { id: 'css', label: 'Less' },
  md: { id: 'markdown', label: 'Markdown' },
  markdown: { id: 'markdown', label: 'Markdown' },
  sql: { id: 'sql', label: 'SQL' },
  sh: { id: 'shell', label: 'Shell' },
  bash: { id: 'shell', label: 'Bash' },
  zsh: { id: 'shell', label: 'Zsh' },
  ksh: { id: 'shell', label: 'Shell' },
  ini: { id: 'properties', label: 'INI' },
  cfg: { id: 'properties', label: 'Конфигурация' },
  conf: { id: 'properties', label: 'Конфигурация' },
  cnf: { id: 'properties', label: 'Конфигурация' },
  env: { id: 'properties', label: 'ENV' },
  properties: { id: 'properties', label: 'Properties' },
  service: { id: 'properties', label: 'systemd' },
  timer: { id: 'properties', label: 'systemd' },
  socket: { id: 'properties', label: 'systemd' },
  toml: { id: 'toml', label: 'TOML' },
  lua: { id: 'lua', label: 'Lua' },
  pl: { id: 'perl', label: 'Perl' },
  pm: { id: 'perl', label: 'Perl' },
  rb: { id: 'ruby', label: 'Ruby' },
  go: { id: 'go', label: 'Go' },
  rs: { id: 'rust', label: 'Rust' },
  ps1: { id: 'powershell', label: 'PowerShell' },
  psm1: { id: 'powershell', label: 'PowerShell' },
  diff: { id: 'diff', label: 'Diff' },
  patch: { id: 'diff', label: 'Diff' },
  cmake: { id: 'cmake', label: 'CMake' },
  c: { id: 'c', label: 'C' },
  h: { id: 'c', label: 'C' },
  cpp: { id: 'cpp', label: 'C++' },
  cc: { id: 'cpp', label: 'C++' },
  hpp: { id: 'cpp', label: 'C++' },
  java: { id: 'java', label: 'Java' },
  cs: { id: 'csharp', label: 'C#' },
  kt: { id: 'kotlin', label: 'Kotlin' },
  dockerfile: { id: 'dockerfile', label: 'Dockerfile' },
  log: PLAIN,
  txt: PLAIN
}

const BY_NAME: Record<string, LanguageInfo> = {
  dockerfile: BY_EXT.dockerfile,
  containerfile: BY_EXT.dockerfile,
  'cmakelists.txt': BY_EXT.cmake,
  '.bashrc': BY_EXT.bash,
  '.bash_profile': BY_EXT.bash,
  '.bash_aliases': BY_EXT.bash,
  '.bash_logout': BY_EXT.bash,
  '.profile': BY_EXT.sh,
  '.zshrc': BY_EXT.zsh,
  '.zprofile': BY_EXT.zsh,
  crontab: BY_EXT.sh,
  'nginx.conf': { id: 'nginx', label: 'Nginx' },
  sshd_config: { id: 'properties', label: 'Конфигурация SSH' },
  ssh_config: { id: 'properties', label: 'Конфигурация SSH' },
  '.gitconfig': BY_EXT.ini,
  '.editorconfig': BY_EXT.ini,
  gemfile: BY_EXT.rb,
  'go.mod': PLAIN,
  makefile: PLAIN
}

export function detectLanguage(path: string, firstLine = ''): LanguageInfo {
  const name = path.split('/').pop()?.toLowerCase() ?? ''
  if (BY_NAME[name]) return BY_NAME[name]
  // Конфиги nginx обычно лежат в /etc/nginx/ и не обязательно называются *.conf
  if (/\/nginx\/(.*\/)?[^/]+$/.test(path) && !/\.(log|ya?ml|json)$/.test(name)) return { id: 'nginx', label: 'Nginx' }
  if (name.startsWith('.env')) return BY_EXT.env
  if (name.startsWith('dockerfile.') || name.endsWith('.dockerfile')) return BY_EXT.dockerfile
  if (name.startsWith('docker-compose') && /\.ya?ml$/.test(name)) return BY_EXT.yaml
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  if (BY_EXT[ext]) return BY_EXT[ext]
  if (firstLine.startsWith('#!')) {
    if (/python/.test(firstLine)) return BY_EXT.py
    if (/node|deno|bun/.test(firstLine)) return BY_EXT.js
    if (/perl/.test(firstLine)) return BY_EXT.pl
    if (/ruby/.test(firstLine)) return BY_EXT.rb
    if (/(ba|z|k|da)?sh\b/.test(firstLine)) return BY_EXT.sh
  }
  return PLAIN
}

const legacy = (parser: StreamParser<unknown>) => StreamLanguage.define(parser)

/** Расширение CodeMirror для языка (пустое для простого текста). */
export async function loadLanguage(id: string): Promise<Extension> {
  switch (id) {
    case 'javascript':
    case 'jsx':
    case 'typescript':
    case 'tsx': {
      const { javascript } = await import('@codemirror/lang-javascript')
      return javascript({ jsx: id === 'jsx' || id === 'tsx', typescript: id === 'typescript' || id === 'tsx' })
    }
    case 'json':
      return (await import('@codemirror/lang-json')).json()
    case 'python':
      return (await import('@codemirror/lang-python')).python()
    case 'yaml':
      return (await import('@codemirror/lang-yaml')).yaml()
    case 'html':
      return (await import('@codemirror/lang-html')).html()
    case 'xml':
      return (await import('@codemirror/lang-xml')).xml()
    case 'css':
      return (await import('@codemirror/lang-css')).css()
    case 'markdown':
      return (await import('@codemirror/lang-markdown')).markdown()
    case 'sql':
      return (await import('@codemirror/lang-sql')).sql()
    case 'shell':
      return legacy((await import('@codemirror/legacy-modes/mode/shell')).shell)
    case 'nginx':
      return legacy((await import('@codemirror/legacy-modes/mode/nginx')).nginx)
    case 'properties':
      return legacy((await import('@codemirror/legacy-modes/mode/properties')).properties)
    case 'toml':
      return legacy((await import('@codemirror/legacy-modes/mode/toml')).toml)
    case 'dockerfile':
      return legacy((await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile)
    case 'lua':
      return legacy((await import('@codemirror/legacy-modes/mode/lua')).lua)
    case 'perl':
      return legacy((await import('@codemirror/legacy-modes/mode/perl')).perl)
    case 'ruby':
      return legacy((await import('@codemirror/legacy-modes/mode/ruby')).ruby)
    case 'go':
      return legacy((await import('@codemirror/legacy-modes/mode/go')).go)
    case 'rust':
      return legacy((await import('@codemirror/legacy-modes/mode/rust')).rust)
    case 'powershell':
      return legacy((await import('@codemirror/legacy-modes/mode/powershell')).powerShell)
    case 'diff':
      return legacy((await import('@codemirror/legacy-modes/mode/diff')).diff)
    case 'cmake':
      return legacy((await import('@codemirror/legacy-modes/mode/cmake')).cmake)
    case 'c':
    case 'cpp':
    case 'java':
    case 'csharp':
    case 'kotlin': {
      const m = await import('@codemirror/legacy-modes/mode/clike')
      return legacy({ c: m.c, cpp: m.cpp, java: m.java, csharp: m.csharp, kotlin: m.kotlin }[id])
    }
    default:
      return []
  }
}

// ---------- цвет значка файла ----------

export type FileTone = 'green' | 'blue' | 'yellow' | 'purple' | 'red' | 'faint' | 'dim'

const TONE_BY_LANGUAGE: Record<string, FileTone> = {
  shell: 'green',
  nginx: 'green',
  dockerfile: 'green',
  diff: 'green',
  python: 'blue',
  markdown: 'blue',
  typescript: 'blue',
  tsx: 'blue',
  go: 'blue',
  c: 'blue',
  cpp: 'blue',
  csharp: 'blue',
  java: 'blue',
  kotlin: 'blue',
  rust: 'blue',
  lua: 'blue',
  perl: 'blue',
  ruby: 'blue',
  powershell: 'blue',
  cmake: 'blue',
  yaml: 'purple',
  css: 'purple',
  toml: 'purple',
  sql: 'purple',
  properties: 'yellow',
  json: 'yellow',
  javascript: 'yellow',
  jsx: 'yellow',
  html: 'red',
  xml: 'red'
}

const NON_TEXT = new Set(
  (
    'gz tgz zip tar xz bz2 zst 7z rar deb rpm apk iso img qcow2 vmdk so o a bin exe dll jar war class pyc ' +
    'png jpg jpeg gif webp ico bmp tif tiff pdf mp3 mp4 mkv avi mov wav ogg flac woff woff2 ttf otf eot ' +
    'sqlite sqlite3 db log swp'
  ).split(' ')
)

/** Цвет значка файла в дереве и на вкладках. */
export function fileTone(name: string): FileTone {
  const lower = name.toLowerCase()
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''
  if (NON_TEXT.has(ext) || /\.log\.\d+(\.gz)?$/.test(lower)) return 'faint'
  return TONE_BY_LANGUAGE[detectLanguage(lower).id] ?? 'dim'
}
