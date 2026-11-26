// Терминалы компьютера в интерфейсе: значки и общее меню «новая вкладка».

import type { LocalShell, ShellKind } from '@shared/types'
import { currentFolderId } from '../hooks/useShortcuts'
import { defaultShell, openDialog, openLocal } from '../store/actions'
import { getState, type MenuEntry } from '../store/app'
import type { IconName } from './Icon'

export function shellIcon(kind: ShellKind): { icon: IconName; tone: string } {
  switch (kind) {
    case 'pwsh':
    case 'powershell':
      return { icon: 'term', tone: 'ft-blue' }
    case 'cmd':
      return { icon: 'term', tone: 'ft-dim' }
    case 'gitbash':
      return { icon: 'git', tone: 'ft-red' }
    case 'wsl':
      return { icon: 'linux', tone: 'ft-yellow' }
    default:
      return { icon: 'term', tone: 'ft-green' }
  }
}

/** Пункт меню для оболочки. */
function shellItem(shell: LocalShell, isDefault: boolean): MenuEntry {
  const { icon, tone } = shellIcon(shell.kind)
  return {
    label: shell.name,
    icon,
    iconClass: tone,
    hint: isDefault ? 'Ctrl+Shift+T' : shell.kind === 'wsl' ? 'WSL' : undefined,
    onSelect: () => openLocal(shell.id)
  }
}

/** Меню кнопки «+»: терминалы компьютера и новое SSH-подключение. */
export function newTabMenu(): MenuEntry[] {
  const shells = getState().shells
  const def = defaultShell()
  return [
    ...shells.map((sh) => shellItem(sh, sh.id === def?.id)),
    ...(shells.length ? (['separator'] as MenuEntry[]) : []),
    {
      label: 'SSH-подключение…',
      icon: 'server',
      hint: 'Ctrl+Shift+N',
      onSelect: () => openDialog({ type: 'session', editId: null, parentId: currentFolderId() })
    }
  ]
}
