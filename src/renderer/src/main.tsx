// В отрисовке Chromium начертание 400 у этих шрифтов выглядит почти жирным,
// поэтому обычный текст — 300, жирный — 600 (так же, как выглядит Windows Terminal).
import '@fontsource/cascadia-mono/300.css'
import '@fontsource/cascadia-mono/600.css'
import '@fontsource/jetbrains-mono/300.css'
import '@fontsource/jetbrains-mono/600.css'
import '@xterm/xterm/css/xterm.css'
import './styles/themes.css'
import './styles/app.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { errorText } from './api'
import { App } from './components/App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { init } from './store/actions'

const root = createRoot(document.getElementById('root') as HTMLElement)
root.render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)

init().catch((err) => {
  root.render(<ErrorBoundary fatal={`Не удалось загрузить данные: ${errorText(err)}`} />)
})
