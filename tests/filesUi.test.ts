import { describe, expect, it } from 'vitest'
import { ancestry, baseName, canMoveInto, isWithin, joinPath, parentPath, rebase, safeLocalName, shellQuote, topLevel } from '@shared/remotePath'
import { cwdFromOsc7, cwdFromTitle, resolveCwd } from '../src/renderer/src/terminal/cwd'
import { formatSize, modeString, plural } from '../src/renderer/src/format'
import { detectLanguage, fileTone } from '../src/renderer/src/editor/languages'

describe('пути на сервере', () => {
  it('склеивает и разбирает пути', () => {
    expect(joinPath('/', 'etc')).toBe('/etc')
    expect(joinPath('/etc', 'nginx')).toBe('/etc/nginx')
    expect(parentPath('/etc/nginx')).toBe('/etc')
    expect(parentPath('/etc')).toBe('/')
    expect(parentPath('/')).toBe('/')
    expect(baseName('/etc/nginx/nginx.conf')).toBe('nginx.conf')
    expect(baseName('/')).toBe('/')
    expect(ancestry('/a/b/c')).toEqual(['/a', '/a/b', '/a/b/c'])
    expect(ancestry('/')).toEqual([])
  })

  it('isWithin не путает похожие имена', () => {
    expect(isWithin('/var/www/site', '/var/www')).toBe(true)
    expect(isWithin('/var/www', '/var/www')).toBe(true)
    expect(isWithin('/var/www2', '/var/www')).toBe(false)
    expect(isWithin('/anything', '/')).toBe(true)
  })

  it('rebase переносит пути внутри переименованной папки', () => {
    expect(rebase('/srv/app', '/srv/app', '/srv/web')).toBe('/srv/web')
    expect(rebase('/srv/app/conf/a.yml', '/srv/app', '/srv/web')).toBe('/srv/web/conf/a.yml')
  })

  it('topLevel оставляет только верхние из выделенных', () => {
    expect(topLevel(['/a/b', '/a', '/c', '/a-b', '/a/b/c'])).toEqual(['/a', '/a-b', '/c'])
    expect(topLevel(['/x', '/x'])).toEqual(['/x'])
  })

  it('canMoveInto: не в себя, не внутрь себя и не туда же', () => {
    expect(canMoveInto(['/srv/app/a.txt'], '/srv/web')).toBe(true)
    expect(canMoveInto(['/srv/app/a.txt'], '/srv/app')).toBe(false) // уже там
    expect(canMoveInto(['/srv/app'], '/srv/app')).toBe(false) // в себя
    expect(canMoveInto(['/srv/app'], '/srv/app/conf')).toBe(false) // внутрь себя
    expect(canMoveInto(['/srv/app'], '/srv/application')).toBe(true) // похожее имя — другая папка
    expect(canMoveInto(['/srv/a.txt', '/srv/x/b.txt'], '/srv')).toBe(true) // хоть один не на месте
    expect(canMoveInto([], '/srv')).toBe(false)
  })

  it('safeLocalName: имена, допустимые в Windows', () => {
    expect(safeLocalName('report:2026?.txt')).toBe('report_2026_.txt')
    expect(safeLocalName('con')).toBe('_con')
    expect(safeLocalName('trailing. ')).toBe('trailing')
    expect(safeLocalName('..')).toBe('_')
  })

  it('shellQuote экранирует только когда нужно', () => {
    expect(shellQuote('/var/www/site-1')).toBe('/var/www/site-1')
    expect(shellQuote('/home/u/My Files')).toBe("'/home/u/My Files'")
    expect(shellQuote("/tmp/it's")).toBe("'/tmp/it'\\''s'")
    expect(shellQuote('/tmp/$(rm -rf ~)')).toBe("'/tmp/$(rm -rf ~)'")
  })
})

describe('папка терминала', () => {
  it('понимает заголовки bash в Ubuntu и Fedora', () => {
    expect(cwdFromTitle('igor@srv: ~/app')).toEqual({ path: '~/app', user: 'igor' })
    expect(cwdFromTitle('root@srv: /etc/nginx')).toEqual({ path: '/etc/nginx', user: 'root' })
    expect(cwdFromTitle('deploy@web-1.example:~')).toEqual({ path: '~', user: 'deploy' })
    expect(cwdFromTitle('u@h: /path with spaces/dir')).toEqual({ path: '/path with spaces/dir', user: 'u' })
  })

  it('не принимает чужие заголовки', () => {
    expect(cwdFromTitle('vim')).toBeNull()
    expect(cwdFromTitle('htop')).toBeNull()
    expect(cwdFromTitle('file.txt (~/app) - VIM')).toBeNull()
    expect(cwdFromTitle('igor@srv: app')).toBeNull() // только имя папки (\W)
    expect(cwdFromTitle('igor@srv: ~/.../deep/dir')).toBeNull() // PROMPT_DIRTRIM
  })

  it('понимает OSC 7', () => {
    expect(cwdFromOsc7('file://srv/home/igor/My%20App')).toEqual({ path: '/home/igor/My App', user: null })
    expect(cwdFromOsc7('file:///var/log')).toEqual({ path: '/var/log', user: null })
    expect(cwdFromOsc7('http://x/y')).toBeNull()
  })

  it('раскрывает ~ для своего и чужого пользователя', () => {
    expect(resolveCwd({ path: '~/app', user: 'igor' }, 'igor', '/home/igor')).toBe('/home/igor/app')
    expect(resolveCwd({ path: '~', user: 'igor' }, 'igor', '/home/igor')).toBe('/home/igor')
    expect(resolveCwd({ path: '~', user: 'root' }, 'igor', '/home/igor')).toBe('/root')
    expect(resolveCwd({ path: '~/x', user: 'bob' }, 'igor', '/home/igor')).toBe('/home/bob/x')
    expect(resolveCwd({ path: '~alice/docs', user: 'igor' }, 'igor', '/home/igor')).toBe('/home/alice/docs')
    expect(resolveCwd({ path: '~/app', user: 'igor' }, 'igor', null)).toBeNull()
    expect(resolveCwd({ path: '/var/www/', user: null }, 'igor', null)).toBe('/var/www')
  })
})

describe('форматирование', () => {
  it('размеры', () => {
    expect(formatSize(0)).toBe('0 Б')
    expect(formatSize(1023)).toBe('1023 Б')
    expect(formatSize(1536)).toBe('1,5 КБ')
    expect(formatSize(5 * 1024 * 1024)).toBe('5,0 МБ')
    expect(formatSize(150 * 1024 * 1024)).toBe('150 МБ')
  })

  it('права как в ls -l', () => {
    expect(modeString({ type: 'dir', mode: 0o40755 })).toBe('drwxr-xr-x')
    expect(modeString({ type: 'file', mode: 0o100644 })).toBe('-rw-r--r--')
    expect(modeString({ type: 'file', mode: 0o104755 })).toBe('-rwsr-xr-x')
    expect(modeString({ type: 'dir', mode: 0o41777 })).toBe('drwxrwxrwt')
    expect(modeString({ type: 'link', mode: 0o120777 })).toBe('lrwxrwxrwx')
  })

  it('склонения', () => {
    expect(plural(1, 'файл', 'файла', 'файлов')).toBe('файл')
    expect(plural(3, 'файл', 'файла', 'файлов')).toBe('файла')
    expect(plural(11, 'файл', 'файла', 'файлов')).toBe('файлов')
    expect(plural(22, 'файл', 'файла', 'файлов')).toBe('файла')
  })
})

describe('язык и цвет файла', () => {
  it('определяет язык по имени, пути и #!', () => {
    expect(detectLanguage('/etc/nginx/sites-available/default').id).toBe('nginx')
    expect(detectLanguage('/srv/app/docker-compose.prod.yml').id).toBe('yaml')
    expect(detectLanguage('/srv/app/.env.local').id).toBe('properties')
    expect(detectLanguage('/srv/app/Dockerfile').id).toBe('dockerfile')
    expect(detectLanguage('/usr/local/bin/backup', '#!/usr/bin/env bash').id).toBe('shell')
    expect(detectLanguage('/usr/local/bin/tool', '#!/usr/bin/python3').id).toBe('python')
    expect(detectLanguage('/etc/hosts').id).toBe('text')
  })

  it('цвет значка', () => {
    expect(fileTone('deploy.sh')).toBe('green')
    expect(fileTone('backup.tar.gz')).toBe('faint')
    expect(fileTone('syslog.2.gz')).toBe('faint')
    expect(fileTone('config.yml')).toBe('purple')
    expect(fileTone('README')).toBe('dim')
  })
})
