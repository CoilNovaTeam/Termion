// Сквозная проверка собранной программы: настоящее окно Termion + локальный SSH-сервер.
// Запуск: npm run e2e (сначала собирает программу). Скриншоты — в test-results/e2e.
// Данные программы пишутся во временную папку, настоящие сессии не затрагиваются.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron as electron } from 'playwright-core'
import { startTestServer, TEST_HOME, TEST_USER } from '../tests/helpers/sshServer.ts'

const root = resolve(fileURLToPath(import.meta.url), '../..')
const shots = join(root, 'test-results', 'e2e')
mkdirSync(shots, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'termion-e2e-'))
const sftpRoot = mkdtempSync(join(tmpdir(), 'termion-e2e-sftp-'))
const localDir = mkdtempSync(join(tmpdir(), 'termion-e2e-local-'))
const PASSWORD = 'e2e-secret-пароль'

let step = 0
const log = (msg) => console.log(`  ${String(++step).padStart(2, '0')}. ${msg}`)
const fail = (msg) => {
  throw new Error(msg)
}

// TERMION_E2E_EXE=dist/win-unpacked/Termion.exe — проверить собранную программу, а не версию для разработки.
const packagedExe = process.env.TERMION_E2E_EXE ? resolve(root, process.env.TERMION_E2E_EXE) : null

async function launch() {
  const app = await electron.launch({
    executablePath: packagedExe ?? electronPath,
    args: packagedExe ? [] : [root],
    cwd: root,
    env: { ...process.env, TERMION_DATA_DIR: dataDir, ELECTRON_ENABLE_LOGGING: '0' }
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.app', { timeout: 20_000 })
  return { app, win }
}

const shot = (win, name) => win.screenshot({ path: join(shots, `${name}.png`) })

async function waitStatus(win, text, timeout = 15_000) {
  await win.locator('.status', { hasText: text }).waitFor({ timeout })
}

async function waitServerLine(server, line, timeout = 10_000) {
  const start = Date.now()
  while (!server.lines.includes(line)) {
    if (Date.now() - start > timeout) fail(`сервер не получил строку «${line}»`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** HTML5-перетаскивание настоящими DOM-событиями (как у живого пользователя: с паузами). */
async function htmlDrag(win, sourceSelector, targetSelector) {
  await win.evaluate(
    async ([s, t]) => {
      const pause = () => new Promise((r) => setTimeout(r, 60))
      const src = document.querySelector(s)
      const dst = document.querySelector(t)
      if (!src || !dst) throw new Error('не найдены элементы для перетаскивания')
      const dt = new DataTransfer()
      const fire = (el, type) => {
        const r = el.getBoundingClientRect()
        el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }))
      }
      fire(src, 'dragstart')
      await pause()
      fire(dst, 'dragenter')
      fire(dst, 'dragover')
      await pause()
      fire(dst, 'dragover')
      await pause()
      fire(dst, 'drop')
      fire(src, 'dragend')
    },
    [sourceSelector, targetSelector]
  )
}

async function readJsonWhen(path, check, timeout = 5000) {
  const start = Date.now()
  for (;;) {
    let data = null
    try {
      data = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      // файл ещё не записан (настройки сохраняются с небольшой задержкой)
    }
    if (data && check(data)) return data
    if (Date.now() - start > timeout) return data ?? {}
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** Ждать, пока check() не станет true (опрос раз в 100 мс). */
async function until(check, message, timeout = 8000) {
  const start = Date.now()
  for (;;) {
    let ok = false
    try {
      ok = await check()
    } catch {
      ok = false
    }
    if (ok) return
    if (Date.now() - start > timeout) fail(typeof message === 'function' ? message() : message)
    await new Promise((r) => setTimeout(r, 100))
  }
}

const readText = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

async function waitFile(path, expected) {
  await until(
    () => readText(path) === expected,
    () => `${path}: ожидалось ${JSON.stringify(expected)}, на диске ${JSON.stringify(readText(path))}`
  )
}

/** Строка в Windows-1251 (только латиница и кириллица — для тестов достаточно). */
function cp1251(text) {
  return Buffer.from(
    Array.from(text, (ch) => {
      const c = ch.codePointAt(0)
      if (c < 0x80) return c
      if (c >= 0x410 && c <= 0x44f) return c - 0x410 + 0xc0
      if (c === 0x401) return 0xa8
      if (c === 0x451) return 0xb8
      throw new Error(`нет в cp1251: ${ch}`)
    })
  )
}

/** Файлы «сервера» для проверки дерева и редактора. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 1, 2, 3])
function seedServerFiles(server) {
  const put = (path, data) => {
    const real = server.real(path)
    mkdirSync(dirname(real), { recursive: true })
    writeFileSync(real, data)
  }
  put(`${TEST_HOME}/app/config.yml`, 'name: demo\r\nport: 8080\r\n')
  put(`${TEST_HOME}/app/legacy.txt`, cp1251('Привет, мир\r\n'))
  put(`${TEST_HOME}/app/logo.png`, PNG)
  put(`${TEST_HOME}/notes.txt`, 'notes\n')
  put(`${TEST_HOME}/.bashrc`, "alias ll='ls -l'\n")
  put('/etc/nginx/nginx.conf', 'user www-data;\n')
  put('/etc/nginx/conf.d/site.conf', 'server { listen 80; }\n')
  for (const name of ['a.txt', 'b.txt', 'c.txt']) put(`${TEST_HOME}/move/${name}`, `${name}\n`)
  mkdirSync(server.real(`${TEST_HOME}/move/sub`), { recursive: true })
  mkdirSync(server.real(`${TEST_HOME}/move/target`), { recursive: true })
  put(`${TEST_HOME}/zip/top.txt`, 'top\n')
  put(`${TEST_HOME}/zip/inner/deep.txt`, 'глубоко\n')
}

/** Начать перетаскивание строки дерева и вернуть ссылку для Проводника (DownloadURL). */
async function dragOutUrl(win, selector) {
  return win.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) throw new Error('нет строки ' + sel)
    const dt = new DataTransfer()
    const r = el.getBoundingClientRect()
    el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + 8, clientY: r.y + 8 }))
    const url = dt.getData('DownloadURL')
    el.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
    return url
  }, selector)
}

/** Скачать ссылку так же, как это делает Chromium, когда её отпускают в Проводнике. */
async function fetchLikeExplorer(app, link, target) {
  await app.evaluate(
    async ({ BrowserWindow, session }, { link, target }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents
      await new Promise((resolve, reject) => {
        session.defaultSession.once('will-download', (_e, item) => {
          item.setSavePath(target)
          item.once('done', (_e2, state) => (state === 'completed' ? resolve(undefined) : reject(new Error(`скачивание: ${state}`))))
        })
        wc.downloadURL(link)
      })
    },
    { link, target }
  )
}

async function typeInTerminal(win, text) {
  await win.locator('.term-view.active .xterm').click({ position: { x: 200, y: 120 } })
  await win.keyboard.type(text, { delay: 8 })
  await win.keyboard.press('Enter')
}

const server = await startTestServer({ password: PASSWORD, sftpRoot })
seedServerFiles(server)
console.log(`Тестовый SSH-сервер: 127.0.0.1:${server.port}; данные: ${dataDir}`)
console.log(`Программа: ${packagedExe ?? 'версия для разработки (out/)'}`)

try {
  // ---------- первый запуск ----------
  let { app, win } = await launch()
  await win.setViewportSize?.({ width: 1360, height: 840 }).catch(() => undefined)
  await win.locator('.empty h2', { hasText: 'Termion' }).waitFor()
  await shot(win, '01-empty')
  log('Первый запуск: пустой список и приветствие')

  await win.locator('.empty-actions button', { hasText: 'Новая сессия' }).click()
  await win.getByLabel('Название').fill('Тестовый сервер')
  await win.getByLabel('Адрес сервера').fill(`${TEST_USER}@127.0.0.1:${server.port}`)
  await win.getByLabel('Название').click() // уход с поля адреса разбирает user@host:port
  const port = await win.getByLabel('Порт').inputValue()
  const user = await win.getByLabel('Пользователь').inputValue()
  if (port !== String(server.port) || user !== TEST_USER) fail(`не разобран адрес: порт ${port}, пользователь ${user}`)
  await shot(win, '02-session-dialog')
  log('Окно новой сессии: «user@host:port» разобран на поля')

  await win.getByRole('button', { name: 'Сохранить и подключиться' }).click()
  await win.getByRole('button', { name: 'Доверять и подключиться' }).waitFor()
  await shot(win, '03-hostkey')
  await win.getByRole('button', { name: 'Доверять и подключиться' }).click()
  log('Вопрос о новом ключе сервера — подтверждён')

  await win.getByPlaceholder('пароль', { exact: true }).waitFor()
  await win.getByPlaceholder('пароль', { exact: true }).fill(PASSWORD)
  await shot(win, '04-password')
  await win.keyboard.press('Enter')
  await waitStatus(win, 'Подключено')
  log('Пароль принят, статус «Подключено»')

  await typeInTerminal(win, 'hello from termion')
  await waitServerLine(server, 'hello from termion')
  await typeInTerminal(win, 'привет, сервер')
  await waitServerLine(server, 'привет, сервер')
  log('Ввод в терминал доходит до сервера (латиница и кириллица)')

  await typeInTerminal(win, 'flood 3000000')
  await typeInTerminal(win, 'after flood')
  await waitServerLine(server, 'after flood', 30_000)
  await waitStatus(win, 'Подключено')
  await shot(win, '05-terminal')
  log('3 МБ вывода отрисованы, терминал отзывчив')

  // ---------- сведения о сервере ----------
  const meters = win.locator('.status .meters')
  await meters.waitFor({ timeout: 15_000 })
  await win.locator('.status .meters', { hasText: 'ЦП' }).waitFor()
  const metersText = await meters.innerText()
  if (!/ЦП\s*2[3-7]%/.test(metersText) || !metersText.includes('ОЗУ') || !metersText.includes('своб.')) fail(`индикаторы: ${metersText}`)
  await meters.click()
  const pop = win.locator('.srv-pop')
  await pop.locator('.srv-proc', { hasText: 'node' }).waitFor({ timeout: 15_000 })
  const popText = await pop.innerText()
  for (const expected of ['Ubuntu 24.04.1 LTS', 'Xeon', 'KVM', '/mnt/data backup', '203.0.113.10', 'nginx: worker', 'работает 3 дн · исправен']) {
    if (!popText.includes(expected)) fail(`в сводке о сервере нет «${expected}»`)
  }
  const procNames = await pop.locator('.srv-proc .pn').allInnerTexts()
  if (procNames.some((n) => n === 'sh' || n === 'cat')) fail(`в списке процессов виден сам сбор сведений: ${procNames}`)
  await shot(win, 'h1-server')
  await win.keyboard.press('Escape')
  await pop.waitFor({ state: 'detached' })
  log('Сведения о сервере: индикаторы в строке состояния и подробная сводка')

  // ---------- файлы данных ----------
  const sessions = JSON.parse(readFileSync(join(dataDir, 'sessions.json'), 'utf8'))
  if (sessions.tree[0]?.host !== '127.0.0.1' || sessions.tree[0]?.port !== server.port) fail('сессия не сохранена')
  const secretsRaw = readFileSync(join(dataDir, 'secrets.json'), 'utf8')
  if (secretsRaw.includes(PASSWORD)) fail('пароль лежит в secrets.json открытым текстом!')
  if (!Object.keys(JSON.parse(secretsRaw).sessions).length) fail('пароль не сохранён')
  const known = JSON.parse(readFileSync(join(dataDir, 'known_hosts.json'), 'utf8'))
  if (!Object.values(known.hosts)[0]?.[0]?.key) fail('ключ сервера не сохранён')
  log('sessions.json, known_hosts.json и зашифрованный secrets.json на месте')

  // ---------- файлы на сервере ----------
  const files = win.locator('.files')
  const row = (path) => files.locator(`.row[data-path="${path}"]`)
  const activeFileTab = win.locator('.tab.is-file.active')
  const dirtyMark = win.locator('.tab.is-file.active .tab-x.dirty')
  const editorLine = (text) => win.locator('.editor-view.active .cm-line', { hasText: text })
  const typeAtEnd = async (text) => {
    await win.locator('.editor-view.active .cm-content').click()
    await win.keyboard.press('Control+End')
    await win.keyboard.type(text)
    await dirtyMark.waitFor()
  }

  await row(`${TEST_HOME}/app`).waitFor({ timeout: 15_000 })
  if ((await row(`${TEST_HOME}/.bashrc`).count()) !== 1) fail('скрытые файлы не показаны')
  await row(`${TEST_HOME}/app`).click()
  await row(`${TEST_HOME}/app/config.yml`).waitFor()
  await shot(win, 'f1-files')
  log('Дерево файлов сервера: домашняя папка, папка раскрывается щелчком')

  await row(`${TEST_HOME}/app/config.yml`).dblclick()
  await editorLine('port: 8080').waitFor()
  await typeAtEnd('debug: true')
  await shot(win, 'f2-editor')
  await win.keyboard.press('Control+S')
  await waitFile(server.real(`${TEST_HOME}/app/config.yml`), 'name: demo\r\nport: 8080\r\ndebug: true')
  await dirtyMark.waitFor({ state: 'detached' })
  log('Редактор: файл открыт, изменён и сохранён по Ctrl+S, окончания строк CRLF сохранены')

  const cfgPath = server.real(`${TEST_HOME}/app/config.yml`)
  writeFileSync(cfgPath, 'changed on server\n')
  const later = new Date(Date.now() + 120_000)
  utimesSync(cfgPath, later, later)
  await typeAtEnd('!')
  await win.keyboard.press('Control+S')
  await win.locator('.modal', { hasText: 'Файл изменён на сервере' }).waitFor()
  await shot(win, 'f3-conflict')
  await win.getByRole('button', { name: 'Перезаписать' }).click()
  await waitFile(cfgPath, 'name: demo\r\nport: 8080\r\ndebug: true!')
  await dirtyMark.waitFor({ state: 'detached' })
  log('Файл изменили на сервере — при сохранении вопрос, «Перезаписать» работает')

  await row(`${TEST_HOME}/app/legacy.txt`).dblclick()
  await editorLine('Привет, мир').waitFor()
  await win.locator('.status', { hasText: 'Windows-1251' }).waitFor()
  await win.locator('.status', { hasText: 'CRLF' }).waitFor()
  await typeAtEnd('Пока')
  await win.keyboard.press('Control+S')
  const legacyPath = server.real(`${TEST_HOME}/app/legacy.txt`)
  const legacyText = () => new TextDecoder('windows-1251').decode(readFileSync(legacyPath))
  await until(() => legacyText() === 'Привет, мир\r\nПока', () => `legacy.txt сохранён неверно: ${JSON.stringify(legacyText())}`)
  log('Файл в Windows-1251: кириллица прочитана и сохранена в той же кодировке')

  await row(`${TEST_HOME}/app/logo.png`).dblclick()
  await win.locator('.editor-view.active .ed-overlay', { hasText: 'двоичный файл' }).waitFor()
  const savedPng = join(localDir, 'logo.png')
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
  }, savedPng)
  await win.locator('.editor-view.active .ed-overlay button', { hasText: 'Скачать' }).click()
  await until(() => existsSync(savedPng) && readFileSync(savedPng).equals(PNG), 'logo.png не скачан')
  await files.locator('.xfer.done').first().waitFor()
  await shot(win, 'f4-download')
  await win.keyboard.press('Control+Shift+W')
  await win.locator('.tab.is-file', { hasText: 'logo.png' }).waitFor({ state: 'detached' })
  log('Двоичный файл не открывается как текст; скачивание на компьютер — «Готово»')

  await row(`${TEST_HOME}/app/config.yml`).click()
  await files.locator('button[title="Новый файл"]').click()
  await files.locator('.inline-input').waitFor()
  await win.keyboard.type('hello.sh')
  await win.keyboard.press('Enter')
  await activeFileTab.filter({ hasText: 'hello.sh' }).waitFor()
  await win.locator('.editor-view.active .cm-content').click()
  await win.keyboard.type('echo hi')
  await dirtyMark.waitFor()
  await win.keyboard.press('Control+S')
  await waitFile(server.real(`${TEST_HOME}/app/hello.sh`), 'echo hi')
  log('Новый файл создан из дерева и сразу открыт в редакторе')

  await row(`${TEST_HOME}/app/hello.sh`).click()
  await win.keyboard.press('F2')
  await files.locator('.inline-input').waitFor()
  await win.keyboard.press('Control+A')
  await win.keyboard.type('run.sh')
  await win.keyboard.press('Enter')
  await row(`${TEST_HOME}/app/run.sh`).waitFor()
  if (existsSync(server.real(`${TEST_HOME}/app/hello.sh`))) fail('после переименования осталось старое имя')
  await win.locator('.tab.is-file', { hasText: 'run.sh' }).waitFor()
  log('Переименование (F2): файл на сервере и вкладка редактора получили новое имя')

  await row(`${TEST_HOME}/app/run.sh`).click()
  await win.keyboard.press('Delete')
  await win.locator('.modal', { hasText: 'Удалить файл?' }).waitFor()
  await win.locator('.modal').getByRole('button', { name: 'Удалить' }).click()
  await row(`${TEST_HOME}/app/run.sh`).waitFor({ state: 'detached' })
  if (existsSync(server.real(`${TEST_HOME}/app/run.sh`))) fail('файл не удалён')
  await win.locator('.tab.is-file', { hasText: 'run.sh' }).waitFor({ state: 'detached' })
  log('Удаление (Del) с подтверждением; вкладка удалённого файла закрыта')

  const localFile = join(localDir, 'upload me.txt')
  writeFileSync(localFile, 'uploaded content')
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths })
  }, [localFile])
  await files.locator('button[title="Загрузить файлы на сервер"]').click()
  await waitFile(server.real(`${TEST_HOME}/upload me.txt`), 'uploaded content')
  await row(`${TEST_HOME}/upload me.txt`).waitFor()
  log('Загрузка с компьютера: файл на сервере и сразу в дереве')

  await win.locator('.tab.is-term').click()
  await typeInTerminal(win, 'cd /etc/nginx')
  await files.locator('.crumb.last', { hasText: 'nginx' }).waitFor()
  await row('/etc/nginx/nginx.conf').waitFor()
  await row('/etc/nginx/conf.d').click({ button: 'right' })
  await win.locator('.ctx-item', { hasText: 'Перейти сюда в терминале' }).click()
  await waitServerLine(server, 'cd /etc/nginx/conf.d')
  await row('/etc/nginx/conf.d/site.conf').waitFor()
  await shot(win, 'f5-follow')
  log('Дерево следует за папкой терминала; «Перейти сюда в терминале» отправляет cd')

  await row('/etc/nginx/conf.d/site.conf').dblclick()
  await editorLine('listen 80').waitFor()
  await typeAtEnd('# note')
  await win.keyboard.press('Control+Shift+W')
  await win.locator('.modal', { hasText: 'Сохранить изменения?' }).waitFor()
  await win.locator('.modal').getByRole('button', { name: 'Отмена' }).click()
  await dirtyMark.waitFor()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await win.locator('.modal', { hasText: 'Сохранить изменения перед выходом?' }).waitFor()
  await shot(win, 'f6-close-app')
  await win.locator('.modal').getByRole('button', { name: 'Отмена' }).click()
  await win.waitForTimeout(400)
  if (win.isClosed()) fail('окно закрылось, хотя нажата «Отмена»')
  log('Несохранённый файл: вопрос при закрытии вкладки и при выходе из программы')

  await win.keyboard.press('Control+Shift+W')
  await win.locator('.modal', { hasText: 'Сохранить изменения?' }).waitFor()
  await win.locator('.modal').getByRole('button', { name: 'Сохранить', exact: true }).click()
  await waitFile(server.real('/etc/nginx/conf.d/site.conf'), 'server { listen 80; }\n# note')
  await win.locator('.tab.is-file', { hasText: 'site.conf' }).waitFor({ state: 'detached' })
  log('«Сохранить» в окне закрытия вкладки: файл записан, вкладка закрыта')
  await win.locator('.tab.is-term').click()

  // ---------- выделение, перемещение, перетаскивание в Проводник ----------
  const moveDir = `${TEST_HOME}/move`
  const rowSel = (path) => `.files .row[data-path="${path}"]`
  await files.locator('button[title^="Домашняя папка"]').click()
  await row(moveDir).waitFor()
  await row(moveDir).click()
  await row(`${moveDir}/a.txt`).waitFor()
  await row(`${moveDir}/a.txt`).click()
  await row(`${moveDir}/b.txt`).click({ modifiers: ['Control'] })
  await files.locator('.sel-bar', { hasText: 'Выделено: 2' }).waitFor()
  await row(`${moveDir}/c.txt`).click({ modifiers: ['Shift'] })
  const selectedNow = await files.locator('.row.selected').evaluateAll((els) => els.map((el) => el.getAttribute('data-path')))
  if (selectedNow.join(',') !== `${moveDir}/b.txt,${moveDir}/c.txt`) fail(`Shift+щелчок выделил не то: ${selectedNow}`)
  await shot(win, 'g1-multiselect')
  log('Выделение нескольких файлов: Ctrl+щелчок и Shift+щелчок, строка «Выделено: 2»')

  await htmlDrag(win, rowSel(`${moveDir}/b.txt`), rowSel(`${moveDir}/target`))
  await win.locator('.modal', { hasText: 'Переместить 2 объекта?' }).waitFor()
  await shot(win, 'g2-move-dialog')
  await win.locator('.modal').getByRole('button', { name: 'Переместить' }).click()
  await waitFile(server.real(`${moveDir}/target/b.txt`), 'b.txt\n')
  await waitFile(server.real(`${moveDir}/target/c.txt`), 'c.txt\n')
  if (existsSync(server.real(`${moveDir}/b.txt`))) fail('после перемещения файл остался на старом месте')
  await row(`${moveDir}/target/c.txt`).waitFor()
  log('Перетаскивание внутри дерева: 2 файла перемещены в папку (с подтверждением)')

  await htmlDrag(win, rowSel(`${moveDir}/a.txt`), rowSel(`${moveDir}/sub`))
  await win.locator('.modal', { hasText: 'Переместить?' }).waitFor()
  await win.locator('.modal').getByLabel('Больше не спрашивать').check()
  await win.locator('.modal').getByRole('button', { name: 'Переместить' }).click()
  await waitFile(server.real(`${moveDir}/sub/a.txt`), 'a.txt\n')
  await row(`${moveDir}/sub`).waitFor()
  await htmlDrag(win, rowSel(`${moveDir}/sub`), rowSel(`${moveDir}/target`))
  await waitFile(server.real(`${moveDir}/target/sub/a.txt`), 'a.txt\n')
  if (await win.locator('.modal').count()) fail('после «Больше не спрашивать» снова появился вопрос')
  const afterMoves = await readJsonWhen(join(dataDir, 'settings.json'), (d) => d.files?.confirmMove === false)
  if (afterMoves.files?.confirmMove !== false) fail('настройка «не спрашивать» не сохранилась')
  log('«Больше не спрашивать»: папка перемещена сразу, настройка сохранена')

  await row(`${moveDir}/target/b.txt`).click()
  await row(`${moveDir}/target/c.txt`).click({ modifiers: ['Control'] })
  await win.keyboard.press('Delete')
  await win.locator('.modal', { hasText: 'Удалить 2 объекта?' }).waitFor()
  await win.locator('.modal').getByRole('button', { name: 'Удалить' }).click()
  await row(`${moveDir}/target/b.txt`).waitFor({ state: 'detached' })
  if (existsSync(server.real(`${moveDir}/target/b.txt`)) || existsSync(server.real(`${moveDir}/target/c.txt`))) fail('файлы не удалены')
  log('Удаление нескольких выделенных файлов одним подтверждением')

  const fileUrl = await dragOutUrl(win, rowSel(`${TEST_HOME}/notes.txt`))
  const [fileMime, fileName, ...fileRest] = fileUrl.split(':')
  if (fileMime !== 'application/octet-stream' || fileName !== 'notes.txt') fail(`ссылка для Проводника: ${fileUrl}`)
  await new Promise((r) => setTimeout(r, 300))
  const outFile = join(localDir, 'dragged-notes.txt')
  await fetchLikeExplorer(app, fileRest.join(':'), outFile)
  if (readFileSync(outFile, 'utf8') !== 'notes\n') fail('перетащенный в Проводник файл не совпадает')
  await files.locator('.xfer.done', { hasText: 'Передано в Проводник' }).first().waitFor()
  log('Перетаскивание файла в Проводник: ссылка DownloadURL, файл скачивается как есть')

  const zipUrl = await dragOutUrl(win, rowSel(`${TEST_HOME}/zip`))
  const [zipMime, zipName, ...zipRest] = zipUrl.split(':')
  if (zipMime !== 'application/zip' || zipName !== 'zip.zip') fail(`ссылка для папки: ${zipUrl}`)
  await new Promise((r) => setTimeout(r, 300))
  const outZip = join(localDir, 'dragged.zip')
  await fetchLikeExplorer(app, zipRest.join(':'), outZip)
  const unpacked = join(localDir, 'unzipped')
  mkdirSync(unpacked)
  execFileSync('C:\\Windows\\System32\\tar.exe', ['-xf', outZip, '-C', unpacked])
  if (readFileSync(join(unpacked, 'zip', 'inner', 'deep.txt'), 'utf8') !== 'глубоко\n') fail('в архиве папки не то содержимое')
  await shot(win, 'g3-dragout')
  log('Перетаскивание папки в Проводник: zip-архив с вложенными папками')

  // ---------- повторное подключение без вопросов ----------
  await win.keyboard.press('Control+Shift+W')
  await win.locator('.empty').waitFor()
  await win.locator('.row.sess', { hasText: 'Тестовый сервер' }).dblclick()
  await waitStatus(win, 'Подключено')
  if (await win.locator('.overlay').count()) fail('при повторном подключении появился вопрос')
  log('Повторное подключение: ни одного вопроса (ключ и пароль запомнены)')

  // ---------- папки, меню, темы ----------
  await win.locator('.sessions .ph-actions button[title="Новая папка"]').click()
  await win.getByLabel('Название').fill('Продакшн')
  await win.getByRole('button', { name: 'Создать' }).click()
  await win.locator('.row.folder', { hasText: 'Продакшн' }).waitFor()
  await htmlDrag(win, '.row.sess', '.row.folder')
  const inFolder = (data) => data.tree.find((n) => n.type === 'folder')?.children?.[0]?.name === 'Тестовый сервер'
  const afterDrag = await readJsonWhen(join(dataDir, 'sessions.json'), inFolder)
  if (!inFolder(afterDrag)) fail('перетаскивание сессии в папку не сработало')
  if (afterDrag.tree.length !== 1) fail('после перетаскивания сессия осталась и в корне')
  log('Папка создана, сессия перетащена в неё (сохранено в sessions.json)')

  // Перетаскивание обратно в корень — на пустое место под деревом.
  await htmlDrag(win, '.row.sess', '.sessions .tree')
  const atRoot = (data) => data.tree.some((n) => n.type === 'session')
  if (!atRoot(await readJsonWhen(join(dataDir, 'sessions.json'), atRoot))) fail('перетаскивание в корень не сработало')
  await htmlDrag(win, '.row.sess', '.row.folder')
  if (!inFolder(await readJsonWhen(join(dataDir, 'sessions.json'), inFolder))) fail('повторное перетаскивание в папку не сработало')
  log('Перетаскивание обратно в корень и снова в папку')

  await win.locator('.row.sess', { hasText: 'Тестовый сервер' }).click({ button: 'right' })
  await win.locator('.ctx').waitFor()
  await shot(win, '06-context-menu')
  await win.keyboard.press('Escape')
  log('Контекстное меню сессии')

  await win.keyboard.press('Control+Comma')
  await win.locator('.modal', { hasText: 'Настройки' }).waitFor()
  await shot(win, '07-settings')
  await win.locator('.card', { hasText: 'Классика' }).first().click()
  await win.locator('.card', { hasText: 'Как в MobaXterm' }).click()
  await win.getByRole('button', { name: 'Готово' }).click()
  await shot(win, '08-classic')
  await win.keyboard.press('Control+Comma')
  await win.locator('.card', { hasText: 'Светлая' }).first().click()
  await win.locator('.card', { hasText: 'Файлы справа' }).click()
  await win.getByRole('button', { name: 'Готово' }).click()
  await shot(win, '09-light')
  log('Темы и раскладки переключаются на лету')

  // ---------- закрытие и повторный запуск ----------
  await win.keyboard.press('Control+Shift+W')
  await win.locator('.empty').waitFor()
  await app.close()
  const settings = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'))
  if (settings.theme !== 'light' || settings.layout !== 'ide') fail(`настройки не сохранились: ${settings.theme}/${settings.layout}`)
  if (!existsSync(join(dataDir, 'window-state.json'))) fail('не сохранено положение окна')
  log('Закрытие: настройки и положение окна сохранены')

  ;({ app, win } = await launch())
  await win.locator('.row.sess', { hasText: 'Тестовый сервер' }).waitFor()
  await win.locator('.row.sess', { hasText: 'Тестовый сервер' }).dblclick()
  await waitStatus(win, 'Подключено')
  await typeInTerminal(win, 'second launch')
  await waitServerLine(server, 'second launch')
  await shot(win, '10-relaunch')
  log('Повторный запуск: сессия на месте, подключение без вопросов')

  // Обратно в графит, чтобы финальный скриншот был в основной теме.
  await win.keyboard.press('Control+Comma')
  await win.locator('.card', { hasText: 'Графит' }).first().click()
  await win.locator('.card', { hasText: 'Слева стопкой' }).click()
  await win.getByRole('button', { name: 'Готово' }).click()
  await shot(win, '11-graphite')
  await win.keyboard.press('Control+Shift+W')
  await app.close()
  console.log('\nE2E: все проверки пройдены ✔')
} catch (err) {
  console.error('\nE2E: ОШИБКА —', err.message)
  process.exitCode = 1
} finally {
  await server.close()
  for (const dir of [dataDir, sftpRoot, localDir]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      console.warn(`Не удалось убрать временную папку (программа ещё держит файлы): ${dir}`)
    }
  }
}
