const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (payload) => ipcRenderer.invoke('settings:save', payload),
  revealKey: () => ipcRenderer.invoke('settings:reveal'),
  testKey: (payload) => ipcRenderer.invoke('gemini:test', payload || {}),
  listNotes: () => ipcRenderer.invoke('notes:list'),
  saveNote: (note) => ipcRenderer.invoke('notes:save', note),
  deleteNote: (id) => ipcRenderer.invoke('notes:delete', id),
  listChats: () => ipcRenderer.invoke('chats:list'),
  saveChat: (chat) => ipcRenderer.invoke('chats:save', chat),
  deleteChat: (id) => ipcRenderer.invoke('chats:delete', id),
  chat: (payload) => ipcRenderer.invoke('gemini:chat', payload),
  cleanupNote: (payload) => ipcRenderer.invoke('gemini:cleanup', payload),
  transcribe: (payload) => ipcRenderer.invoke('gemini:transcribe', payload),
  openDataDir: () => ipcRenderer.invoke('shell:open-data'),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  onMenuAction: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('menu:action', listener);
    return () => ipcRenderer.removeListener('menu:action', listener);
  },
});
