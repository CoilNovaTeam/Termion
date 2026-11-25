import { useState } from 'react'
import { errorText } from '../../api'
import { closeDialog, toast } from '../../store/actions'
import type { DialogState } from '../../store/app'
import { Modal } from './Modal'

type Props = Extract<DialogState, { type: 'confirm' }>

export function ConfirmDialog({ title, message, confirmLabel, danger, onConfirm }: Props) {
  const [busy, setBusy] = useState(false)
  const confirm = async () => {
    setBusy(true)
    try {
      await onConfirm()
      closeDialog()
    } catch (err) {
      toast(errorText(err), 'error', 6000)
      setBusy(false)
    }
  }
  return (
    <Modal
      title={title}
      icon={danger ? 'trash' : 'info'}
      tone={danger ? 'danger' : 'default'}
      width={440}
      onCancel={closeDialog}
      footer={
        <>
          <button className="btn" onClick={closeDialog}>
            Отмена
          </button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} disabled={busy} onClick={confirm} data-autofocus>
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="mtext">{message}</p>
    </Modal>
  )
}
