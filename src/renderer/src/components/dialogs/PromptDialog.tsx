import { useState, type FormEvent } from 'react'
import type { PromptRequest } from '@shared/types'
import { respondPrompt } from '../../store/actions'
import { isTerminal, useApp } from '../../store/app'
import { Icon } from '../Icon'
import { Modal } from './Modal'

const target = (host: string, port: number) => (port === 22 ? host : `${host}:${port}`)

function SecretInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [visible, setVisible] = useState(false)
  return (
    <div className="pw">
      <input
        data-autofocus
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
      />
      <button type="button" className="icon-btn" style={{ width: 32, height: 32 }} title={visible ? 'Скрыть' : 'Показать'} onClick={() => setVisible((v) => !v)}>
        <Icon name={visible ? 'eyeOff' : 'eye'} />
      </button>
    </div>
  )
}

export function PromptDialog({ prompt }: { prompt: PromptRequest }) {
  const tabTitle = useApp((s) => s.tabs.find((t) => isTerminal(t) && t.connId === prompt.connId)?.title)
  const subtitle = tabTitle ? `Вкладка «${tabTitle}»` : undefined
  const [value, setValue] = useState('')
  const [save, setSave] = useState(true)
  const [answers, setAnswers] = useState<string[]>(() => (prompt.kind === 'keyboard-interactive' ? prompt.fields.map(() => '') : []))

  const id = prompt.promptId

  switch (prompt.kind) {
    case 'hostkey-new': {
      const answer = (accept: boolean) => respondPrompt(id, { kind: 'hostkey', accept })
      return (
        <Modal
          title="Новый сервер"
          subtitle={subtitle}
          icon="shield"
          width={520}
          closeOnBackdrop={false}
          onCancel={() => answer(false)}
          footer={
            <>
              <button className="btn" onClick={() => answer(false)}>
                Отмена
              </button>
              <button className="btn primary" data-autofocus onClick={() => answer(true)}>
                Доверять и подключиться
              </button>
            </>
          }
        >
          <p className="mtext">
            Termion ещё не подключался к <b>{target(prompt.host, prompt.port)}</b>. Убедитесь, что это нужный сервер: отпечаток его ключа должен совпадать
            с настоящим.
          </p>
          <dl className="fp">
            <dt>Тип ключа</dt>
            <dd>{prompt.keyType}</dd>
            <dt>Отпечаток</dt>
            <dd className="mono">{prompt.fingerprint}</dd>
          </dl>
          <p className="note">
            <Icon name="info" />
            <span>
              Проверить отпечаток можно на самом сервере: <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code>. После подтверждения ключ будет
              запомнен, и при следующих подключениях вопрос не появится.
            </span>
          </p>
        </Modal>
      )
    }

    case 'hostkey-changed': {
      const answer = (accept: boolean) => respondPrompt(id, { kind: 'hostkey', accept })
      return (
        <Modal
          title="Ключ сервера изменился!"
          subtitle={subtitle}
          icon="shieldAlert"
          tone="danger"
          width={560}
          closeOnBackdrop={false}
          onCancel={() => answer(false)}
          footer={
            <>
              <button className="btn danger-text left" onClick={() => answer(true)}>
                Заменить ключ и подключиться
              </button>
              <button className="btn primary" data-autofocus onClick={() => answer(false)}>
                Не подключаться
              </button>
            </>
          }
        >
          <p className="mtext">
            Ключ сервера <b>{target(prompt.host, prompt.port)}</b> не совпадает с сохранённым
            {prompt.source === 'openssh' ? ' в ~/.ssh/known_hosts' : ' в Termion'}.
          </p>
          <dl className="fp">
            <dt>Был</dt>
            <dd className="mono old">
              {prompt.knownKeyType} {prompt.knownFingerprint}
            </dd>
            <dt>Сейчас</dt>
            <dd className="mono new">
              {prompt.keyType} {prompt.fingerprint}
            </dd>
          </dl>
          <p className="note danger">
            <Icon name="warn" />
            <span>
              Так бывает после переустановки сервера или смены его ключей. Но это же — признак перехвата соединения. Если вы не меняли сервер, не
              подключайтесь и выясните причину.
            </span>
          </p>
        </Modal>
      )
    }

    case 'password':
    case 'passphrase': {
      const isPassword = prompt.kind === 'password'
      const cancel = () => respondPrompt(id, { kind: 'secret', value: null, save: false })
      const submit = (e?: FormEvent) => {
        e?.preventDefault()
        respondPrompt(id, { kind: 'secret', value, save: prompt.canSave && save })
      }
      return (
        <Modal
          title={isPassword ? 'Вход на сервер' : 'Фраза-пароль ключа'}
          subtitle={subtitle}
          icon={isPassword ? 'lock' : 'key'}
          width={440}
          closeOnBackdrop={false}
          onCancel={cancel}
          footer={
            <>
              <button className="btn" onClick={cancel}>
                Отмена
              </button>
              <button className="btn primary" onClick={() => submit()}>
                {isPassword ? 'Войти' : 'Продолжить'}
              </button>
            </>
          }
        >
          <form className="form" onSubmit={submit}>
            <p className="mtext" style={{ margin: 0 }}>
              {isPassword ? (
                <>
                  Пароль для <b className="mono">{prompt.username}@{target(prompt.host, prompt.port)}</b>
                </>
              ) : (
                <>
                  Ключ <b className="mono">{prompt.keyPath}</b> защищён фразой-паролем.
                </>
              )}
            </p>
            {prompt.retry && (
              <p className="note danger" style={{ margin: 0 }}>
                <Icon name="warn" />
                <span>{isPassword ? 'Пароль не подошёл — попробуйте ещё раз.' : 'Неверная фраза-пароль — попробуйте ещё раз.'}</span>
              </p>
            )}
            <SecretInput value={value} onChange={setValue} placeholder={isPassword ? 'пароль' : 'фраза-пароль'} />
            {prompt.canSave && (
              <label className="check">
                <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
                {isPassword ? 'Запомнить пароль' : 'Запомнить фразу-пароль'} (в защищённом хранилище Windows)
              </label>
            )}
            <button type="submit" hidden />
          </form>
        </Modal>
      )
    }

    case 'keyboard-interactive': {
      const cancel = () => respondPrompt(id, { kind: 'answers', values: null })
      const submit = (e?: FormEvent) => {
        e?.preventDefault()
        respondPrompt(id, { kind: 'answers', values: answers })
      }
      return (
        <Modal
          title={prompt.title || 'Дополнительная проверка'}
          subtitle={subtitle}
          icon="shield"
          width={460}
          closeOnBackdrop={false}
          onCancel={cancel}
          footer={
            <>
              <button className="btn" onClick={cancel}>
                Отмена
              </button>
              <button className="btn primary" onClick={() => submit()}>
                Продолжить
              </button>
            </>
          }
        >
          <form className="form" onSubmit={submit}>
            <p className="mtext" style={{ margin: 0 }}>
              Сервер <b>{prompt.host}</b> просит ответить ({prompt.username}).
            </p>
            {prompt.instructions && <p className="note">{prompt.instructions}</p>}
            {prompt.fields.map((field, i) => (
              <label className="fld" key={i}>
                <span>{field.label || `Поле ${i + 1}`}</span>
                <input
                  data-autofocus={i === 0 ? true : undefined}
                  type={field.echo ? 'text' : 'password'}
                  value={answers[i] ?? ''}
                  onChange={(e) => setAnswers((a) => a.map((v, j) => (j === i ? e.target.value : v)))}
                  autoComplete="off"
                />
              </label>
            ))}
            <button type="submit" hidden />
          </form>
        </Modal>
      )
    }
  }
}
