const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("worldCupMagic", {
  getDashboard: () => ipcRenderer.invoke("dashboard:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  scan: (settings) => ipcRenderer.invoke("scan:run", settings),
  openDataFolder: () => ipcRenderer.invoke("report:openData"),
  onScanCompleted: (callback) => {
    ipcRenderer.on("scan:completed", callback);
  },
  onScanError: (callback) => {
    ipcRenderer.on("scan:error", (_event, message) => callback(message));
  }
});
