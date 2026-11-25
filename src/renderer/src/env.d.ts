/// <reference types="vite/client" />

import type { TermionApi } from '@shared/api'

declare global {
  interface Window {
    termion: TermionApi
  }
}

export {}
