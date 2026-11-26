import type { CSSProperties } from 'react'
import type { CursorStyle, LayoutId, Settings, TerminalFont, ThemeId } from '@shared/types'
import { api } from '../../api'
import { closeDialog, updateSettings } from '../../store/actions'
import { useApp } from '../../store/app'
import { FONT_LABELS } from '../../terminal/themes'
import { Icon, Logo } from '../Icon'
import { Modal } from './Modal'

const THEMES: { id: ThemeId; label: string; title: string; panel: string; term: string; accent: string; line: string }[] = [
  { id: 'graphite', label: 'Графит', title: '#0f1114', panel: '#171a1e', term: '#0e1013', accent: '#3fb6a8', line: '#d6dce2' },
  { id: 'classic', label: 'Классика', title: '#c9d0d8', panel: '#eef1f4', term: '#1e1e1e', accent: '#2b6cd4', line: '#ececec' },
  { id: 'light', label: 'Светлая', title: '#eceef2', panel: '#fafbfc', term: '#ffffff', accent: '#5b5ce6', line: '#262b36' }
]

const LAYOUTS: { id: LayoutId; label: string }[] = [
  { id: 'stacked', label: 'Слева стопкой' },
  { id: 'classic', label: 'Как в MobaXterm' },
  { id: 'ide', label: 'Файлы справа' }
]

const box = (style: CSSProperties): CSSProperties => ({ position: 'absolute', borderRadius: 2, ...style })

function ThemePreview({ t }: { t: (typeof THEMES)[number] }) {
  return (
    <div className="preview" style={{ background: t.panel }}>
      <div style={box({ left: 0, right: 0, top: 0, height: 9, background: t.title, borderRadius: 0 })} />
      <div style={box({ left: 6, top: 15, width: 22, height: 4, background: t.accent, opacity: 0.8 })} />
      <div style={box({ left: 6, top: 23, width: 28, height: 4, background: t.line, opacity: 0.35 })} />
      <div style={box({ left: 6, top: 31, width: 18, height: 4, background: t.line, opacity: 0.35 })} />
      <div style={box({ left: 40, right: 0, top: 9, bottom: 0, background: t.term, borderRadius: 0 })} />
      <div style={box({ left: 46, top: 16, width: 34, height: 4, background: t.accent })} />
      <div style={box({ left: 46, top: 25, width: 52, height: 4, background: t.line, opacity: 0.55 })} />
      <div style={box({ left: 46, top: 34, width: 40, height: 4, background: t.line, opacity: 0.55 })} />
      <div style={box({ left: 46, top: 43, width: 6, height: 7, background: t.accent })} />
    </div>
  )
}

function LayoutPreview({ id }: { id: LayoutId }) {
  const part = (style: CSSProperties, accent = false): CSSProperties =>
    box({ background: accent ? 'var(--accent)' : 'var(--border-strong)', opacity: accent ? 0.55 : 0.7, ...style })
  return (
    <div className="preview" style={{ background: 'var(--bg-input)' }}>
      {id === 'stacked' && (
        <>
          <div style={part({ left: 5, top: 5, width: 30, height: 24 })} />
          <div style={part({ left: 5, top: 32, width: 30, bottom: 5 }, true)} />
          <div style={part({ left: 39, top: 5, right: 5, bottom: 5 })} />
        </>
      )}
      {id === 'classic' && (
        <>
          <div style={part({ left: 5, top: 5, right: 5, height: 9 })} />
          <div style={part({ left: 5, top: 17, width: 7, bottom: 5 })} />
          <div style={part({ left: 15, top: 17, width: 28, bottom: 5 }, true)} />
          <div style={part({ left: 46, top: 17, right: 5, bottom: 5 })} />
        </>
      )}
      {id === 'ide' && (
        <>
          <div style={part({ left: 5, top: 5, width: 24, bottom: 5 })} />
          <div style={part({ left: 32, top: 5, right: 32, bottom: 5 })} />
          <div style={part({ right: 5, top: 5, width: 24, bottom: 5 }, true)} />
        </>
      )}
    </div>
  )
}

export function SettingsDialog() {
  const settings = useApp((s) => s.settings)
  const info = useApp((s) => s.info)
  const term = settings.terminal
  const shells = useApp((s) => s.shells)
  const setTerm = (patch: Partial<Settings['terminal']>) => updateSettings((s) => ({ ...s, terminal: { ...s.terminal, ...patch } }))

  return (
    <Modal
      title="Настройки"
      icon="gear"
      width={600}
      onCancel={closeDialog}
      footer={
        <button className="btn primary" onClick={closeDialog} data-autofocus>
          Готово
        </button>
      }
    >
      <div className="settings">
        <section>
          <h4>Тема</h4>
          <div className="cards">
            {THEMES.map((t) => (
              <button key={t.id} className={`card${settings.theme === t.id ? ' on' : ''}`} onClick={() => updateSettings((s) => ({ ...s, theme: t.id }))}>
                <ThemePreview t={t} />
                <span className="label">
                  {t.label}
                  {settings.theme === t.id && <Icon name="check" size={14} />}
                </span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <h4>Раскладка</h4>
          <div className="cards">
            {LAYOUTS.map((l) => (
              <button key={l.id} className={`card${settings.layout === l.id ? ' on' : ''}`} onClick={() => updateSettings((s) => ({ ...s, layout: l.id }))}>
                <LayoutPreview id={l.id} />
                <span className="label">
                  {l.label}
                  {settings.layout === l.id && <Icon name="check" size={14} />}
                </span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <h4>Терминал</h4>
          {shells.length > 0 && (
            <div className="setting-line">
              <span className="fld-label">Терминал компьютера по умолчанию</span>
              <select value={shells.some((sh) => sh.id === term.defaultShell) ? term.defaultShell : ''} onChange={(e) => setTerm({ defaultShell: e.target.value })}>
                <option value="">Автоматически ({shells[0].name})</option>
                {shells.map((sh) => (
                  <option key={sh.id} value={sh.id}>
                    {sh.name}
                    {sh.kind === 'wsl' ? ' (WSL)' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="setting-line">
            <span className="fld-label">Шрифт</span>
            <select value={term.font} onChange={(e) => setTerm({ font: e.target.value as TerminalFont })}>
              {(Object.keys(FONT_LABELS) as TerminalFont[]).map((f) => (
                <option key={f} value={f}>
                  {FONT_LABELS[f]}
                  {f === 'consolas' ? ' (системный)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="setting-line">
            <span className="fld-label">Размер шрифта</span>
            <div className="stepper">
              <button title="Меньше" onClick={() => setTerm({ fontSize: Math.max(9, term.fontSize - 1) })}>
                <Icon name="minus" size={14} />
              </button>
              <span>{term.fontSize}</span>
              <button title="Больше" onClick={() => setTerm({ fontSize: Math.min(28, term.fontSize + 1) })}>
                <Icon name="plus" size={14} />
              </button>
            </div>
          </div>
          <div className="setting-line">
            <span className="fld-label">Межстрочный интервал</span>
            <select value={term.lineHeight} onChange={(e) => setTerm({ lineHeight: Number(e.target.value) })}>
              {[1, 1.1, 1.2, 1.3, 1.4, 1.5].map((v) => (
                <option key={v} value={v}>
                  {v.toFixed(1)}
                </option>
              ))}
            </select>
          </div>
          <div className="setting-line">
            <span className="fld-label">Курсор</span>
            <div className="seg">
              {(
                [
                  ['block', 'Блок'],
                  ['bar', 'Черта'],
                  ['underline', 'Подчёркивание']
                ] as [CursorStyle, string][]
              ).map(([v, label]) => (
                <button key={v} className={term.cursorStyle === v ? 'on' : ''} onClick={() => setTerm({ cursorStyle: v })}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="setting-line">
            <span className="fld-label">История прокрутки</span>
            <select value={term.scrollback} onChange={(e) => setTerm({ scrollback: Number(e.target.value) })}>
              {[1000, 5000, 10000, 50000, 100000].map((v) => (
                <option key={v} value={v}>
                  {v.toLocaleString('ru-RU')} строк
                </option>
              ))}
            </select>
          </div>
          <label className="switch">
            <span className="sw-text">Мигающий курсор</span>
            <input type="checkbox" checked={term.cursorBlink} onChange={(e) => setTerm({ cursorBlink: e.target.checked })} />
          </label>
          <label className="switch">
            <span className="sw-text">
              Копировать при выделении
              <small>Выделенный мышью текст сразу попадает в буфер обмена</small>
            </span>
            <input type="checkbox" checked={term.copyOnSelect} onChange={(e) => setTerm({ copyOnSelect: e.target.checked })} />
          </label>
          <label className="switch">
            <span className="sw-text">
              Правый клик вставляет
              <small>Как в PuTTY и MobaXterm. Если выключено — правый клик открывает меню</small>
            </span>
            <input type="checkbox" checked={term.rightClickPaste} onChange={(e) => setTerm({ rightClickPaste: e.target.checked })} />
          </label>
        </section>

        <section>
          <h4>Макросы</h4>
          <label className="switch">
            <span className="sw-text">
              Полоса макросов под терминалом
              <small>Кнопки макросов, которые видны в активной вкладке. Горячие клавиши работают и без неё</small>
            </span>
            <input
              type="checkbox"
              checked={settings.macros.showBar}
              onChange={(e) => updateSettings((s) => ({ ...s, macros: { ...s.macros, showBar: e.target.checked } }))}
            />
          </label>
        </section>

        <section>
          <h4>Сервер</h4>
          <label className="switch">
            <span className="sw-text">
              Нагрузка сервера в строке состояния
              <small>Процессор, память и свободное место на диске у сервера активной вкладки. Обновляется раз в 5 секунд, только пока окно на экране</small>
            </span>
            <input
              type="checkbox"
              checked={settings.monitor.statusBar}
              onChange={(e) => updateSettings((s) => ({ ...s, monitor: { ...s.monitor, statusBar: e.target.checked } }))}
            />
          </label>
        </section>

        <section>
          <h4>Файлы и редактор</h4>
          <label className="switch">
            <span className="sw-text">
              Показывать скрытые файлы
              <small>Файлы и папки, имя которых начинается с точки: .env, .bashrc, .git</small>
            </span>
            <input
              type="checkbox"
              checked={settings.files.showHidden}
              onChange={(e) => updateSettings((s) => ({ ...s, files: { ...s.files, showHidden: e.target.checked } }))}
            />
          </label>
          <label className="switch">
            <span className="sw-text">
              Следовать за папкой терминала
              <small>После cd в терминале дерево файлов переходит в ту же папку</small>
            </span>
            <input
              type="checkbox"
              checked={settings.files.followTerminal}
              onChange={(e) => updateSettings((s) => ({ ...s, files: { ...s.files, followTerminal: e.target.checked } }))}
            />
          </label>
          <label className="switch">
            <span className="sw-text">
              Спрашивать перед перемещением
              <small>Когда файлы перетаскивают мышью в другую папку дерева</small>
            </span>
            <input
              type="checkbox"
              checked={settings.files.confirmMove}
              onChange={(e) => updateSettings((s) => ({ ...s, files: { ...s.files, confirmMove: e.target.checked } }))}
            />
          </label>
          <label className="switch">
            <span className="sw-text">
              Перенос длинных строк в редакторе
              <small>Переключается и в самом редакторе — Alt+Z</small>
            </span>
            <input
              type="checkbox"
              checked={settings.editor.wordWrap}
              onChange={(e) => updateSettings((s) => ({ ...s, editor: { ...s.editor, wordWrap: e.target.checked } }))}
            />
          </label>
        </section>

        {info && (
          <section>
            <h4>О программе</h4>
            <div className="about">
              <Logo size={30} />
              <div className="grow">
                <b>Termion {info.version}</b> · Electron {info.electron}
                <span className="path mono" title={info.dataDir}>
                  {info.dataDir}
                </span>
              </div>
              <button className="btn sm" onClick={() => void api.app.openDataDir()}>
                <Icon name="folder" />
                Папка данных
              </button>
            </div>
          </section>
        )}
      </div>
    </Modal>
  )
}
