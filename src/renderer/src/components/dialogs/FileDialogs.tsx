// Окна про файлы: несохранённые изменения, конфликт при сохранении, выход из программы.

import { useState } from 'react'
import { resolveAppClose } from '../../store/actions'
import { isEditor, useApp, type EditorTab } from '../../store/app'
import { resolveConflict, resolveUnsaved } from '../../store/editors'
import { resolveMove } from '../../store/files'
import { plural } from '../../format'
import { Modal } from './Modal'

function useEditors(ids: string[]): EditorTab[] {
  const tabs = useApp((s) => s.tabs)
  return ids.map((id) => tabs.find((t) => t.id === id)).filter(isEditor)
}

function FileList({ items }: { items: EditorTab[] }) {
  return (
    <ul className="file-list">
      {items.map((t) => (
        <li key={t.id} title={t.path}>
          <b>{t.title}</b>
          <span className="mono">{t.path}</span>
        </li>
      ))}
    </ul>
  )
}

export function UnsavedDialog({ dirtyIds }: { dirtyIds: string[] }) {
  const items = useEditors(dirtyIds)
  const [busy, setBusy] = useState(false)
  const run = async (choice: 'save' | 'discard' | 'cancel') => {
    setBusy(true)
    try {
      await resolveUnsaved(choice)
    } finally {
      setBusy(false)
    }
  }
  const one = items.length === 1
  return (
    <Modal
      title={one ? 'Сохранить изменения?' : 'Сохранить изменения в файлах?'}
      icon="save"
      tone="warning"
      width={480}
      onCancel={() => void run('cancel')}
      footer={
        <>
          <button className="btn danger-text left" disabled={busy} onClick={() => void run('discard')}>
            Не сохранять
          </button>
          <button className="btn" disabled={busy} onClick={() => void run('cancel')}>
            Отмена
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void run('save')} data-autofocus>
            {busy ? 'Сохранение…' : 'Сохранить'}
          </button>
        </>
      }
    >
      {one ? (
        <p className="mtext">
          Файл <b className="mono">{items[0]?.title}</b> изменён. Сохранить его на сервере перед закрытием?
        </p>
      ) : (
        <>
          <p className="mtext">Эти файлы изменены и ещё не сохранены на сервере:</p>
          <FileList items={items} />
        </>
      )}
    </Modal>
  )
}

export function ConflictDialog({ tabId, conflict }: { tabId: string; conflict: 'changed' | 'deleted' }) {
  const tab = useApp((s) => s.tabs.find((t) => t.id === tabId))
  if (!isEditor(tab)) return null
  const changed = conflict === 'changed'
  return (
    <Modal
      title={changed ? 'Файл изменён на сервере' : 'Файл удалён на сервере'}
      icon="warn"
      tone="warning"
      width={500}
      onCancel={() => resolveConflict(tabId, 'cancel')}
      footer={
        <>
          {changed && (
            <button className="btn left" onClick={() => resolveConflict(tabId, 'reload')}>
              Загрузить с сервера
            </button>
          )}
          <button className="btn" onClick={() => resolveConflict(tabId, 'cancel')}>
            Отмена
          </button>
          <button className="btn primary" onClick={() => resolveConflict(tabId, 'overwrite')} data-autofocus>
            {changed ? 'Перезаписать' : 'Сохранить заново'}
          </button>
        </>
      }
    >
      {changed ? (
        <>
          <p className="mtext">
            Пока файл <b className="mono">{tab.title}</b> был открыт, его изменили на сервере — другой программой или человеком.
          </p>
          <p className="mtext">
            <b>Перезаписать</b> — сохранить ваш текст, изменения на сервере пропадут. <b>Загрузить с сервера</b> — открыть новую
            версию, ваши несохранённые правки пропадут.
          </p>
        </>
      ) : (
        <p className="mtext">
          Файл <b className="mono">{tab.path}</b> удалили на сервере, пока он был открыт. Сохранить — значит создать его заново с
          вашим текстом.
        </p>
      )}
    </Modal>
  )
}

export function CloseAppDialog({ connections, locals, dirtyIds }: { connections: number; locals: number; dirtyIds: string[] }) {
  const items = useEditors(dirtyIds)
  const [busy, setBusy] = useState(false)
  const run = async (choice: 'save' | 'discard' | 'cancel') => {
    setBusy(true)
    try {
      await resolveAppClose(choice)
    } finally {
      setBusy(false)
    }
  }
  const dirty = items.length > 0
  const conn = connections > 0 && (
    <p className="mtext">
      {connections === 1 ? 'Открыто подключение к серверу' : `Открыто ${connections} ${plural(connections, 'подключение', 'подключения', 'подключений')} к серверам`}
      {' — '}
      {connections === 1 ? 'оно будет закрыто' : 'они будут закрыты'}. Программы, запущенные в терминале без nohup, screen или tmux,
      остановятся.
    </p>
  )
  const localText = locals > 0 && (
    <p className="mtext">
      {locals === 1 ? 'Открыт терминал компьютера' : `Открыто ${locals} ${plural(locals, 'терминал', 'терминала', 'терминалов')} компьютера`}
      {' — '}
      запущенные в {locals === 1 ? 'нём' : 'них'} программы будут закрыты.
    </p>
  )
  return (
    <Modal
      title={dirty ? 'Сохранить изменения перед выходом?' : 'Закрыть Termion?'}
      icon={dirty ? 'save' : 'info'}
      tone="warning"
      width={500}
      onCancel={() => void run('cancel')}
      footer={
        dirty ? (
          <>
            <button className="btn danger-text left" disabled={busy} onClick={() => void run('discard')}>
              Выйти без сохранения
            </button>
            <button className="btn" disabled={busy} onClick={() => void run('cancel')}>
              Отмена
            </button>
            <button className="btn primary" disabled={busy} onClick={() => void run('save')} data-autofocus>
              {busy ? 'Сохранение…' : 'Сохранить и выйти'}
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={() => void run('cancel')}>
              Отмена
            </button>
            <button className="btn danger" onClick={() => void run('discard')} data-autofocus>
              Закрыть
            </button>
          </>
        )
      }
    >
      {dirty && (
        <>
          <p className="mtext">{items.length === 1 ? 'Этот файл изменён и не сохранён на сервере:' : 'Эти файлы изменены и не сохранены на сервере:'}</p>
          <FileList items={items} />
        </>
      )}
      {conn}
      {localText}
    </Modal>
  )
}

export function MoveDialog({ paths, dir }: { paths: string[]; dir: string }) {
  const [dontAsk, setDontAsk] = useState(false)
  const name = (p: string) => p.slice(p.lastIndexOf('/') + 1)
  const one = paths.length === 1
  return (
    <Modal
      title={one ? 'Переместить?' : `Переместить ${paths.length} ${plural(paths.length, 'объект', 'объекта', 'объектов')}?`}
      icon="folder"
      width={480}
      onCancel={() => resolveMove(false, false)}
      footer={
        <>
          <label className="check left">
            <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
            Больше не спрашивать
          </label>
          <button className="btn" onClick={() => resolveMove(false, false)}>
            Отмена
          </button>
          <button className="btn primary" onClick={() => resolveMove(true, dontAsk)} data-autofocus>
            Переместить
          </button>
        </>
      }
    >
      <p className="mtext">
        {one ? (
          <>
            <b className="mono">{name(paths[0])}</b> будет перемещён в папку <b className="mono">{dir}</b>.
          </>
        ) : (
          <>
            В папку <b className="mono">{dir}</b> будут перемещены:
          </>
        )}
      </p>
      {!one && (
        <ul className="file-list">
          {paths.map((p) => (
            <li key={p} title={p}>
              <b>{name(p)}</b>
              <span className="mono">{p}</span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
