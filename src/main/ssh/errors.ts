// Перевод технических ошибок сети и SSH в понятные сообщения.

export class ConnectError extends Error {
  constructor(
    message: string,
    readonly kind: 'connect-timeout' | 'handshake-timeout' | 'cancelled' | 'hostkey-rejected' | 'no-methods'
  ) {
    super(message)
    this.name = 'ConnectError'
  }
}

const errCode = (err: unknown): string =>
  typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : ''

export function describeError(err: unknown, host: string, port: number): string {
  if (err instanceof ConnectError) return err.message
  const code = errCode(err)
  const message = err instanceof Error ? err.message : String(err)
  const target = `${host}:${port}`
  switch (code) {
    case 'ECONNREFUSED':
      return `Сервер ${target} отклонил подключение: на этом порту SSH не отвечает.`
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EAI_FAIL':
      return `Не удалось найти адрес «${host}». Проверьте имя сервера и подключение к интернету.`
    case 'ETIMEDOUT':
      return `Сервер ${target} не отвечает.`
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `Сервер ${target} недоступен: нет маршрута до него.`
    case 'ECONNRESET':
    case 'EPIPE':
      return 'Сервер разорвал соединение.'
    case 'ECONNABORTED':
      return 'Соединение прервано.'
  }
  if (/All configured authentication methods failed/i.test(message)) {
    return 'Не удалось войти: сервер не принял ни один способ входа.'
  }
  if (/Keepalive timeout/i.test(message)) return 'Связь с сервером потеряна: он перестал отвечать.'
  if (/Handshake failed|no matching/i.test(message)) {
    return `Не удалось договориться с сервером о шифровании: ${message}`
  }
  if (/Timed out while waiting for handshake/i.test(message)) return 'Сервер не завершил SSH-рукопожатие.'
  return `Ошибка: ${message}`
}
