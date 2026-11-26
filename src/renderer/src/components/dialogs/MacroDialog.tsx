// Окно макроса: название, команды, где показывать, горячая клавиша.

import { useMemo, useState, type FormEvent, type KeyboardEvent } from 'react'
import { hotkeyOf, hotkeyProblem } from '@shared/hotkeys'
import { folders, walk } from '@shared/tree'
import type { MacroScope, SessionNode } from '@shared/types'
import { MACRO_DELAYS, normalizeName } from '@shared/validate'
import { errorText } from '../../api'
import { closeDialog, toast } from '../../store/actions'
import { useApp } from '../../store/app'
import { askDeleteMacro, saveMacro } from '../../store/macros'
import { Icon } from '../Icon'
import { Modal } from './Modal'

const scopeValue = (s: MacroScope) => (s.type === 'all' || s.type === 'local' ? s.type : `${s.type}:${s.id}`)

function parseScope(v: string): MacroScope {
  if (v === 'local') return { type: 'local' }
  const [type, id] = v.split(':')
  if ((type === 'folder' || type === 'session') && id) return { type, id }
  return { type: 'all' }
}

const delayLabel = (ms: number) => (ms ? `${String(ms / 1000).replace('.', ',')} с` : 'без пауз')

/** Поле горячей клавиши: нажмите сочетание — оно запишется. Backspace — очистить. */
function HotkeyInput({ value, onChange, error }: { value: string; onChange: (v: string) => void; error: string | null }) {
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab' || e.key === 'Escape') return
    e.preventDefault()
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey) {
      onChange('')
      return
    }
    const hk = hotkeyOf(e)
    if (hk) onChange(hk)
  }
  return (
    <div className="pw">
      <input
        className={`mono hotkey${error ? ' bad' : ''}`}
        value={value}
        readOnly
        placeholder="нажмите сочетание, например Ctrl+Alt+1"
        onKeyDown={onKeyDown}
        aria-label="Горячая клавиша"
      />
      {value && (
        <button type="button" className="icon-btn" style={{ width: 32, height: 32 }} title="Убрать горячую клавишу" onClick={() => onChange('')}>
          <Icon name="x" />
        </button>
      )}
    </div>
  )
}

export function MacroDialog({ editId, scope: scopeHint }: { editId: string | null; scope?: MacroScope }) {
  const macros = useApp((s) => s.macros)
  const tree = useApp((s) => s.tree)
  const existing = editId ? macros.find((m) => m.id === editId) : undefined
  const folderList = useMemo(() => folders(tree), [tree])
  const sessionList = useMemo(() => {
    const out: SessionNode[] = []
    walk(tree, (n) => {
      if (n.type === 'session') out.push(n)
    })
    return out
  }, [tree])

  const [name, setName] = useState(existing?.name ?? '')
  const [commands, setCommands] = useState(existing?.commands ?? '')
  const [enter, setEnter] = useState(existing?.enter ?? true)
  const [delay, setDelay] = useState(existing?.delay ?? 0)
  const [scope, setScope] = useState(scopeValue(existing?.scope ?? scopeHint ?? { type: 'all' }))
  const [hotkey, setHotkey] = useState(existing?.hotkey ?? '')
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)

  const nameError = !normalizeName(name) ? 'Введите название' : null
  const commandsError = !commands.trim() ? 'Добавьте хотя бы одну команду' : null
  const taken = hotkey ? macros.find((m) => m.id !== editId && m.hotkey === hotkey) : undefined
  const hotkeyError = hotkey ? (hotkeyProblem(hotkey) ?? (taken ? `Это сочетание уже у макроса «${taken.name}»` : null)) : null
  const lines = commands.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim()).length

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    setTouched(true)
    if (nameError || commandsError || hotkeyError) return
    setBusy(true)
    try {
      await saveMacro({
        id: editId,
        name: normalizeName(name) as string,
        commands: commands.replace(/\r\n?/g, '\n'),
        enter,
        delay,
        scope: parseScope(scope),
        hotkey
      })
      closeDialog()
      toast(editId ? 'Макрос сохранён' : 'Макрос создан', 'success')
    } catch (err) {
      toast(errorText(err), 'error', 6000)
      setBusy(false)
    }
  }

  return (
    <Modal
      title={existing ? `Макрос «${existing.name}»` : 'Новый макрос'}
      icon="bolt"
      width={560}
      onCancel={closeDialog}
      footer={
        <>
          {existing && (
            <button className="btn danger-text left" onClick={() => askDeleteMacro(existing.id)}>
              Удалить
            </button>
          )}
          <button className="btn" onClick={closeDialog}>
            Отмена
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void submit()}>
            Сохранить
          </button>
        </>
      }
    >
      <form className="form" onSubmit={(e) => void submit(e)}>
        <label className={`fld${touched && nameError ? ' invalid' : ''}`}>
          <span className="fld-label">Название</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="например, Обновить проект" data-autofocus />
          {touched && nameError && <span className="err">{nameError}</span>}
        </label>
        <label className={`fld${touched && commandsError ? ' invalid' : ''}`}>
          <span className="fld-label">Команды — по одной на строку</span>
          <textarea
            className="mono"
            rows={6}
            spellCheck={false}
            value={commands}
            onChange={(e) => setCommands(e.target.value)}
            placeholder={'cd /var/www/app\ngit pull --ff-only\ndocker compose up -d --build'}
          />
          {touched && commandsError && <span className="err">{commandsError}</span>}
        </label>
        <label className="check">
          <input type="checkbox" checked={enter} onChange={(e) => setEnter(e.target.checked)} />
          Нажать Enter после последней строки
          {!enter && <span className="check-hint">— последняя команда только напечатается: проверите и запустите сами</span>}
        </label>
        <div className="row2">
          <label className="fld grow">
            <span className="fld-label">Где показывать</span>
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="all">Везде — во всех сессиях и терминалах</option>
              <option value="local">Только в терминалах компьютера</option>
              {folderList.length > 0 && (
                <optgroup label="Сессии в папке">
                  {folderList.map(({ folder, depth }) => (
                    <option key={folder.id} value={`folder:${folder.id}`}>
                      {'  '.repeat(depth)}
                      {folder.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {sessionList.length > 0 && (
                <optgroup label="Только одна сессия">
                  {sessionList.map((s) => (
                    <option key={s.id} value={`session:${s.id}`}>
                      {s.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
          <label className="fld w150">
            <span className="fld-label">Пауза между строками</span>
            <select value={delay} onChange={(e) => setDelay(Number(e.target.value))}>
              {MACRO_DELAYS.map((ms) => (
                <option key={ms} value={ms}>
                  {delayLabel(ms)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className={`fld${hotkeyError ? ' invalid' : ''}`}>
          <span className="fld-label">Горячая клавиша</span>
          <HotkeyInput value={hotkey} onChange={setHotkey} error={hotkeyError} />
          {hotkeyError && <span className="err">{hotkeyError}</span>}
        </div>
        <p className="note">
          <Icon name="bolt" />
          <span>
            Макрос печатает {lines > 1 ? `эти ${lines} строки` : 'команду'} в терминал активной вкладки — как будто вы ввели их сами. Чтобы он
            выполнялся сам после входа на сервер, выберите его в настройках сессии: «После входа выполнить».
            {delay === 0 && lines > 1 && ' Если команда ждёт ввода (sudo, пароль), поставьте паузу между строками.'}
          </span>
        </p>
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
