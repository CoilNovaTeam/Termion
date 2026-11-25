import { useMemo, useState, type FormEvent } from 'react'
import { folders, isInside, locate } from '@shared/tree'
import { normalizeName } from '@shared/validate'
import { errorText } from '../../api'
import { closeDialog, saveFolder, toast } from '../../store/actions'
import { useApp } from '../../store/app'
import { Modal } from './Modal'

export function FolderDialog({ editId, parentId }: { editId: string | null; parentId: string | null }) {
  const tree = useApp((s) => s.tree)
  const existing = editId ? locate(tree, editId)?.node : undefined
  const [name, setName] = useState(existing?.name ?? '')
  const [parent, setParent] = useState(parentId ?? '')
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const options = useMemo(() => folders(tree).filter((f) => !editId || !isInside(tree, editId, f.folder.id)), [tree, editId])

  const clean = normalizeName(name)
  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    setTouched(true)
    if (!clean) return
    setBusy(true)
    try {
      await saveFolder(editId, editId ? null : parent || null, clean)
      closeDialog()
      toast(editId ? 'Папка переименована' : 'Папка создана', 'success')
    } catch (err) {
      toast(errorText(err), 'error', 6000)
      setBusy(false)
    }
  }

  return (
    <Modal
      title={editId ? 'Переименовать папку' : 'Новая папка'}
      icon="folder"
      width={420}
      onCancel={closeDialog}
      footer={
        <>
          <button className="btn" onClick={closeDialog}>
            Отмена
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void submit()}>
            {editId ? 'Сохранить' : 'Создать'}
          </button>
        </>
      }
    >
      <form className="form" onSubmit={submit}>
        <label className={`fld${touched && !clean ? ' invalid' : ''}`}>
          <span>Название</span>
          <input data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder="например, Клиенты" maxLength={120} />
          {touched && !clean && <span className="err">Введите название папки</span>}
        </label>
        {!editId && (
          <label className="fld">
            <span>Где создать</span>
            <select value={parent} onChange={(e) => setParent(e.target.value)}>
              <option value="">В корне списка</option>
              {options.map(({ folder, depth }) => (
                <option key={folder.id} value={folder.id}>
                  {' '.repeat(depth)}
                  {folder.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
