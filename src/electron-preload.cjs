const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexSync", {
  listProfiles: () => ipcRenderer.invoke("profiles:list"),
  listProjects: (payload) => ipcRenderer.invoke("projects:list", payload),
  runSync: (payload) => ipcRenderer.invoke("sync:run", payload),
  runProviderClone: (payload) => ipcRenderer.invoke("provider-clone:run", payload),
  runExport: (payload) => ipcRenderer.invoke("export:run", payload),
  runImport: (payload) => ipcRenderer.invoke("import:run", payload),
  pickFolder: () => ipcRenderer.invoke("folder:pick"),
  pickExportFolder: () => ipcRenderer.invoke("folder:save-export"),
});
