import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  shell,
  utilityProcess,
  protocol,
  screen,
} from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promises as fs } from "node:fs";
import type {
  Command,
  Snapshot,
  WindowKind,
  DesktopState,
} from "../shared/types.js";
import { parseCommand } from "./commands.js";
import { imageDocument } from "../core/exports.js";
import { readOwnedArtifact } from "../core/files.js";
import {
  restoreLayout,
  defaultRatios,
  type WindowLayout,
} from "./window-layout.js";
const here = path.dirname(fileURLToPath(import.meta.url));
const uiPath = path.join(here, "ui/index.html");
const trustedURL = pathToFileURL(uiPath).href;
app.setName("ytriple");
if (process.env.YTRIPLE_DATA_PATH)
  app.setPath("userData", path.resolve(process.env.YTRIPLE_DATA_PATH));
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on("second-instance", () => {
  const main = mainWindow;
  if (main) {
    main.show();
    main.focus();
  }
});
protocol.registerSchemesAsPrivileged([
  {
    scheme: "ytriple-artifact",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
let engine: ReturnType<typeof utilityProcess.fork> | undefined;
let latest: Snapshot | undefined;
let sequence = 0;
let closing = false;
let closed = false;
let mainWindow: BrowserWindow | undefined;
let layout: WindowLayout;
let desktopRevision = 0;
let movingWindow = false;
let layoutTimer: ReturnType<typeof setTimeout> | undefined;
let layoutWrites = Promise.resolve();
function desktopState(): DesktopState {
  return {
    mode: layout.mode,
    taskId: layout.taskId,
    revision: desktopRevision,
    collapsed: { ...layout.collapsed },
    ratios: { ...layout.ratios },
    expanded: layout.expanded,
    open: {
      main: !layout.expanded || layout.expanded === "main",
      evidence:
        layout.mode === "triple" &&
        (!layout.expanded || layout.expanded === "evidence"),
      artifact:
        layout.mode === "triple" &&
        (!layout.expanded || layout.expanded === "artifact"),
    },
  };
}
function persistLayout(): void {
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(() => {
    void writeLayout();
  }, 200);
}
function writeLayout(): Promise<void> {
  const data = JSON.stringify(layout);
  const root = app.getPath("userData");
  layoutWrites = layoutWrites
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const temp = path.join(root, `.window-layout-${process.pid}.tmp`);
      await fs.writeFile(temp, data, { mode: 0o600 });
      await fs.rename(temp, path.join(root, "window-layout.json"));
    });
  return layoutWrites.catch(() => {});
}
function desktopChanged(): void {
  desktopRevision++;
  persistLayout();
  if (latest) publish(latest);
}
function selectTask(taskId: string | null): void {
  if (taskId && !latest?.tasks.some((t) => t.id === taskId))
    throw new Error("任务不存在。");
  if (layout.taskId !== taskId) {
    layout.taskId = taskId;
    desktopChanged();
  }
}
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (reason: Error) => void }
>();
let vault: Record<string, string> = {};
function request<T = Snapshot>(payload: Record<string, unknown>): Promise<T> {
  if (!engine)
    return Promise.reject(new Error("工作引擎已退出，请重新打开应用。"));
  const id = ++sequence;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: (value) => resolve(value as T), reject });
    engine!.postMessage({ id, ...payload });
  });
}
function decorate(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    desktop: desktopState(),
    library: snapshot.library?.map((entry) =>
      entry.format === "png"
        ? { ...entry, previewURL: `ytriple-artifact://library/${entry.id}` }
        : entry,
    ),
    tasks: snapshot.tasks.map((task) => ({
      ...task,
      artifacts: task.artifacts.map((artifact) =>
        artifact.format === "png"
          ? {
              ...artifact,
              previewURL: `ytriple-artifact://local/${task.id}/${artifact.id}`,
            }
          : artifact,
      ),
    })),
  };
}
function publish(snapshot: Snapshot): Snapshot {
  latest = decorate(snapshot);
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send("ytriple:snapshot", latest);
  return latest;
}
async function loadVault(): Promise<Record<string, string>> {
  try {
    vault = JSON.parse(
      await fs.readFile(
        path.join(app.getPath("userData"), "keys.enc.json"),
        "utf8",
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("本机密钥文件无法读取，请检查系统钥匙串。");
  }
  const keys: Record<string, string> = {};
  if (Object.keys(vault).length && !safeStorage.isEncryptionAvailable())
    throw new Error("系统钥匙串当前不可用，无法解锁已保存的模型连接。");
  for (const [id, encrypted] of Object.entries(vault))
    keys[id] = safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  return keys;
}
async function saveKey(profileId: string, value: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("系统密钥保护不可用，请使用环境变量配置密钥。");
  const next = { ...vault };
  if (value.trim())
    next[profileId] = safeStorage
      .encryptString(value.trim())
      .toString("base64");
  else delete next[profileId];
  const root = app.getPath("userData");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const temp = path.join(root, `.keys-${process.pid}.tmp`);
  await fs.writeFile(temp, JSON.stringify(next), { mode: 0o600 });
  await fs.rename(temp, path.join(root, "keys.enc.json"));
  vault = next;
  await request({ type: "key", profileId, apiKey: value.trim() });
}
function applyBounds(): void {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    mainWindow.isFullScreen() ||
    mainWindow.isMaximized()
  )
    return;
  movingWindow = true;
  try {
    mainWindow.setMinimumSize(
      Math.min(900, layout.bounds.width),
      Math.min(600, layout.bounds.height),
    );
    mainWindow.setBounds(layout.bounds);
  } finally {
    movingWindow = false;
  }
}
function openWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return mainWindow;
  }
  const win = new BrowserWindow({
    ...layout.bounds,
    minWidth: Math.min(900, layout.bounds.width),
    minHeight: Math.min(600, layout.bounds.height),
    show: false,
    title: "ytriple · 工作台",
    backgroundColor: "#F5F6F3",
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  mainWindow = win;
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  const remember = () => {
    if (
      movingWindow ||
      win.isDestroyed() ||
      win.isMinimized() ||
      win.isFullScreen() ||
      win.isMaximized()
    )
      return;
    layout.bounds = win.getNormalBounds();
    persistLayout();
  };
  win.on("resize", remember);
  win.on("move", remember);
  win.on("closed", () => {
    mainWindow = undefined;
    if (!closing) app.quit();
  });
  win.once("ready-to-show", () => {
    win.show();
    desktopChanged();
  });
  void win.loadFile(uiPath);
  return win;
}
function setLayout(mode: DesktopState["mode"], reset = false): void {
  layout.mode = mode;
  layout.expanded = null;
  if (mode === "single") layout.collapsed.main = false;
  if (reset) {
    layout.ratios = defaultRatios();
    layout.collapsed = { main: false, evidence: false, artifact: false };
  }
  desktopChanged();
}
function focusPane(kind: WindowKind): void {
  if (kind !== "main") layout.mode = "triple";
  layout.expanded = null;
  layout.collapsed[kind] = false;
  desktopChanged();
}
async function renderPNG(
  command: Extract<Command, { type: "artifact.export" }>,
): Promise<Snapshot> {
  const snapshot = await request({
    type: "command",
    command: { type: "snapshot" },
  });
  const task = snapshot.tasks.find((t) => t.id === command.taskId);
  const artifact = task?.artifacts.find((a) => a.id === command.artifactId);
  if (!task || !artifact || !["md", "html"].includes(artifact.format))
    throw new Error("请选择文字或 HTML 成果导出。");
  const document = imageDocument(artifact);
  const canvas = new BrowserWindow({
    show: false,
    width: 1400,
    height: 100,
    useContentSize: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: true,
      partition: "ytriple-export",
    },
  });
  canvas.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  canvas.webContents.on("will-navigate", (event) => event.preventDefault());
  canvas.webContents.session.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !details.url.startsWith("data:") }),
  );
  try {
    await canvas.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(document)}`,
    );
    const height = (await canvas.webContents.executeJavaScript(
      "Math.ceil(Math.max(document.body.scrollHeight, document.documentElement.scrollHeight))",
    )) as number;
    if (height > 10000)
      throw new Error("信息图过长，请先让团队精简内容或拆分后导出。");
    canvas.setContentSize(1400, Math.max(900, height));
    await canvas.webContents.executeJavaScript(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    const png = (await canvas.webContents.capturePage()).toPNG();
    return await request({
      type: "command",
      command: {
        type: "artifact.exportPNG",
        taskId: task.id,
        artifactId: artifact.id,
        expectedHash: artifact.hash,
        goalVersion: task.goalVersion,
        png,
      },
    });
  } finally {
    canvas.destroy();
  }
}
async function command(input: Command): Promise<Snapshot> {
  if (input.type === "window.open") {
    if (!latest?.tasks.some((t) => t.id === input.taskId))
      throw new Error("任务不存在。");
    selectTask(input.taskId);
    focusPane(input.window);
    return latest!;
  }
  if (input.type === "window.select") {
    selectTask(input.taskId);
    return latest!;
  }
  if (input.type === "window.layout") {
    setLayout(input.mode, input.reset);
    return latest!;
  }
  if (input.type === "window.collapse") {
    layout.collapsed[input.window] = input.collapsed;
    if (layout.expanded === input.window && input.collapsed)
      layout.expanded = null;
    desktopChanged();
    return latest!;
  }
  if (input.type === "window.focus") {
    focusPane(input.window);
    return latest!;
  }
  if (input.type === "window.resize") {
    layout.ratios = { main: input.main, evidence: input.evidence };
    desktopChanged();
    return latest!;
  }
  if (input.type === "window.expand") {
    layout.expanded = input.window;
    if (input.window) {
      layout.collapsed[input.window] = false;
      if (input.window !== "main") layout.mode = "triple";
    }
    desktopChanged();
    return latest!;
  }
  if (input.type === "url.open") {
    const url = new URL(input.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("只能打开网页链接。");
    await shell.openExternal(url.href);
    return latest!;
  }
  if (input.type === "path.reveal") {
    const allowed = latest && [
      latest.dataPath,
      latest.settings.aiRoot,
      latest.system.policyPath,
      latest.settings.codeRoot,
      latest.settings.workspaceRoot,
      ...(latest.library ?? []).flatMap((entry) => [
        entry.path,
        ...entry.versions.map((v) => v.path),
      ]),
      ...latest.projects.flatMap((p) => [
        p.root,
        p.devPath,
        ...Object.values(p.documents).filter((p): p is string => !!p),
      ]),
      ...latest.tasks.flatMap((t) => [
        t.workspace,
        ...t.artifacts.flatMap((a) => [
          a.path,
          ...a.versions.map((v) => v.path),
        ]),
        ...t.sources.filter((s) => s.type === "file").map((s) => s.location),
      ]),
    ];
    if (!allowed?.includes(input.path))
      throw new Error("路径不属于当前工作台记录。");
    shell.showItemInFolder(input.path);
    return latest!;
  }
  if (input.type === "source.import") {
    const dialogParent = BrowserWindow.getFocusedWindow() || mainWindow;
    if (!dialogParent) throw new Error("请先打开工作台窗口。");
    const choice = await dialog.showOpenDialog(dialogParent, {
      title: "导入工作资料",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "常用文档",
          extensions: ["md", "txt", "json", "csv", "pdf", "docx", "doc"],
        },
      ],
    });
    if (choice.canceled) return latest!;
    return request({
      type: "command",
      command: {
        type: "source.import.paths",
        taskId: input.taskId,
        paths: choice.filePaths,
      },
    });
  }
  if (input.type === "profile.save") {
    if (input.apiKey !== undefined)
      await saveKey(input.profile.id, input.apiKey);
    const { apiKey: _key, ...withoutKey } = input;
    return request({ type: "command", command: withoutKey });
  }
  if (input.type === "artifact.export" && input.format === "png")
    return renderPNG(input);
  return request({ type: "command", command: input });
}
app
  .whenReady()
  .then(async () => {
    let savedLayout: unknown;
    try {
      savedLayout = JSON.parse(
        await fs.readFile(
          path.join(app.getPath("userData"), "window-layout.json"),
          "utf8",
        ),
      );
    } catch {
      /* Missing or invalid geometry uses the current display. */
    }
    layout = restoreLayout(
      savedLayout,
      screen.getAllDisplays().map((d) => d.workArea),
      screen.getPrimaryDisplay().workArea,
    );
    const keys = await loadVault();
    protocol.handle("ytriple-artifact", async (request) => {
      try {
        const url = new URL(request.url);
        if (url.search || url.hash) return new Response(null, { status: 404 });
        let bytes: Buffer;
        if (url.hostname === "library") {
          const parts = url.pathname.split("/");
          const entry =
            parts.length === 2 &&
            latest?.library?.find(
              (e) => e.id === parts[1] && e.format === "png",
            );
          if (!entry || !latest) return new Response(null, { status: 404 });
          bytes = await readOwnedArtifact(
            { ...entry, goalVersion: entry.source.goalVersion },
            path.join(latest.settings.aiRoot, "knowledge", "lib"),
          );
        } else {
          const parts = url.pathname.split("/");
          if (url.hostname !== "local" || parts.length !== 3)
            return new Response(null, { status: 404 });
          const task = latest?.tasks.find((t) => t.id === parts[1]);
          const artifact = task?.artifacts.find(
            (a) => a.id === parts[2] && a.format === "png",
          );
          if (!task || !artifact) return new Response(null, { status: 404 });
          bytes = await readOwnedArtifact(artifact, task.workspace);
        }
        return new Response(new Uint8Array(bytes), {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      } catch {
        return new Response(null, { status: 404 });
      }
    });
    engine = utilityProcess.fork(path.join(here, "worker.js"), [], {
      serviceName: "ytriple 工作引擎",
      stdio: "pipe",
    });
    engine.stdout?.resume();
    engine.stderr?.resume();
    engine.on("message", (message) => {
      if (message.type === "snapshot") {
        publish(message.snapshot);
        return;
      }
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error));
      else item.resolve(message.value);
    });
    engine.on("exit", () => {
      engine = undefined;
      for (const waiter of pending.values())
        waiter.reject(
          new Error("工作引擎已退出，已保存的任务可在重新打开应用后继续。"),
        );
      pending.clear();
      if (!closing)
        dialog.showErrorBox(
          "工作引擎已退出",
          "请重新打开 ytriple。已保存的记录保留，未完成任务会显示为暂停。",
        );
    });
    publish(
      await request({
        type: "initialize",
        dataPath: app.getPath("userData"),
        keys,
      }),
    );
    ipcMain.handle("ytriple:command", async (event, input: unknown) => {
      if (
        !event.senderFrame ||
        event.senderFrame !== event.sender.mainFrame ||
        event.senderFrame.url.split("?")[0] !== trustedURL ||
        mainWindow?.webContents !== event.sender
      )
        throw new Error("无效的工作台连接。");
      return publish(await command(parseCommand(input)));
    });
    if (layout.taskId && !latest?.tasks.some((t) => t.id === layout.taskId))
      layout.taskId = null;
    if (savedLayout === undefined && latest?.tasks.length)
      layout.taskId = latest.tasks[0].id;
    openWindow();
    const recoverDisplays = () => {
      layout = restoreLayout(
        layout,
        screen.getAllDisplays().map((d) => d.workArea),
        screen.getPrimaryDisplay().workArea,
      );
      applyBounds();
      desktopChanged();
    };
    screen.on("display-removed", recoverDisplays);
    screen.on("display-metrics-changed", recoverDisplays);
  })
  .catch((error) => {
    dialog.showErrorBox(
      "ytriple 启动失败",
      error instanceof Error ? error.message : "无法启动本地工作引擎。",
    );
    app.exit(1);
  });
app.on("before-quit", (event) => {
  if (closed) return;
  event.preventDefault();
  if (closing) return;
  closing = true;
  clearTimeout(layoutTimer);
  void Promise.all([
    engine ? request({ type: "close" }).catch(() => {}) : Promise.resolve(),
    writeLayout(),
  ]).finally(() => {
    closed = true;
    engine?.kill();
    app.quit();
  });
});
app.on("window-all-closed", () => app.quit());
