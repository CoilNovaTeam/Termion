// Проверяет, что бинарник Electron скачан, и докачивает его при необходимости.
// Бывает, что установочный скрипт пакета electron не срабатывает (сеть, прокси, кеш npm).

const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')

const electronDir = join(__dirname, '..', 'node_modules', 'electron')
if (!existsSync(electronDir)) process.exit(0)

const ready = existsSync(join(electronDir, 'path.txt')) && existsSync(join(electronDir, 'dist'))
if (!ready) {
  console.log('Termion: скачиваю Electron…')
  execFileSync(process.execPath, [join(electronDir, 'install.js')], { stdio: 'inherit' })
}
