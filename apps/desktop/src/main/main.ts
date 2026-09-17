import { ModelConnections } from "../core/model-connections";
import { Accounts } from "../core/accounts";
import { WorkspaceBackups } from "../core/workspace-backup";
import { Methods } from "../core/methods";
import { Schedules } from "../core/schedules";
import { Feeds } from "../core/feeds";
import { RadarWatches } from "../core/radar-watches";
import { Skills } from "../core/skills";
import { Outcomes } from "../core/outcomes";
import { ProjectFiles } from "../core/project-files";
import { LocalSystem } from "../core/local-system";
import {
  ProjectInitialization,
  type InitializationPlan,
} from "../core/project-initialization";
import {
  ProjectSuggestions,
  type SuggestionDocument,
} from "../core/project-suggestions";
import { ProcessRecords } from "../core/process";
import { versionLabel } from "../core/output";
import { Assets } from "../core/assets";
import { LocalDirectories } from "../core/local-directories";
import { homedir } from "node:os";
import { Projects } from "../core/projects";
import { Decisions } from "../core/decisions";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  safeStorage,
  session,
  shell,
} from "electron";
import { readFile, writeFile, stat } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve, extname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store";
import { Runtime } from "../core/runtime";
import { Radar } from "../core/radar";
import { Artifacts } from "../core/artifacts";
import { YCore } from "../core/ycore";
import { commandSchema } from "../core/commands";
import type {
  ArtifactVersion,
  Material,
  Reference,
  ServiceStatus,
  Snapshot,
  Project,
  Work,
} from "../core/types";
protocol.registerSchemesAsPrivileged([
  {
    scheme: "ytriple",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
app.setName("ytriple");
// The retired implementation used the parent ytriple directory and a different
// database schema. Never open or implicitly migrate that database.
const dataRoot =
  process.env.YTRIPLE_DATA_DIR ??
  join(app.getPath("appData"), "ytriple", "desktop-v1");
mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
app.setPath("userData", dataRoot);
let buildId = "development";
if (app.isPackaged) {
  const release = JSON.parse(
    readFileSync(join(app.getAppPath(), "release.json"), "utf8"),
  );
  if (
    !/^[a-f0-9]{16}$/.test(release.buildId) ||
    release.version !== app.getVersion()
  )
    throw Error("安装包版本信息不完整");
  buildId = release.buildId;
}
app.setAboutPanelOptions({
  applicationName: "ytriple",
  applicationVersion: app.getVersion(),
  version: buildId,
});
let window: BrowserWindow,
  store: Store,
  runtime: Runtime,
  schedules: Schedules,
  feeds: Feeds,
  radarWatches: RadarWatches,
  radar: Radar,
  client: YCore | undefined;
let models: ModelConnections;
let accounts: Accounts;
const vault = {
  available: () =>
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== "linux" ||
      safeStorage.getSelectedStorageBackend() !== "basic_text"),
  encrypt: (text: string) => safeStorage.encryptString(text),
  decrypt: (bytes: Buffer) => safeStorage.decryptString(bytes),
};
function modelScope() {
  try {
    return models.model().scope;
  } catch {
    return undefined;
  }
}
function assertModelChange(scope: string) {
  runtime.assertCanChangeProvider(scope);
  radar.assertCanChangeProvider(scope);
}
function pauseModelAutomation() {
  const scope = modelScope();
  store.transaction(() => {
    for (const kind of ["schedule", "radar-watch"])
      for (const item of store.all<any>(kind))
        if (item.enabled && item.serviceScope !== scope)
          store.put(kind, item.id, {
            ...item,
            enabled: false,
            nextAt: null,
            ...(kind === "schedule"
              ? { pauseReason: "模型连接变化，请检查范围后重新保存" }
              : {
                  revision: item.revision + 1,
                  error: "模型连接变化，请检查范围后重新保存",
                }),
          });
  });
}
let service: ServiceStatus = {
  configured: false,
  baseUrl: "https://core.ydev.work",
  connected: false,
  ai: false,
  error: null,
};
let configuring = false;
let backups: WorkspaceBackups;
let activeDataDir: string;
let space: Snapshot["workspace"];
let commandsInFlight = 0;
let switching = false;
let notification: ReturnType<typeof setTimeout> | undefined;
function snapshot(): Snapshot {
  return {
    ...store.snapshot(),
    service: { ...service, account: accounts?.info() },
    workspace: space,
    model: models?.info(),
    desktop: {
      version: app.getVersion(),
      buildId,
      packaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      dataDirectory: activeDataDir,
    },
  };
}
function changed() {
  if (notification) return;
  notification = setTimeout(() => {
    notification = undefined;
    if (window && !window.isDestroyed())
      window.webContents.send("workbench:changed", snapshot());
  }, 60);
}
async function connect() {
  try {
    if (accounts?.enabled) {
      const candidate = await accounts.connect();
      if (models?.info().mode === "service" && runtime && radar)
        assertModelChange(candidate.scope);
      client = candidate;
    }
    if (!client) throw Error("请先配置服务连接");
    const data = await client.capabilities();
    service = {
      ...service,
      configured: true,
      connected: true,
      ai: data.ai === true,
      error: null,
    };
  } catch (e) {
    service = {
      ...service,
      connected: false,
      ai: false,
      error: e instanceof Error ? e.message : "服务连接失败",
    };
    throw e;
  } finally {
    changed();
  }
  return service;
}
async function changeService<T>(fn: () => Promise<T>) {
  if (configuring) throw Error("服务连接正在更新，请稍候");
  configuring = true;
  schedules.shutdown();
  radarWatches.shutdown();
  try {
    return await fn();
  } finally {
    configuring = false;
    schedules.start();
    radarWatches.start();
    changed();
  }
}
function accountModelGuard(scope: string) {
  if (models.info().mode === "service") assertModelChange(scope);
}
async function captureFile(path: string, existing?: Material) {
  const material = existing ?? store.addMaterial(basename(path), "", "unread");
  store.put("local-source", material.id, { path });
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 1024 * 1024)
      throw Error("请选择 1MB 以内的文本文件");
    const bytes = await readFile(path);
    if (bytes.byteLength > 1024 * 1024)
      throw Error("请选择 1MB 以内的文本文件");
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw Error("文件不是有效的 UTF-8 文本，请另存为 UTF-8 后重新读取");
    }
    return store.put("material", `${material.id}@${material.version}`, {
      ...material,
      body: content,
      coverage: "local_text",
      readError: undefined,
    });
  } catch (e) {
    return store.put("material", `${material.id}@${material.version}`, {
      ...material,
      readError: e instanceof Error ? e.message : "材料读取失败",
    });
  }
}
async function configPath() {
  const dir = activeDataDir;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, "service.json");
}
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on("second-instance", () => {
  if (window && !window.isDestroyed()) {
    window.show();
    window.focus();
  }
});
app
  .whenReady()
  .then(async () => {
    const baseDataDir = app.getPath("userData");
    mkdirSync(baseDataDir, { recursive: true, mode: 0o700 });
    backups = new WorkspaceBackups(baseDataDir);
    activeDataDir = await backups.currentDirectory();
    const info = await backups.info();
    space = {
      id: info.currentId,
      name: info.currentName,
      startupError: info.startupError,
    };
    store = new Store(join(activeDataDir, "workbench.sqlite"));
    store.initializeConfiguration();
    new Skills(store).initialize();
    store.recover();
    await new LocalDirectories(store).discover(homedir());
    await new LocalDirectories(store).refresh();
    const path = await configPath();
    accounts = new Accounts(activeDataDir, vault, () => {
      if (accounts.info().state === "relogin") {
        service = {
          ...service,
          connected: false,
          ai: false,
          error: accounts.info().error,
        };
      }
      changed();
    });
    if (accounts.enabled) {
      service.baseUrl = accounts.baseUrl;
      if (accounts.info().state === "signed_in") {
        try {
          client = await accounts.connect();
        } catch {
          service.error = accounts.info().error;
        }
      } else service.error = accounts.info().error;
    } else if (process.env.YCORE_TOKEN) {
      service.baseUrl = process.env.YCORE_BASE_URL ?? service.baseUrl;
      client = new YCore(service.baseUrl, process.env.YCORE_TOKEN);
    } else if (existsSync(path)) {
      try {
        const config = JSON.parse(await readFile(path, "utf8"));
        if (vault.available()) {
          service.baseUrl = config.baseUrl;
          client = new YCore(
            config.baseUrl,
            safeStorage.decryptString(Buffer.from(config.encrypted, "base64")),
          );
        }
      } catch {
        service.error = "服务配置无法读取，请重新连接";
      }
    }
    service.configured = !!client;
    models = new ModelConnections(
      store,
      activeDataDir,
      vault,
      () => client,
      process.env.YTRIPLE_DIRECT_BASE_URL && process.env.YTRIPLE_DIRECT_MODEL
        ? {
            profile: {
              baseUrl: process.env.YTRIPLE_DIRECT_BASE_URL,
              model: process.env.YTRIPLE_DIRECT_MODEL,
              maxOutputTokens: 4096,
              tokenParameter: "max_tokens",
            },
            token: process.env.YTRIPLE_DIRECT_KEY ?? "",
          }
        : undefined,
    );
    runtime = new Runtime(store, () => models.model(), changed);
    radar = new Radar(store, () => models.model(), changed);
    radar.recover();
    schedules = new Schedules(store, runtime, () => modelScope(), changed);
    feeds = new Feeds(
      store,
      () => {
        if (!client) throw Error("先在设置中连接信息服务");
        return client;
      },
      changed,
    );
    feeds.recover();
    radarWatches = new RadarWatches(store, radar, () => modelScope(), changed);
    radarWatches.recover();
    const out = resolve(__dirname, "../out");
    protocol.handle("ytriple", async (request) => {
      const url = new URL(request.url);
      if (url.hostname !== "app")
        return new Response("Not found", { status: 404 });
      const file = resolve(
        out,
        "." +
          decodeURIComponent(
            url.pathname === "/" ? "/index.html" : url.pathname,
          ),
      );
      if (!file.startsWith(out + "/"))
        return new Response("Forbidden", { status: 403 });
      try {
        const data = await readFile(file);
        return new Response(data, {
          headers: {
            "Content-Type":
              (
                {
                  ".html": "text/html",
                  ".js": "text/javascript",
                  ".css": "text/css",
                  ".svg": "image/svg+xml",
                } as Record<string, string>
              )[extname(file)] ?? "application/octet-stream",
            "Content-Security-Policy":
              "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'",
          },
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    });
    window = new BrowserWindow({
      width: 1440,
      height: 980,
      minWidth: 860,
      minHeight: 650,
      title: "ytriple",
      backgroundColor: "#fafaf8",
      webPreferences: {
        preload: join(__dirname, "preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith("ytriple://app/")) event.preventDefault();
    });
    session.defaultSession.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    ipcMain.handle("workbench:command", async (event, raw) => {
      if (
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        !event.senderFrame.url.startsWith("ytriple://app/")
      )
        throw Error("不允许的调用来源");
      const parsed = commandSchema.safeParse(raw);
      if (!parsed.success) throw Error(parsed.error.issues[0].message);
      const input = parsed.data;
      if (switching) throw Error("正在切换工作空间，请稍候");
      commandsInFlight++;
      try {
        let result: unknown;
        switch (input.type) {
          case "account-sign-in":
            return changeService(async () => {
              client = await accounts.signIn(
                input.baseUrl,
                input.email,
                input.password,
                accountModelGuard,
              );
              service = {
                configured: !!client,
                baseUrl: accounts.baseUrl,
                connected: false,
                ai: false,
                error: accounts.info().error,
              };
              pauseModelAutomation();
              if (client) await connect();
              return accounts.info();
            });
          case "account-sign-out":
            return changeService(async () => {
              await accounts.signOut(accountModelGuard);
              client = undefined;
              service = {
                configured: false,
                baseUrl: accounts.baseUrl,
                connected: false,
                ai: false,
                error: accounts.info().error,
              };
              pauseModelAutomation();
              return accounts.info();
            });
          case "model-save":
            if (configuring) throw Error("连接正在更新或测试，请稍候");
            result = models.save(
              input.profile,
              input.token,
              input.noKey,
              assertModelChange,
            );
            pauseModelAutomation();
            break;
          case "model-select":
            if (configuring) throw Error("连接正在更新或测试，请稍候");
            result = models.select(input.mode, assertModelChange);
            pauseModelAutomation();
            break;
          case "model-test":
            if (configuring) throw Error("连接正在更新或测试，请稍候");
            configuring = true;
            try {
              result = await models.test();
            } finally {
              configuring = false;
              changed();
            }
            break;
          case "abandon-local-run":
            runtime.abandonLocal(input.runId);
            break;
          case "abandon-local-radar":
            radar.abandonLocal(input.jobId);
            break;
          case "workspace-info":
            result = await backups.info();
            break;
          case "workspace-export": {
            const selected = await dialog.showSaveDialog(window, {
              title: "备份当前工作空间",
              defaultPath: `ytriple-${new Date().toISOString().slice(0, 10)}.ytriple-backup`,
              filters: [
                {
                  name: "ytriple 工作空间备份",
                  extensions: ["ytriple-backup"],
                },
              ],
            });
            if (!selected.canceled && selected.filePath)
              result = await backups.export(store, selected.filePath);
            break;
          }
          case "workspace-inspect": {
            const selected = await dialog.showOpenDialog(window, {
              title: "选择工作空间备份",
              properties: ["openFile"],
              filters: [
                {
                  name: "ytriple 工作空间备份",
                  extensions: ["ytriple-backup"],
                },
              ],
            });
            if (!selected.canceled && selected.filePaths[0])
              result = await backups.inspect(selected.filePaths[0]);
            break;
          }
          case "workspace-restore":
            result = await backups.restore(
              input.previewId,
              input.name,
              new LocalDirectories(store).roots(),
            );
            break;
          case "workspace-switch": {
            if (input.id === space?.id) break;
            if (
              commandsInFlight > 1 ||
              configuring ||
              store.all<any>("run").some((r) => r.status === "running") ||
              store.all<any>("radar-job").some((r) => r.status === "running") ||
              store.all<any>("feed-check").some((r) => r.status === "running")
            )
              throw Error("当前还有操作或任务运行，请等待完成或停止后再切换");
            switching = true;
            schedules.shutdown();
            feeds.shutdown();
            radarWatches.shutdown();
            try {
              await backups.select(input.id);
            } catch (error) {
              switching = false;
              schedules.start();
              feeds.start();
              radarWatches.start();
              throw error;
            }
            setTimeout(() => {
              app.relaunch();
              app.quit();
            }, 300);
            result = { restarting: true };
            break;
          }
          case "feed-preview":
            result = await feeds.preview(input.url);
            break;
          case "feed-add":
            result = feeds.add(
              input.previewId,
              input.name,
              input.intervalMinutes,
              input.enabled,
            );
            break;
          case "feed-update":
            result = feeds.update(input.id, input.revision, input.patch);
            break;
          case "feed-refresh":
            result = await feeds.refresh(input.id);
            break;
          case "feed-stop":
            feeds.stop(input.id);
            break;
          case "schedule-save":
            result = schedules.save(input.input);
            break;
          case "schedule-enabled":
            result = schedules.setEnabled(
              input.id,
              input.revision,
              input.enabled,
            );
            break;
          case "schedule-now":
            result = schedules.runNow(input.id, input.revision, input.key);
            break;
          case "schedule-stop":
            result = schedules.stopOccurrence(input.occurrenceId);
            break;
          case "inspect-local-system":
            result = await new LocalSystem(store).inspect();
            break;
          case "preview-local-system":
            result = await new LocalSystem(store).preview();
            break;
          case "execute-local-system":
            result = await new LocalSystem(store).execute(input.planId);
            break;
          case "initialization-form":
            store.require<Project>("project", input.projectId);
            result = input.form
              ? store.put("initialization-form", input.projectId, input.form)
              : store.get("initialization-form", input.projectId);
            break;
          case "preview-initialization":
            result = await new ProjectInitialization(store).preview(
              input.input,
            );
            break;
          case "execute-initialization":
            result = await new ProjectInitialization(store).execute(
              input.planId,
            );
            break;
          case "read-initialization":
            result = store.require<InitializationPlan>(
              "initialization",
              input.planId,
            );
            break;
          case "radar-watch-save":
            result = radarWatches.save(input.input);
            break;
          case "radar-topic":
            return radar.saveTopic(input.topic);
          case "radar-refresh":
            if (configuring) throw Error("服务连接正在更新，请稍后整理");
            return radar.refresh(input.topicId, input.retry);
          case "radar-stop":
            return radar.stop(input.jobId);
          case "radar-reconcile":
            return radar.reconcile(input.jobId);
          case "radar-reference":
            return radar.reference(input.editionId);
          case "radar-reading":
            return radar.reading(input.editionId, input.patch);
          case "layout":
            return store.saveLayout(input.layout);
          case "view":
            return store.saveView(input.view);
          case "snapshot":
            return snapshot();
          case "connect":
            return changeService(connect);
          case "save-team":
            result = store.saveTeam(input.team);
            break;
          case "save-workflow":
            result = store.saveWorkflow(input.workflow);
            break;
          case "select-configuration":
            store.selectConfiguration(
              input.workId,
              input.teamKey,
              input.workflowKey,
            );
            break;
          case "update-work":
            result = store.updateWork(
              input.workId,
              input.title,
              input.projectId,
              input.deliveryId,
            );
            break;
          case "clear-adoption":
            store.clearAdoption(input.deliveryId, input.expectedVersionId);
            break;
          case "configure": {
            if (accounts.info().state === "signed_in")
              throw Error("请先退出账号，再使用访问令牌");
            if (configuring) throw Error("服务连接正在更新");
            configuring = true;
            try {
              if (!vault.available())
                throw Error("系统安全存储不可用，不能保存令牌");
              const candidate = new YCore(input.baseUrl, input.token);
              if (models.info().mode === "service")
                assertModelChange(candidate.scope);
              await candidate.capabilities();
              if (models.info().mode === "service")
                assertModelChange(candidate.scope);
              await writeFile(
                await configPath(),
                JSON.stringify({
                  baseUrl: input.baseUrl,
                  encrypted: safeStorage
                    .encryptString(input.token)
                    .toString("base64"),
                }),
                { mode: 0o600 },
              );
              accounts.useLegacy(input.baseUrl);
              client = candidate;
              if (models.info().mode === "service") pauseModelAutomation();
              service = {
                ...service,
                baseUrl: input.baseUrl,
                configured: true,
              };
              await connect();
            } finally {
              configuring = false;
            }
            break;
          }
          case "sync":
            if (configuring) throw Error("服务连接正在更新，请稍后同步");
            if (!client) throw Error("请先连接服务");
            result = await client.sync(store);
            break;
          case "draft": {
            const { type, ...draft } = input;
            result = store.saveDraft(draft);
            break;
          }
          case "choose-suggestion-document": {
            const suggestions = new ProjectSuggestions(store);
            const root = await suggestions.root(input.projectId);
            let path: string | undefined;
            if (input.mode === "existing") {
              const selected = await dialog.showOpenDialog(window, {
                title: "关联项目已有的建议文档",
                defaultPath: root,
                filters: [{ name: "Markdown", extensions: ["md"] }],
                properties: ["openFile"],
              });
              if (!selected.canceled) path = selected.filePaths[0];
            } else {
              const selected = await dialog.showSaveDialog(window, {
                title: "选择固定建议文档位置（写入建议时创建）",
                defaultPath: join(
                  existsSync(join(root, "docs")) ? join(root, "docs") : root,
                  "SUGGESTIONS.md",
                ),
                filters: [{ name: "Markdown", extensions: ["md"] }],
              });
              if (!selected.canceled) path = selected.filePath;
            }
            if (path)
              result = await suggestions.bind(
                input.projectId,
                path,
                input.mode,
              );
            break;
          }
          case "preview-project-suggestion":
            result = await new ProjectSuggestions(store).preview(
              input.projectId,
              input.versionId,
              input.excerpt,
            );
            break;
          case "publish-project-suggestion":
            result = await new ProjectSuggestions(store).publish(
              input.previewId,
            );
            break;
          case "reveal-suggestion-document": {
            const document = store.require<SuggestionDocument>(
              "suggestion-document",
              input.projectId,
            );
            const root = await new ProjectSuggestions(store).root(
              input.projectId,
            );
            if (root !== document.root)
              throw Error("项目目录已变化，请重新关联建议文档");
            const target = await new LocalDirectories(store).validatedPath(
              "code",
              document.path,
            );
            shell.showItemInFolder(target);
            break;
          }
          case "choose-local-root": {
            const directories = new LocalDirectories(store),
              roots = directories.roots();
            const selected = await dialog.showOpenDialog(window, {
              title:
                input.kind === "ai" ? "选择 AI 资产目录" : "选择 Code 项目目录",
              defaultPath:
                (input.kind === "ai" ? roots.aiPath : roots.codePath) ??
                homedir(),
              properties: ["openDirectory"],
            });
            if (!selected.canceled && selected.filePaths[0]) {
              await directories.setRoot(input.kind, selected.filePaths[0]);
              result = await directories.refresh();
            }
            break;
          }
          case "refresh-local-directories":
            result = await new LocalDirectories(store).refresh();
            break;
          case "reveal-local-root": {
            const directories = new LocalDirectories(store),
              roots = directories.roots();
            const path = input.kind === "ai" ? roots.aiPath : roots.codePath;
            if (!path) throw Error("尚未配置目录");
            const error = await shell.openPath(
              await directories.validatedDirectory(input.kind, path),
            );
            if (error) throw Error(error);
            break;
          }
          case "choose-project-directory": {
            const directories = new LocalDirectories(store),
              root = directories.roots().codePath;
            if (!root) throw Error("请先在设置中配置 Code 目录");
            const selected = await dialog.showOpenDialog(window, {
              title: "选择 Code 内的项目目录",
              defaultPath: root,
              properties: ["openDirectory"],
            });
            if (!selected.canceled && selected.filePaths[0])
              result = input.projectId
                ? await directories.linkProject(
                    input.projectId,
                    selected.filePaths[0],
                  )
                : await directories.importProject(selected.filePaths[0]);
            break;
          }
          case "import-local-project":
            result = await new LocalDirectories(store).importProject(
              input.path,
            );
            break;
          case "reveal-project-directory": {
            const path = store.require<Project>(
              "project",
              input.projectId,
            ).directory;
            if (!path) throw Error("该项目尚未关联本地目录");
            const error = await shell.openPath(
              await new LocalDirectories(store).validatedDirectory(
                "code",
                path,
              ),
            );
            if (error) throw Error(error);
            break;
          }
          case "reveal-local-asset":
            shell.showItemInFolder(
              await new LocalDirectories(store).validatedPath("ai", input.path),
            );
            break;
          case "project-brief":
            result = new Projects(store).saveBrief(input.brief);
            break;
          case "project-standard":
            result = new Projects(store).saveStandard(input.standard);
            break;
          case "project":
            result = store.createProject(input.name, input.goal, input.kind);
            break;
          case "delivery":
            result = store.createDelivery(input.projectId, input.title);
            break;
          case "submit": {
            if (configuring) throw Error("服务连接正在更新，草稿已保留");
            models.model();
            result = runtime.submit(input);
            break;
          }
          case "decision-draft":
            result = new Decisions(store).saveDraft(
              input.decisionId,
              input.revision,
              input.draftRevision,
              input.text,
            );
            break;
          case "answer-decision":
            if (configuring) throw Error("服务连接正在更新，答复已保留");
            result = runtime.answerDecision(input);
            break;
          case "stop":
            runtime.stop(input.workId);
            break;
          case "resume":
            if (configuring) throw Error("服务连接正在更新");
            runtime.resume(input.workId);
            break;
          case "reconcile":
            await runtime.reconcile(input.runId);
            break;
          case "begin-queue-edit":
            result = store.beginQueueEdit(input.runId);
            break;
          case "queue-draft":
            result = store.saveQueueDraft(
              input.runId,
              input.revision,
              input.draft,
            );
            break;
          case "apply-queue-edit":
            result = store.applyQueueEdit(input.runId, input.revision);
            break;
          case "discard-queue-edit":
            result = store.discardQueueEdit(input.runId, input.revision);
            break;
          case "retry-import": {
            const material = store.require<Material>(
              "material",
              `${input.materialId}@${input.version}`,
            );
            const source = store.require<{
              path: string;
              needsRelink?: boolean;
            }>("local-source", material.id);
            if (source.needsRelink)
              throw Error("恢复的本地文件需要重新选择，请使用导入文件");
            if (!material.readError) throw Error("材料已读取，无需重试");
            result = await captureFile(source.path, material);
            break;
          }
          case "withdraw":
            store.withdraw(input.runId);
            break;
          case "import": {
            const selected = await dialog.showOpenDialog(window, {
              title: "添加工作材料",
              properties: ["openFile", "multiSelections"],
              filters: [
                {
                  name: "文本与 Markdown",
                  extensions: ["md", "txt", "csv", "json"],
                },
              ],
            });
            const added: Material[] = [];
            for (const file of selected.filePaths) {
              added.push(await captureFile(file));
            }
            result = added;
            break;
          }
          case "link": {
            const url = new URL(input.url);
            if (!["https:", "http:"].includes(url.protocol))
              throw Error("链接需要 HTTP 或 HTTPS");
            result = store.addMaterial(
              url.hostname,
              input.url,
              "link_only",
              input.url,
            );
            break;
          }
          case "inspect-project-files":
            result = await new ProjectFiles(store).inspect(input.projectId);
            break;
          case "read-project-files":
            result = await new ProjectFiles(store).capture(
              input.projectId,
              input.paths,
            );
            break;
          case "prepare-project-reading":
            result = new ProjectFiles(store).prepare(
              input.projectId,
              input.refs,
            );
            break;
          case "prepare-method-trial":
            result = new Methods(store).prepareTrial(
              input.versionId,
              input.projectId,
            );
            break;
          case "adopt-method":
            result = new Methods(store).adopt(
              input.key,
              input.trialRunId,
              input.reason,
            );
            break;
          case "skill-state":
            result = new Skills(store).state(input.id, input.enabled);
            break;
          case "skill-copy":
            result = new Skills(store).copy(input.key);
            break;
          case "skill-save":
            result = new Skills(store).save(input.definition, input.key);
            break;
          case "skill-inspect":
            result = await new Skills(store).inspect(input.key);
            break;
          case "skill-import": {
            const root = new LocalDirectories(store).roots().aiPath;
            if (!root) throw Error("请先配置 AI 资产目录");
            const chosen = await dialog.showOpenDialog(window, {
              title: "导入 AI 目录中的方法",
              defaultPath: root,
              properties: ["openFile"],
              filters: [
                { name: "Skill 正文或方法文件", extensions: ["md", "json"] },
              ],
            });
            if (!chosen.canceled)
              result = await new Skills(store).importFile(chosen.filePaths[0]);
            break;
          }
          case "skill-export": {
            const root = new LocalDirectories(store).roots().aiPath;
            if (!root) throw Error("请先配置 AI 资产目录");
            const chosen = await dialog.showSaveDialog(window, {
              title: "保存可复用方法到 AI",
              defaultPath: join(
                root,
                `${input.key.replace(/[^a-zA-Z0-9_.-]/g, "-")}.method.json`,
              ),
              filters: [{ name: "方法文件", extensions: ["method.json"] }],
            });
            if (!chosen.canceled && chosen.filePath)
              result = await new Skills(store).exportFile(
                input.key,
                chosen.filePath,
              );
            break;
          }
          case "record-outcome":
            result = new Outcomes(store).record(input.input);
            break;
          case "withdraw-outcome":
            result = new Outcomes(store).withdraw(input.id, input.reason);
            break;
          case "prepare-readiness":
            result = new Outcomes(store).prepare(input.input);
            break;
          case "prepare-process":
            result = new ProcessRecords(store).prepare(input);
            break;
          case "prepare-revision":
            result = new Artifacts(store).prepareRevision(input);
            break;
          case "dismiss-candidate":
            new Artifacts(store).dismiss(input.candidateId);
            break;
          case "work-state":
            result = store.setWorkState(input.workId, input.action);
            break;
          case "adopt":
            store.adopt(input.deliveryId, input.versionId);
            break;
          case "export": {
            const version = store.require<ArtifactVersion>(
              "version",
              input.versionId,
            );
            const selected = await dialog.showSaveDialog(window, {
              defaultPath: `成果-v${version.number}.md`,
              filters: [{ name: "Markdown", extensions: ["md"] }],
            });
            if (!selected.canceled && selected.filePath) {
              await writeFile(selected.filePath, version.body, "utf8");
              result = { exported: true };
            }
            break;
          }
          case "reference": {
            const v = store.require<ArtifactVersion>(
              "version",
              input.versionId,
            );
            if (input.excerpt && !v.body.includes(input.excerpt))
              throw Error("选段不属于这个成果版本");
            const m: Material = {
              id: v.artifactId,
              version: v.number,
              title: versionLabel(v),
              body: v.body,
              coverage: "artifact",
              createdAt: v.createdAt,
            };
            store.put("material", `${m.id}@${m.version}`, m);
            result = {
              materialId: m.id,
              version: m.version,
              label: m.title,
              excerpt: input.excerpt,
            } satisfies Reference;
            break;
          }
          case "asset":
            result = new Assets(store).save(input.reference, input.label);
            break;
          case "asset-use":
            result = new Assets(store).prepareUse(input.assetId);
            break;
          case "asset-files":
            result = await new Assets(store).inspectFiles(input.assetId);
            break;
          case "asset-export": {
            const directories = new LocalDirectories(store),
              root = directories.roots().aiPath;
            if (!root) throw Error("请先在设置中配置 AI 目录");
            await directories.validatedDirectory("ai", root);
            const assets = new Assets(store);
            assets.serialize(input.assetId);
            let destination = root;
            try {
              destination = await directories.validatedDirectory(
                "ai",
                join(root, "knowledge"),
              );
            } catch {
              /* Other installations may use a different asset layout. */
            }
            const selected = await dialog.showSaveDialog(window, {
              title: "保存可复用资产到 AI 目录",
              defaultPath: join(
                destination,
                `资产-${input.assetId.slice(0, 8)}.md`,
              ),
              filters: [{ name: "ytriple Markdown 资产", extensions: ["md"] }],
            });
            if (!selected.canceled && selected.filePath)
              result = await assets.exportFile(
                input.assetId,
                selected.filePath,
              );
            break;
          }
          case "asset-restore": {
            const root = new LocalDirectories(store).roots().aiPath;
            const selected = await dialog.showOpenDialog(window, {
              title: "恢复 ytriple 资产文件",
              ...(root ? { defaultPath: root } : {}),
              properties: ["openFile"],
              filters: [{ name: "ytriple Markdown 资产", extensions: ["md"] }],
            });
            if (!selected.canceled && selected.filePaths[0])
              result = await new Assets(store).restoreFile(
                selected.filePaths[0],
              );
            break;
          }
          case "archive": {
            result = store.setWorkState(input.workId, "archive");
            break;
          }
        }
        changed();
        return result;
      } finally {
        commandsInFlight--;
      }
    });
    await window.loadURL("ytriple://app/");
    schedules.start();
    feeds.start();
    radarWatches.start();
    if (client) connect().catch(() => {});
  })
  .catch(() => {
    // Finder launches have no visible stderr. A rejected startup must not leave
    // an invisible process holding the single-instance lock indefinitely.
    dialog.showErrorBox(
      "无法打开工作空间",
      `启动未完成，请退出后重试。若仍失败，请保留此目录并从备份恢复，勿删除原数据。\n\n${activeDataDir ?? dataRoot}`,
    );
    app.exit(1);
  });
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  if (store) {
    schedules?.shutdown();
    feeds?.shutdown();
    radarWatches?.shutdown();
    runtime?.shutdown();
    radar?.shutdown();
  }
});
