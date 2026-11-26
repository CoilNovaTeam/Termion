import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { AuthMethod, SecretStatus } from '@shared/types'
import { findSession, folders } from '@shared/tree'
import { normalizeHost, normalizeKeyPath, normalizeName, normalizePort, normalizeUsername } from '@shared/validate'
import { api, errorText } from '../../api'
import { closeDialog, openSession, saveSession, toast, type PasswordChange } from '../../store/actions'
import { useApp } from '../../store/app'
import { Icon } from '../Icon'
import { Modal } from './Modal'

interface FormState {
  name: string
  host: string
  port: string
  username: string
  auth: AuthMethod
  keyPath: string
}

/** Разбирает «user@host:port» или «ssh://user@host:port», если такое вставили в поле адреса. */
function parseTarget(raw: string): { user?: string; host: string; port?: string } | null {
  const m = raw.trim().match(/^(?:ssh:\/\/)?(?:([^@\s/]+)@)?(\[[^\]\s]+\]|[^:@\s/]+)(?::(\d{1,5}))?\/?$/)
  if (!m) return null
  if (!m[1] && !m[3] && !raw.trim().startsWith('ssh://')) return null
  return { user: m[1], host: m[2].replace(/^\[|\]$/g, ''), port: m[3] }
}

export function SessionDialog({ editId, parentId }: { editId: string | null; parentId: string | null }) {
  const tree = useApp((s) => s.tree)
  const existing = useMemo(() => (editId ? findSession(tree, editId) : null), [tree, editId])
  const folderOptions = useMemo(() => folders(tree), [tree])

  const [form, setForm] = useState<FormState>({
    name: existing?.name ?? '',
    host: existing?.host ?? '',
    port: String(existing?.port ?? 22),
    username: existing?.username ?? 'root',
    auth: existing?.auth ?? 'password',
    keyPath: existing?.keyPath ?? ''
  })
  const [folder, setFolder] = useState(parentId ?? '')
  const macros = useApp((s) => s.macros)
  const [onConnect, setOnConnect] = useState(existing?.onConnect ?? '')
  const [secret, setSecret] = useState<SecretStatus | null>(null)
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [replacePassword, setReplacePassword] = useState(false)
  const [clearPassword, setClearPassword] = useState(false)
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.secrets
      .status(editId ?? 'new')
      .then(setSecret)
      .catch(() => setSecret({ hasPassword: false, canStore: false }))
  }, [editId])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }))

  const host = normalizeHost(form.host)
  const port = normalizePort(form.port)
  const username = normalizeUsername(form.username)
  const keyPath = normalizeKeyPath(form.keyPath)
  const nameOk = !form.name.trim() || !!normalizeName(form.name)
  const errors = {
    host: host ? null : form.host.trim() ? 'Некорректный адрес: только буквы, цифры, точки, дефисы или IPv6' : 'Укажите адрес сервера',
    port: port ? null : 'Порт — число от 1 до 65535',
    username: username ? null : 'Укажите пользователя (без пробелов)',
    keyPath: keyPath === null ? 'Некорректный путь к файлу' : null,
    name: nameOk ? null : 'Название слишком длинное'
  }
  const hasErrors = Object.values(errors).some(Boolean)
  const show = (key: keyof typeof errors) => (touched ? errors[key] : null)

  const onHostBlur = () => {
    const parsed = parseTarget(form.host)
    if (!parsed) return
    setForm((f) => ({ ...f, host: parsed.host, username: parsed.user ?? f.username, port: parsed.port ?? f.port }))
  }

  const passwordChange = (): PasswordChange => {
    if (form.auth !== 'password') return { kind: 'keep' }
    if (secret?.hasPassword && !replacePassword) return clearPassword ? { kind: 'clear' } : { kind: 'keep' }
    return password && secret?.canStore ? { kind: 'set', value: password } : { kind: 'keep' }
  }

  const submit = async (connect: boolean) => {
    setTouched(true)
    if (hasErrors || !host || !port || !username || keyPath === null) return
    setBusy(true)
    setError(null)
    try {
      const id = await saveSession(
        editId,
        folder || null,
        { name: normalizeName(form.name) ?? host, host, port, username, auth: form.auth, keyPath, onConnect: macros.some((m) => m.id === onConnect) ? onConnect : '' },
        passwordChange()
      )
      closeDialog()
      if (connect) openSession(id)
      else toast(editId ? 'Сессия сохранена' : 'Сессия создана', 'success')
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    void submit(!editId)
  }

  const pickKey = async () => {
    const path = await api.dialogs.pickKeyFile()
    if (path) set('keyPath', path)
  }

  return (
    <Modal
      title={editId ? `Сессия «${existing?.name ?? ''}»` : 'Новая сессия'}
      icon="server"
      width={540}
      onCancel={closeDialog}
      footer={
        <>
          <button className="btn" onClick={closeDialog}>
            Отмена
          </button>
          <button className={`btn${editId ? ' primary' : ''}`} disabled={busy} onClick={() => void submit(false)}>
            Сохранить
          </button>
          <button className={`btn${editId ? '' : ' primary'}`} disabled={busy} onClick={() => void submit(true)}>
            <Icon name="plug" />
            Сохранить и подключиться
          </button>
        </>
      }
    >
      <form className="form" onSubmit={onSubmit}>
        <div className="row2">
          <label className={`fld grow${show('name') ? ' invalid' : ''}`}>
            <span>Название</span>
            <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder={host ?? 'например, prod-web'} maxLength={120} />
            {show('name') && <span className="err">{errors.name}</span>}
          </label>
          <label className="fld grow">
            <span>Папка</span>
            <select value={folder} onChange={(e) => setFolder(e.target.value)}>
              <option value="">Без папки</option>
              {folderOptions.map(({ folder: f, depth }) => (
                <option key={f.id} value={f.id}>
                  {' '.repeat(depth)}
                  {f.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="row2">
          <label className={`fld grow${show('host') ? ' invalid' : ''}`}>
            <span>Адрес сервера</span>
            <input
              data-autofocus
              className="mono"
              value={form.host}
              onChange={(e) => set('host', e.target.value)}
              onBlur={onHostBlur}
              placeholder="203.0.113.10 или user@host:port"
              spellCheck={false}
            />
            {show('host') && <span className="err">{errors.host}</span>}
          </label>
          <label className={`fld w90${show('port') ? ' invalid' : ''}`}>
            <span>Порт</span>
            <input className="mono" value={form.port} onChange={(e) => set('port', e.target.value.replace(/[^\d]/g, ''))} inputMode="numeric" maxLength={5} />
          </label>
        </div>
        {show('port') && <span className="err" style={{ marginTop: -6, fontSize: 11.5, color: 'var(--err)' }}>{errors.port}</span>}

        <label className={`fld${show('username') ? ' invalid' : ''}`}>
          <span>Пользователь</span>
          <input className="mono" value={form.username} onChange={(e) => set('username', e.target.value)} spellCheck={false} />
          {show('username') && <span className="err">{errors.username}</span>}
        </label>

        <div className="fld">
          <span className="fld-label">Вход</span>
          <div className="seg" role="radiogroup">
            {(
              [
                ['password', 'lock', 'Пароль'],
                ['key', 'key', 'SSH-ключ'],
                ['agent', 'agent', 'ssh-agent']
              ] as const
            ).map(([value, icon, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={form.auth === value}
                className={form.auth === value ? 'on' : ''}
                onClick={() => set('auth', value)}
              >
                <Icon name={icon} />
                {label}
              </button>
            ))}
          </div>
        </div>

        {form.auth === 'password' && (
          <div className="fld">
            <span className="fld-label">Пароль</span>
            {secret?.hasPassword && !replacePassword ? (
              <div className="saved-secret">
                <Icon name={clearPassword ? 'trash' : 'check'} />
                <span>{clearPassword ? 'Сохранённый пароль будет удалён' : 'Пароль сохранён в защищённом хранилище Windows'}</span>
                {clearPassword ? (
                  <button type="button" className="btn ghost sm" onClick={() => setClearPassword(false)}>
                    Отменить
                  </button>
                ) : (
                  <>
                    <button type="button" className="btn ghost sm" onClick={() => setReplacePassword(true)}>
                      Заменить
                    </button>
                    <button type="button" className="btn ghost sm danger-text" onClick={() => setClearPassword(true)}>
                      Удалить
                    </button>
                  </>
                )}
              </div>
            ) : (
              <>
                <div className="pw">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={secret?.canStore === false ? 'сохранение паролей недоступно' : 'можно не заполнять'}
                    disabled={secret?.canStore === false}
                    autoComplete="new-password"
                  />
                  <button type="button" className="icon-btn" style={{ width: 32, height: 32 }} title={showPassword ? 'Скрыть' : 'Показать'} onClick={() => setShowPassword((v) => !v)}>
                    <Icon name={showPassword ? 'eyeOff' : 'eye'} />
                  </button>
                </div>
                <span className="hint-text">Если оставить пустым, Termion спросит пароль при подключении и предложит его запомнить.</span>
              </>
            )}
          </div>
        )}

        {form.auth === 'key' && (
          <div className={`fld${show('keyPath') ? ' invalid' : ''}`}>
            <span className="fld-label">Файл приватного ключа</span>
            <div className="pw">
              <input className="mono" value={form.keyPath} onChange={(e) => set('keyPath', e.target.value)} placeholder="стандартные ключи из ~/.ssh" spellCheck={false} />
              <button type="button" className="btn" onClick={() => void pickKey()}>
                Обзор…
              </button>
            </div>
            {show('keyPath') && <span className="err">{errors.keyPath}</span>}
            <span className="hint-text">
              Пусто — Termion попробует ~/.ssh/id_ed25519, id_ecdsa и id_rsa. Подходят ключи OpenSSH и PuTTY (.ppk). Если ключ не подойдёт, Termion предложит войти по паролю.
            </span>
          </div>
        )}

        {form.auth === 'agent' && (
          <p className="note">
            <Icon name="agent" />
            <span>
              Ключи берутся из ssh-agent — службы Windows «OpenSSH Authentication Agent». Добавить ключ: <code>ssh-add ~/.ssh/id_ed25519</code>
            </span>
          </p>
        )}

        <label className="fld">
          <span className="fld-label">После входа выполнить</span>
          <select value={macros.some((m) => m.id === onConnect) ? onConnect : ''} onChange={(e) => setOnConnect(e.target.value)}>
            <option value="">— ничего —</option>
            {macros.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <span className="hint-text">
            {macros.length
              ? 'Макрос напечатается в терминал сразу после входа — например, перейти в папку проекта и показать его состояние.'
              : 'Макросов пока нет — их создают кнопкой «+ Макрос» на полосе макросов под терминалом.'}
          </span>
        </label>

        {secret?.canStore === false ? (
          <p className="note warn">
            <Icon name="warn" />
            <span>Шифрование Windows недоступно — пароли не будут сохраняться, Termion будет спрашивать их при каждом подключении.</span>
          </p>
        ) : (
          <p className="note">
            <Icon name="lock" />
            <span>Пароли и фразы ключей хранятся зашифрованными (защищённое хранилище Windows) отдельно от списка сессий.</span>
          </p>
        )}

        {error && (
          <p className="note danger">
            <Icon name="warn" />
            <span>{error}</span>
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
