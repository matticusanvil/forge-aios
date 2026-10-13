// What Forge's pages may ask the app for: setup steps, and a folder picker for the Projects page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('forgeDesktop', {
  status: () => ipcRenderer.invoke('status'),
  install: (what) => ipcRenderer.invoke('install', what),
  signIn: () => ipcRenderer.invoke('signIn'),
  pickFolder: () => ipcRenderer.invoke('pickFolder'),
  finish: (folder) => ipcRenderer.invoke('finish', folder),
});
