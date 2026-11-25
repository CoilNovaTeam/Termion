// Генерирует значки из build/icon.svg силами Chromium внутри Electron:
//   build/icon.ico      — многоразмерный значок для Termion.exe
//   build/icon.png      — 512×512 для установщика
//   resources/icon.png  — 256×256 для окна
// Запуск: npm run icons

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'))
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]

function buildIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = 6 + 16 * images.length
  const entries = images.map(({ size, png }) => {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0)
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt8(0, 2)
    e.writeUInt8(0, 3)
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(png.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += png.length
    return e
  })
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)])
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 600, height: 600, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html,<!doctype html><html><body></body></html>')
  const src = 'data:image/svg+xml;base64,' + svg.toString('base64')
  const render = async (size) => {
    const dataUrl = await win.webContents.executeJavaScript(`(async () => {
      const img = new Image();
      img.src = ${JSON.stringify(src)};
      await img.decode();
      const c = document.createElement('canvas');
      c.width = ${size}; c.height = ${size};
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, ${size}, ${size});
      return c.toDataURL('image/png');
    })()`)
    return Buffer.from(dataUrl.split(',')[1], 'base64')
  }
  const images = []
  for (const size of ICO_SIZES) images.push({ size, png: await render(size) })
  fs.mkdirSync(path.join(root, 'resources'), { recursive: true })
  fs.writeFileSync(path.join(root, 'build', 'icon.ico'), buildIco(images))
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), await render(512))
  fs.writeFileSync(path.join(root, 'resources', 'icon.png'), await render(256))
  console.log('Значки созданы:', ICO_SIZES.join(', '), '+ 512')
  app.quit()
})
