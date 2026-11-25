// Мост между окном и главным процессом. Окно не имеет доступа к Node.js —
// только к этому узкому набору функций (window.termion).

import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { TermionApi } from '@shared/api'
import { IPC } from '@shared/ipc'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const sftp = (op: string, args: Record<string, unknown>) => ipcRenderer.invoke(IPC.sftpCall, op, args)

const api: TermionApi = {
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
    openDataDir: () => ipcRenderer.invoke(IPC.openDataDir),
    openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
    showInFolder: (path) => ipcRenderer.invoke(IPC.showInFolder, path),
    onBeforeClose: (cb) =>
      subscribe<{ connections: number }>(IPC.evBeforeClose, (info) => {
        ipcRenderer.send(IPC.appCloseAck)
        cb(info).then(
          (proceed) => ipcRenderer.send(IPC.appCloseReady, proceed),
          () => ipcRenderer.send(IPC.appCloseReady, true)
        )
      })
  },
  sessions: {
    load: () => ipcRenderer.invoke(IPC.sessionsLoad),
    save: (tree) => ipcRenderer.invoke(IPC.sessionsSave, tree)
  },
  secrets: {
    status: (sessionId) => ipcRenderer.invoke(IPC.secretsStatus, sessionId),
    setPassword: (sessionId, password) => ipcRenderer.invoke(IPC.secretsSetPassword, sessionId, password)
  },
  settings: {
    load: () => ipcRenderer.invoke(IPC.settingsLoad),
    save: (settings) => ipcRenderer.invoke(IPC.settingsSave, settings)
  },
  dialogs: {
    pickKeyFile: () => ipcRenderer.invoke(IPC.dialogPickKey)
  },
  clipboard: {
    readText: () => ipcRenderer.invoke(IPC.clipboardRead),
    writeText: (text) => ipcRenderer.send(IPC.clipboardWrite, text)
  },
  ssh: {
    connect: (req) => ipcRenderer.invoke(IPC.sshConnect, req),
    write: (connId, data, binary) => ipcRenderer.send(IPC.sshWrite, connId, data, binary === true),
    resize: (connId, cols, rows) => ipcRenderer.send(IPC.sshResize, connId, cols, rows),
    ack: (connId, bytes) => ipcRenderer.send(IPC.sshAck, connId, bytes),
    disconnect: (connId) => ipcRenderer.send(IPC.sshDisconnect, connId),
    reset: () => ipcRenderer.invoke(IPC.sshReset),
    stats: (connId, mode) => ipcRenderer.invoke(IPC.sshStats, connId, mode),
    respond: (promptId, response) => ipcRenderer.send(IPC.sshPromptResponse, promptId, response),
    onData: (cb) => subscribe(IPC.evSshData, cb),
    onState: (cb) => subscribe(IPC.evSshState, cb),
    onNotice: (cb) => subscribe(IPC.evSshNotice, cb),
    onInfo: (cb) => subscribe(IPC.evSshInfo, cb),
    onPrompt: (cb) => subscribe(IPC.evSshPrompt, cb),
    onPromptCancel: (cb) => subscribe<string>(IPC.evSshPromptCancel, cb)
  },
  sftp: {
    home: (connId) => sftp('home', { connId }),
    list: (connId, path) => sftp('list', { connId, path }),
    stat: (connId, path) => sftp('stat', { connId, path }),
    readText: (connId, path) => sftp('readText', { connId, path }),
    writeText: (req) => sftp('writeText', { ...req }),
    mkdir: (connId, path) => sftp('mkdir', { connId, path }),
    createFile: (connId, path) => sftp('createFile', { connId, path }),
    rename: (connId, from, to) => sftp('rename', { connId, from, to }),
    remove: (connId, path) => sftp('remove', { connId, path }),
    download: (connId, paths) => sftp('download', { connId, paths }),
    upload: (connId, remoteDir, source) => sftp('upload', { connId, remoteDir, source }),
    cancelTransfer: (jobId) => ipcRenderer.send(IPC.sftpCancelTransfer, jobId),
    onTransfer: (cb) => subscribe(IPC.evTransfer, cb)
  },
  files: {
    pathForFile: (file) => webUtils.getPathForFile(file),
    registerDragOut: (token, connId, paths, title) => ipcRenderer.send(IPC.dragOutRegister, token, connId, paths, title)
  }
}

contextBridge.exposeInMainWorld('termion', api)
