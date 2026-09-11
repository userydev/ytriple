import { contextBridge, ipcRenderer } from "electron";
import type { WorkbenchAPI } from "../shared/types.js";
const api: WorkbenchAPI = {
  invoke: (command) => ipcRenderer.invoke("ytriple:command", command),
  subscribe: (listener) => {
    const wrapped = (
      _event: unknown,
      snapshot: Parameters<typeof listener>[0],
    ) => listener(snapshot);
    ipcRenderer.on("ytriple:snapshot", wrapped);
    return () => ipcRenderer.removeListener("ytriple:snapshot", wrapped);
  },
};
contextBridge.exposeInMainWorld("ytriple", api);
