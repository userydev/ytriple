import { contextBridge, ipcRenderer } from "electron";
import type { Command } from "../core/commands";
import type { Snapshot } from "../core/types";
contextBridge.exposeInMainWorld("ytriple", {
  command: (input: Command) => ipcRenderer.invoke("workbench:command", input),
  subscribe: (callback: (snapshot: Snapshot) => void) => {
    const listener = (_: unknown, snapshot: Snapshot) => callback(snapshot);
    ipcRenderer.on("workbench:changed", listener);
    return () => ipcRenderer.removeListener("workbench:changed", listener);
  },
});
