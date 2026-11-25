import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const shared = resolve(__dirname, 'src/shared')

/**
 * В режиме разработки Vite встраивает в страницу скрипт горячей перезагрузки React
 * и подключается к dev-серверу по WebSocket. Только для `npm run dev` ослабляем CSP;
 * в собранной программе политика остаётся строгой.
 */
function devCsp(): Plugin {
  return {
    name: 'termion-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html
        .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        .replace("connect-src 'self'", "connect-src 'self' ws://localhost:* http://localhost:*")
    }
  }
}

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } },
    build: { sourcemap: true }
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
    build: { sourcemap: true }
  },
  renderer: {
    resolve: {
      alias: {
        '@shared': shared,
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    },
    plugins: [react(), devCsp()],
    build: { sourcemap: true }
  }
})
