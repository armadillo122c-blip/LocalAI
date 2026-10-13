'use strict';

// Safe bridge between the UI and the main process. The renderer has no Node access.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

function subscribe(channel) {
  return (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('api', {
  appInfo: invoke('app:info'),

  getSettings: invoke('settings:get'),
  saveSettings: invoke('settings:save'),
  savePersona: invoke('personas:save'),
  deletePersona: invoke('personas:delete'),
  resetPersona: invoke('personas:reset'),

  ollamaStatus: invoke('ollama:status'),
  listModels: invoke('ollama:models'),
  modelInfo: invoke('ollama:modelInfo'),

  pickProject: invoke('project:pick'),
  setProject: invoke('project:set'),
  removeRecentProject: invoke('project:removeRecent'),
  revealProject: invoke('project:reveal'),

  listChats: invoke('chats:list'),
  loadChat: invoke('chats:load'),
  deleteChat: invoke('chats:delete'),
  renameChat: invoke('chats:rename'),

  pickAttachments: invoke('files:pick'),
  readAttachments: invoke('files:read'),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },

  send: invoke('agent:send'),
  stop: invoke('agent:stop'),
  approve: invoke('agent:approve'),
  undoChange: invoke('changes:undo'),

  runTerminal: invoke('terminal:run'),
  killTerminal: invoke('terminal:kill'),

  openExternal: invoke('shell:openExternal'),

  onAgentEvent: subscribe('agent:event'),
  onTerminalEvent: subscribe('terminal:event'),
  onChatsChanged: subscribe('chats:changed'),
});
