import { useApp } from '../../store/app'
import { ConfirmDialog } from './ConfirmDialog'
import { CloseAppDialog, ConflictDialog, MoveDialog, UnsavedDialog } from './FileDialogs'
import { FolderDialog } from './FolderDialog'
import { PromptDialog } from './PromptDialog'
import { SessionDialog } from './SessionDialog'
import { SettingsDialog } from './SettingsDialog'

export function DialogHost() {
  const dialog = useApp((s) => s.dialog)
  const prompt = useApp((s) => s.prompts[0])
  return (
    <>
      {dialog?.type === 'session' && <SessionDialog key={`s-${dialog.editId}`} editId={dialog.editId} parentId={dialog.parentId} />}
      {dialog?.type === 'folder' && <FolderDialog key={`f-${dialog.editId}`} editId={dialog.editId} parentId={dialog.parentId} />}
      {dialog?.type === 'confirm' && <ConfirmDialog {...dialog} />}
      {dialog?.type === 'settings' && <SettingsDialog />}
      {dialog?.type === 'unsaved' && <UnsavedDialog dirtyIds={dialog.dirtyIds} />}
      {dialog?.type === 'conflict' && <ConflictDialog key={`c-${dialog.tabId}`} tabId={dialog.tabId} conflict={dialog.conflict} />}
      {dialog?.type === 'close-app' && <CloseAppDialog connections={dialog.connections} dirtyIds={dialog.dirtyIds} />}
      {dialog?.type === 'move' && <MoveDialog key={dialog.paths.join('|')} paths={dialog.paths} dir={dialog.dir} />}
      {/* Вопросы от SSH — поверх любых окон: подключение ждёт ответа. */}
      {prompt && <PromptDialog key={prompt.promptId} prompt={prompt} />}
    </>
  )
}
