import type { CSSProperties } from 'react'
import { useShortcuts } from '../hooks/useShortcuts'
import { useApp } from '../store/app'
import { ContextMenu } from './ContextMenu'
import { DialogHost } from './dialogs/DialogHost'
import { FilesPanel } from './FilesPanel'
import { ServerPanel } from './ServerPanel'
import { Rail, Toolbar } from './Toolbar'
import { SessionsPanel } from './SessionsPanel'
import { Splitter } from './Splitter'
import { StatusBar } from './StatusBar'
import { TitleBar } from './TitleBar'
import { Toasts } from './Toasts'
import { Workspace } from './Workspace'

export function App() {
  const ready = useApp((s) => s.ready)
  const layout = useApp((s) => s.settings.layout)
  const side = useApp((s) => s.side)
  const sidebarWidth = useApp((s) => s.settings.sidebarWidth)
  useShortcuts()

  if (!ready) return <div className="boot" />

  return (
    <div className="app" data-layout={layout} data-side={side} style={{ '--left-w': `${sidebarWidth}px` } as CSSProperties}>
      <TitleBar />
      <Toolbar />
      <Rail />
      <SessionsPanel />
      <FilesPanel />
      <Workspace />
      <StatusBar />
      <Splitter />
      <ServerPanel />
      <DialogHost />
      <ContextMenu />
      <Toasts />
    </div>
  )
}
