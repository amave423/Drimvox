import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("artel", {
  getToken: (): Promise<string> => ipcRenderer.invoke("artel:token"),
  setTitleBar: (colors: { background: string; symbols: string }) => ipcRenderer.send("artel:titlebar", colors),
});
