// Имена каналов IPC между главным процессом и окном.

export const IPC = {
  appInfo: 'app:info',
  openDataDir: 'app:open-data-dir',
  openExternal: 'app:open-external',
  appCloseAck: 'app:close-ack',
  appCloseReady: 'app:close-ready',
  evBeforeClose: 'app:ev:before-close',

  sessionsLoad: 'sessions:load',
  sessionsSave: 'sessions:save',

  secretsStatus: 'secrets:status',
  secretsSetPassword: 'secrets:set-password',

  settingsLoad: 'settings:load',
  settingsSave: 'settings:save',

  dialogPickKey: 'dialog:pick-key',

  clipboardRead: 'clipboard:read',
  clipboardWrite: 'clipboard:write',

  sshConnect: 'ssh:connect',
  sshWrite: 'ssh:write',
  sshResize: 'ssh:resize',
  sshAck: 'ssh:ack',
  sshDisconnect: 'ssh:disconnect',
  sshReset: 'ssh:reset',
  sshStats: 'ssh:stats',
  sshPromptResponse: 'ssh:prompt-response',

  sftpCall: 'sftp:call',
  sftpCancelTransfer: 'sftp:cancel-transfer',
  dragOutRegister: 'files:drag-out-register',
  showInFolder: 'app:show-in-folder',
  evTransfer: 'sftp:ev:transfer',

  // события главный процесс → окно
  evSshData: 'ssh:ev:data',
  evSshState: 'ssh:ev:state',
  evSshNotice: 'ssh:ev:notice',
  evSshInfo: 'ssh:ev:info',
  evSshPrompt: 'ssh:ev:prompt',
  evSshPromptCancel: 'ssh:ev:prompt-cancel'
} as const
