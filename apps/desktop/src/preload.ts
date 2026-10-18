import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("artel", {
  getToken: (): Promise<string> => ipcRenderer.invoke("artel:token"),
  setTitleBar: (colors: { background: string; symbols: string }) => ipcRenderer.send("artel:titlebar", colors),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("artel:pick-folder"),
  openSkillsFolder: () => ipcRenderer.send("artel:open-skills"),
  notify: (notice: { title: string; body: string; taskId: string }) => ipcRenderer.send("artel:notify", notice),
  testNotify: (notice: { title: string; body: string }) => ipcRenderer.send("artel:notify-test", notice),
  updateState: () => ipcRenderer.invoke("artel:update-state"),
  onUpdate: (listener: (state: unknown) => void) => {
    const handler = (_event: unknown, state: unknown) => listener(state);
    ipcRenderer.on("artel:update", handler);
    return () => void ipcRenderer.removeListener("artel:update", handler);
  },
  installUpdate: () => ipcRenderer.send("artel:update-install"),
  checkUpdates: () => ipcRenderer.send("artel:update-check"),
  onOpenTask: (listener: (taskId: string) => void) => {
    const handler = (_event: unknown, taskId: unknown) => typeof taskId === "string" && listener(taskId);
    ipcRenderer.on("artel:open-task", handler);
    return () => void ipcRenderer.removeListener("artel:open-task", handler);
  },
});
