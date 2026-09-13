import path from "node:path";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { promises as fs } from "node:fs";
import {
  skillCommandSchema,
  type SkillCommand,
  type SkillInternalCommand,
} from "../shared/skill-library.js";
import type {
  SkillCatalogEntry,
  SkillDefinition,
  SkillFeedback,
  SkillResource,
} from "../shared/skills.js";
import {
  BUILTIN_SKILLS,
  skillDefinitionHash,
  skillHash,
  validateSkillBindings,
} from "./skills.js";
import {
  ensureOwnedDirectory,
  readOwnedArtifactSync,
  textSource,
} from "./files.js";
import { now, type Store } from "./store.js";
import type { FeatureHost } from "./feature-host.js";
export { skillCommandSchema } from "../shared/skill-library.js";
export type {
  SkillCommand,
  SkillInternalCommand,
} from "../shared/skill-library.js";
interface Version {
  definition: SkillDefinition;
  createdAt: string;
}
export interface ManagedSkill {
  id: string;
  revision: number;
  activeHash: string;
  enabled: boolean;
  versions: Version[];
  feedback: SkillFeedback[];
}
interface SkillData {
  entries: ManagedSkill[];
  receipts: Record<string, { fingerprint: string; taskId?: string }>;
}
const rootPath = (store: Store) =>
  path.join(path.resolve(store.settings().aiRoot), "knowledge", "skills");
const keyFor = (root: string) => `skills.library.v1:${root}`;
const readData = (store: Store, root = rootPath(store)) =>
  store.config<SkillData>(keyFor(root), () => ({ entries: [], receipts: {} }));
function present(entry: ManagedSkill): SkillCatalogEntry {
  const definition = entry.versions.find(
    (version) => version.definition.hash === entry.activeHash,
  )!.definition;
  const feedback = entry.feedback.filter(
    (item) => item.versionHash === definition.hash,
  );
  return {
    ...definition,
    revision: entry.revision,
    enabled: entry.enabled,
    editable: definition.source !== "builtin",
    availability: (definition.dependencies ?? []).every(
      (dependency) => dependency.status === "available",
    )
      ? "ready"
      : "missing-dependencies",
    validation: feedback.some(
      (item) => item.outcome === "failed" || item.outcome === "correction",
    )
      ? "needs-review"
      : feedback.some((item) => item.outcome === "useful")
        ? "observed-useful"
        : "unverified",
    feedback: entry.feedback,
    versions: entry.versions.map((version) => ({
      version: version.definition.version,
      hash: version.definition.hash,
      name: version.definition.name,
      createdAt: version.createdAt,
      active: version.definition.hash === entry.activeHash,
    })),
  };
}
export function managedSkillCatalog(store: Store): SkillCatalogEntry[] {
  const data = readData(store);
  return [
    ...BUILTIN_SKILLS.filter(
      (builtin) => !data.entries.some((entry) => entry.id === builtin.id),
    ).map((builtin) => ({
      ...builtin,
      enabled: true,
      revision: 0,
      editable: false,
      availability: "ready" as const,
      validation: "unverified" as const,
      feedback: [],
      versions: [
        {
          version: builtin.version,
          hash: builtin.hash,
          name: builtin.name,
          createdAt: "",
          active: true,
        },
      ],
    })),
    ...data.entries.map(present),
  ];
}
function findDefinition(data: SkillData, id: string, hash?: string) {
  const record = data.entries.find((entry) => entry.id === id);
  const definition =
    record?.versions.find(
      (version) => version.definition.hash === (hash ?? record.activeHash),
    )?.definition ??
    BUILTIN_SKILLS.find(
      (builtin) => builtin.id === id && (!hash || builtin.hash === hash),
    );
  if (!definition) throw new Error("找不到这个 Skill 版本，请重新打开资产。");
  return { record, definition };
}
function editableRecord(data: SkillData, id: string, revision: number) {
  const record = data.entries.find((entry) => entry.id === id);
  if (!record || record.revision !== revision)
    throw new Error("Skill 已更新，草稿已保留；请核对最新版本。");
  return record;
}
function nextVersion(record: ManagedSkill) {
  const latest =
    record.versions
      .map((version) => version.definition.version)
      .sort((a, b) => {
        const l = a.split(".").map(Number),
          r = b.split(".").map(Number);
        return r[0]! - l[0]! || r[1]! - l[1]! || r[2]! - l[2]!;
      })[0] ?? "0.1.0";
  const [major, minor, patch] = latest.split(".").map(Number);
  return `${major}.${minor}.${patch! + 1}`;
}
function metadata(content: string, name?: string, description?: string) {
  if (/^https?:\/\/\S+$/i.test(content.trim()))
    throw new Error("链接不是方法正文，请提供实际读取的 SKILL.md 内容。");
  const front =
    content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? "";
  const field = (label: string) => {
    const lines = front.split(/\r?\n/),
      index = lines.findIndex((line) => line.startsWith(`${label}:`));
    if (index < 0) return undefined;
    const value = lines[index]!.slice(label.length + 1).trim();
    if (/^[|>][+-]?$/.test(value)) {
      const body: string[] = [];
      for (const line of lines.slice(index + 1)) {
        if (line.trim() && !/^[ \t]/.test(line)) break;
        body.push(line.trim());
      }
      return body.join(value.startsWith(">") ? " " : "\n").trim();
    }
    if (value.startsWith('"')) {
      try {
        const parsed = JSON.parse(value);
        if (typeof parsed === "string") return parsed;
      } catch {
        /* Plain YAML strings remain usable. */
      }
    }
    return value.replace(/^['"]|['"]$/g, "");
  };
  const resolvedName =
    name?.trim() || field("name") || content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const resolvedDescription =
    description?.trim() ||
    field("description") ||
    "用户导入的方法，适用条件与效果待验证。";
  if (
    !resolvedName ||
    resolvedName.length > 160 ||
    resolvedDescription.length > 2000 ||
    ["|", ">"].includes(resolvedDescription)
  )
    throw new Error(
      "请在正文写明 name / description，或填写名称和用途后导入。",
    );
  const rawVersion = field("version");
  const version =
    rawVersion && /^\d+\.\d+\.\d+$/.test(rawVersion) ? rawVersion : "0.1.0";
  const dependencyBlock =
    front.match(/^dependencies:\s*\r?\n((?:[ \t]+-[^\r\n]+\r?\n?)*)/m)?.[1] ??
    "";
  const dependencies = [...dependencyBlock.matchAll(/^\s+-\s+(.+)$/gm)].map(
    (match) => ({
      name: match[1]!.trim(),
      status: "unknown" as const,
      evidence: "",
    }),
  );
  return {
    name: resolvedName,
    description: resolvedDescription,
    version,
    dependencies,
  };
}
/** Edited copies keep their public name, description and version inside the saved SKILL.md fingerprint. */
function ownVersionInstructions(
  content: string,
  fields: { name: string; description: string; version: string },
) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const retained: string[] = [];
  let skip = false;
  for (const line of (match?.[1] ?? "").split(/\r?\n/)) {
    if (/^(name|description|version):/.test(line)) {
      skip = true;
      continue;
    }
    if (/^\S/.test(line)) skip = false;
    if (!skip && line.trim()) retained.push(line);
  }
  const body = match ? content.slice(match[0].length) : content;
  return [
    "---",
    `name: ${JSON.stringify(fields.name)}`,
    `description: ${JSON.stringify(fields.description)}`,
    `version: ${fields.version}`,
    ...retained,
    "---",
    body,
  ].join("\n");
}
function readLocalText(file: string, maximum: number) {
  const descriptor = openSync(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum)
      throw new Error("Skill 文件不是独立文本文件或超出大小限制。");
    const value = readFileSync(descriptor, "utf8");
    if (value.includes("\0")) throw new Error("Skill 包只能包含文本资料。");
    return value;
  } finally {
    closeSync(descriptor);
  }
}
function importLocal(selectedPath: string) {
  if (
    !path.isAbsolute(selectedPath) ||
    path.basename(selectedPath) !== "SKILL.md"
  )
    throw new Error("请选择可信包中的 SKILL.md 文件。");
  const parent = path.dirname(selectedPath);
  if (
    lstatSync(parent).isSymbolicLink() ||
    lstatSync(selectedPath).isSymbolicLink()
  )
    throw new Error("不能从符号链接导入 Skill 包。");
  const root = realpathSync(parent),
    content = readLocalText(path.join(root, "SKILL.md"), 160000);
  const resources: SkillResource[] = [];
  const visit = (directory: string, relative = "", depth = 0) => {
    if (depth > 4) throw new Error("Skill 附带资料目录过深。");
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (
        item.name.startsWith(".") ||
        ["node_modules", "scripts", "dist", "__pycache__"].includes(item.name)
      )
        continue;
      const local = path.join(directory, item.name),
        resourcePath = relative ? `${relative}/${item.name}` : item.name;
      if (item.isSymbolicLink())
        throw new Error("Skill 包包含符号链接，无法确认资料范围。");
      if (item.isDirectory()) {
        visit(local, resourcePath, depth + 1);
        continue;
      }
      if (
        resourcePath === "SKILL.md" ||
        !/\.(md|txt|json|yaml|yml)$/i.test(item.name)
      )
        continue;
      const body = readLocalText(local, 480000);
      resources.push({
        path: resourcePath,
        content: body,
        hash: skillHash(body),
      });
      if (
        resources.length > 40 ||
        resources.reduce(
          (size, resource) => size + resource.content.length,
          0,
        ) > 2_000_000
      )
        throw new Error("Skill 附带资料过多，请保留本方法所需的少量文本资源。");
    }
  };
  visit(root);
  return { content, resources, root };
}
async function persistVersion(root: string, definition: SkillDefinition) {
  validateSkillBindings([definition]);
  const directory = await ensureOwnedDirectory(
    path.join(root, definition.id, "versions", definition.hash),
  );
  const documents = [
    {
      path: "SKILL.md",
      content: definition.instructions,
      hash: skillHash(definition.instructions),
    },
    ...(definition.resources ?? []),
  ];
  for (const document of documents) {
    const target = path.join(directory, document.path);
    await ensureOwnedDirectory(path.dirname(target));
    try {
      await fs.writeFile(target, document.content, { flag: "wx", mode: 0o600 });
    } catch (cause) {
      if (
        (cause as NodeJS.ErrnoException).code !== "EEXIST" ||
        skillHash(readLocalText(target, 2_000_000)) !== document.hash
      )
        throw new Error("Skill 版本目录已有不同内容，已保留文件并停止写入。");
    }
  }
}
const locks = new WeakMap<Store, Promise<unknown>>();
export async function handleSkillCommand(
  host: FeatureHost,
  raw: SkillCommand | SkillInternalCommand,
): Promise<void> {
  const command =
    raw.type === "skill.importLocal.path" ? raw : skillCommandSchema.parse(raw);
  if (command.type === "skill.importLocal")
    throw new Error("请通过桌面文件选择器选择可信的 SKILL.md。");
  const previous = locks.get(host.store) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      const root = rootPath(host.store),
        data = readData(host.store, root);
      const fingerprint = skillHash(JSON.stringify(command)),
        receipt = data.receipts[command.requestId];
      if (receipt) {
        if (receipt.fingerprint !== fingerprint)
          throw new Error("同一请求不能修改为不同 Skill 操作。");
        return;
      }
      const commit = (taskId?: string) => {
        data.receipts[command.requestId] = {
          fingerprint,
          ...(taskId ? { taskId } : {}),
        };
        host.store.setConfig(keyFor(root), data);
      };
      const add = async (definition: SkillDefinition) => {
        definition.hash = skillDefinitionHash(definition);
        validateSkillBindings([definition]);
        await persistVersion(root, definition);
        data.entries.push({
          id: definition.id,
          revision: 1,
          activeHash: definition.hash,
          enabled: false,
          versions: [{ definition, createdAt: now() }],
          feedback: [],
        });
        commit();
      };
      if (
        command.type === "skill.importText" ||
        command.type === "skill.importURL" ||
        command.type === "skill.importLocal.path" ||
        command.type === "skill.fromArtifact"
      ) {
        let content: string,
          resources: SkillResource[] = [],
          source: SkillDefinition["source"],
          origin: SkillDefinition["origin"];
        if (command.type === "skill.importURL") {
          if (!host.readURL)
            throw new Error(
              "当前没有可用的公开链接读取能力，请使用可信本地包导入。",
            );
          let received;
          try {
            received = await host.readURL(command.url);
          } catch {
            throw new Error(
              "未能读取这个链接的实际正文。私有或不可访问的来源请通过本地 SKILL.md 导入。",
            );
          }
          content = received.text;
          source = "user";
          origin = {
            label: "用户选择的可信链接",
            location: command.url,
            coverage: `${received.coverage}；仅主方法正文，附带资料未读取。`,
          };
        } else if (command.type === "skill.importLocal.path") {
          const imported = importLocal(command.selectedPath);
          content = imported.content;
          resources = imported.resources;
          source = "local";
          origin = {
            label: "用户选择的可信本地包",
            location: path.join(imported.root, "SKILL.md"),
          };
        } else if (command.type === "skill.fromArtifact") {
          const task = host.store.task(command.taskId),
            artifact = task.artifacts.find(
              (item) => item.id === command.artifactId,
            );
          if (
            !artifact ||
            artifact.format !== "md" ||
            artifact.hash !== command.expectedHash
          )
            throw new Error("请选择仍是当前版本的 Markdown 成果。");
          content = readOwnedArtifactSync(artifact, task.workspace).toString(
            "utf8",
          );
          if (skillHash(content) !== artifact.hash)
            throw new Error(
              "成果正文已在外部修改，请先在原工作台确认并保存新版本。",
            );
          source = "derived";
          origin = {
            label: "用户采纳的工作成果",
            taskId: task.id,
            artifactId: artifact.id,
            artifactHash: artifact.hash,
          };
        } else {
          content = command.content;
          source = "user";
          origin = {
            label: "用户粘贴的 SKILL.md",
            ...(command.originURL ? { location: command.originURL } : {}),
          };
        }
        const parsed = metadata(
          content,
          "name" in command ? command.name : undefined,
          "description" in command ? command.description : undefined,
        );
        if (command.type === "skill.importURL") {
          const relativeResources = [
            ...new Set(
              [
                ...content.matchAll(
                  /\]\(([^\s)#]+\.(?:md|txt|json|ya?ml))(?:#[^)]*)?\)/gi,
                ),
              ]
                .map((match) => match[1]!)
                .filter((href) => !/^https?:/i.test(href)),
            ),
          ];
          parsed.dependencies.push(
            ...relativeResources.map((resource) => ({
              name: `附带资料：${resource}`,
              status: "unknown" as const,
              evidence: "此链接仅取得主方法正文，附加资料尚未导入。",
            })),
          );
        }
        await add({
          id: `user-${command.requestId}`,
          ...parsed,
          instructions: content,
          source,
          origin,
          resources,
          allowedMembers: ["coordinator", "cto", "researcher", "editor"],
          hash: "",
        });
        return;
      }
      if (command.type === "skill.copy") {
        const { definition } = findDefinition(data, command.skillId);
        if (definition.hash !== command.expectedHash)
          throw new Error("原方法版本已变化，请重新选择要复制的版本。");
        await add({
          ...structuredClone(definition),
          id: `user-${command.requestId}`,
          name: command.name,
          version: "0.1.0",
          instructions: ownVersionInstructions(definition.instructions, {
            name: command.name,
            description: definition.description,
            version: "0.1.0",
          }),
          source: "user",
          origin: {
            label: "自己的方法副本",
            copiedFromId: definition.id,
            copiedFromHash: definition.hash,
          },
        });
        return;
      }
      if (command.type === "skill.edit") {
        const record = editableRecord(
            data,
            command.skillId,
            command.expectedRevision,
          ),
          { definition } = findDefinition(data, command.skillId);
        if (definition.source === "builtin")
          throw new Error("内置正文保留原样，请先创建自己的副本。");
        const next: SkillDefinition = {
          ...definition,
          ...command.input,
          version: nextVersion(record),
          hash: "",
        };
        next.instructions = ownVersionInstructions(next.instructions, next);
        next.hash = skillDefinitionHash(next);
        validateSkillBindings([next]);
        await persistVersion(root, next);
        if (
          !record.versions.some(
            (version) => version.definition.hash === next.hash,
          )
        )
          record.versions.push({ definition: next, createdAt: now() });
        record.activeHash = next.hash;
        record.revision += 1;
        commit();
        return;
      }
      if (command.type === "skill.activateVersion") {
        const record = editableRecord(
          data,
          command.skillId,
          command.expectedRevision,
        );
        if (
          !record.versions.some(
            (version) => version.definition.hash === command.versionHash,
          )
        )
          throw new Error("找不到保存的历史版本。");
        record.activeHash = command.versionHash;
        record.revision += 1;
        commit();
        return;
      }
      if (command.type === "skill.setMembers") {
        const { record: stored, definition } = findDefinition(
          data,
          command.skillId,
        );
        if (
          (stored?.revision ?? 0) !== command.expectedRevision ||
          definition.hash !== command.expectedHash
        )
          throw new Error("方法范围已更新，请核对后重试。");
        if (
          new Set(command.allowedMembers).size !== command.allowedMembers.length
        )
          throw new Error("成员范围不能重复。");
        const record = stored ?? {
          id: definition.id,
          revision: 0,
          activeHash: definition.hash,
          enabled: true,
          versions: [
            { definition: structuredClone(definition), createdAt: "" },
          ],
          feedback: [],
        };
        const next: SkillDefinition = {
          ...definition,
          allowedMembers: command.allowedMembers,
          version: nextVersion(record),
          hash: "",
        };
        next.hash = skillDefinitionHash(next);
        validateSkillBindings([next]);
        await persistVersion(root, next);
        if (
          !record.versions.some(
            (version) => version.definition.hash === next.hash,
          )
        )
          record.versions.push({ definition: next, createdAt: now() });
        record.activeHash = next.hash;
        record.revision += 1;
        if (!stored) data.entries.push(record);
        commit();
        return;
      }
      if (command.type === "skill.feedback") {
        const { record: stored, definition } = findDefinition(
          data,
          command.skillId,
          command.versionHash,
        );
        if (command.artifactId && !command.taskId)
          throw new Error("成果反馈需要同时选择所属工作。");
        if (command.taskId) {
          const task = host.store.task(command.taskId);
          if (
            !task.events.some(
              (event) =>
                event.type === "skill_loaded" &&
                event.data?.skillId === command.skillId &&
                event.data?.hash === command.versionHash,
            )
          )
            throw new Error("这项工作没有实际加载所选方法版本的证据。");
          if (
            command.artifactId &&
            !task.artifacts.some(
              (artifact) => artifact.id === command.artifactId,
            )
          )
            throw new Error("反馈成果不属于所选工作。");
        }
        const record = stored ?? {
          id: definition.id,
          revision: 0,
          activeHash: definition.hash,
          enabled: true,
          versions: [
            { definition: structuredClone(definition), createdAt: "" },
          ],
          feedback: [],
        };
        const {
          type: _type,
          requestId,
          skillId: _skillId,
          ...feedback
        } = command;
        record.feedback.push({ id: requestId, ...feedback, createdAt: now() });
        record.revision += 1;
        if (!stored) data.entries.push(record);
        commit();
        return;
      }
      const task = host.store.task(command.taskId),
        artifact = task.artifacts.find(
          (item) => item.id === command.artifactId,
        );
      if (
        !artifact ||
        artifact.format !== "md" ||
        artifact.hash !== command.expectedHash
      )
        throw new Error("提炼方法需要选择当前版本的 Markdown 成果。");
      const content = readOwnedArtifactSync(artifact, task.workspace).toString(
        "utf8",
      );
      if (skillHash(content) !== artifact.hash)
        throw new Error(
          "成果正文已在外部修改，请先在原工作台确认并保存新版本。",
        );
      const methodTask = await host.createWork({
        requestId: `skill-extract:${command.requestId}`,
        title: `提炼方法 · ${artifact.title}`,
        goal: [
          "从用户选定的实际工作成果提炼一个可复用方法草案，保存为 Markdown。",
          command.instruction,
          "只依据已提供的成果与使用反馈，不把一次成功当作通用验证。SKILL.md 应含 name、description、version: 0.1.0 的前置信息，并写清适用条件、输入、步骤、输出、失败方式、权限边界和具体样例。区分用户采纳修正与待验证假设。方法不能授予工具、账户、脚本或发布权限。",
          "现阶段只生成供用户审阅的候选，不自行启用、安装或将其标为已验证。",
        ]
          .filter(Boolean)
          .join("\n\n"),
        kind: "research",
        member: task.member,
        teamMode: task.teamMode,
        isolatedContext: true,
        sources: [
          textSource(
            `来源成果 · ${artifact.title}`,
            content,
            "text",
            `artifact:${task.id}:${artifact.id}:${artifact.hash}`,
          ),
          textSource(
            "用户已提供的使用与修正",
            JSON.stringify(
              task.events
                .filter((event) =>
                  ["library.feedback", "delivery.feedback"].includes(
                    event.type,
                  ),
                )
                .map(({ summary, data }) => ({ summary, data })),
            ) || "未提供",
            "text",
            `task-feedback:${task.id}`,
          ),
        ],
        skillPolicy: { mode: "off", skillIds: [] },
      });
      host.store.event(methodTask.id, {
        type: "skill.draft_created",
        member: task.member,
        goalVersion: methodTask.goalVersion,
        summary: "由用户选择的成果开始提炼方法草案，尚未采纳或验证。",
        data: {
          requestId: command.requestId,
          sourceTaskId: task.id,
          sourceArtifactId: artifact.id,
          sourceHash: artifact.hash,
        },
      });
      commit(methodTask.id);
      void host.runWork(methodTask.id).catch(() => undefined);
    });
  locks.set(host.store, operation);
  await operation;
}

function rejectExportedCredentials(value: string) {
  const credential =
    /(?:sk-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{25,}|Bearer\s+[A-Za-z0-9._~-]{20,}|(?:api[_-]?key|access[_-]?token|password)\s*[=:]\s*["']?[A-Za-z0-9_./+~-]{20,})/i;
  if (credential.test(value))
    throw new Error("方法资产含疑似凭据，请先移除后导出。");
  for (const candidate of value.match(/[A-Za-z0-9+/]{40,}={0,2}/g) ?? []) {
    if (
      candidate.length <= 100000 &&
      credential.test(Buffer.from(candidate, "base64").toString("utf8"))
    )
      throw new Error("方法附带资料含编码后的疑似凭据，请先移除后导出。");
  }
}

export function exportManagedSkills(store: Store): ManagedSkill[] {
  const enabled = store.config<Record<string, boolean>>(
    "skills.enabled",
    () => ({}),
  );
  const records = structuredClone(readData(store).entries).map((entry) => ({
    ...entry,
    enabled: enabled[entry.id] ?? entry.enabled,
  }));
  validateManagedSkills(records);
  rejectExportedCredentials(JSON.stringify(records));
  return records;
}

export function validateManagedSkills(
  records: unknown,
): asserts records is ManagedSkill[] {
  if (!Array.isArray(records) || records.length > 1000)
    throw new Error("方法备份目录无效或过大。");
  const ids = new Set<string>();
  for (const raw of records) {
    if (
      !raw ||
      typeof raw !== "object" ||
      Object.keys(raw).some(
        (key) =>
          ![
            "id",
            "revision",
            "activeHash",
            "enabled",
            "versions",
            "feedback",
          ].includes(key),
      )
    )
      throw new Error("方法备份包含不支持的字段。");
    const record = raw as ManagedSkill;
    if (
      !/^[a-z][a-z0-9-]{0,79}$/.test(record.id) ||
      ids.has(record.id) ||
      !Number.isInteger(record.revision) ||
      record.revision < 0 ||
      typeof record.enabled !== "boolean" ||
      !Array.isArray(record.versions) ||
      !record.versions.length ||
      record.versions.length > 100 ||
      !Array.isArray(record.feedback) ||
      record.feedback.length > 1000
    )
      throw new Error("方法备份的身份、版本或反馈格式无效。");
    ids.add(record.id);
    const versions = new Set<string>();
    for (const version of record.versions) {
      if (
        !version ||
        Object.keys(version).some(
          (key) => !["definition", "createdAt"].includes(key),
        ) ||
        typeof version.createdAt !== "string" ||
        !version.definition ||
        version.definition.id !== record.id ||
        Object.keys(version.definition).some(
          (key) =>
            ![
              "id",
              "name",
              "description",
              "version",
              "hash",
              "source",
              "instructions",
              "origin",
              "dependencies",
              "resources",
              "allowedMembers",
            ].includes(key),
        )
      )
        throw new Error("方法备份版本字段无效。");
      validateSkillBindings([version.definition]);
      if (
        version.definition.resources?.some((resource) =>
          Object.keys(resource).some(
            (key) => !["path", "content", "hash"].includes(key),
          ),
        ) ||
        version.definition.dependencies?.some((dependency) =>
          Object.keys(dependency).some(
            (key) => !["name", "status", "evidence"].includes(key),
          ),
        )
      )
        throw new Error("方法资源或依赖包含不支持的字段。");
      if (versions.has(version.definition.hash))
        throw new Error("方法备份包含重复版本。");
      versions.add(version.definition.hash);
      const origin = version.definition.origin;
      if (
        origin &&
        (Object.keys(origin).some(
          (key) =>
            ![
              "label",
              "location",
              "coverage",
              "copiedFromId",
              "copiedFromHash",
              "taskId",
              "artifactId",
              "artifactHash",
            ].includes(key),
        ) ||
          typeof origin.label !== "string" ||
          Object.values(origin).some(
            (value) => typeof value !== "string" || value.length > 4000,
          ))
      )
        throw new Error("方法来源格式无效。");
    }
    if (!versions.has(record.activeHash))
      throw new Error("方法当前版本不在备份中。");
    for (const feedback of record.feedback) {
      if (
        !feedback ||
        Object.keys(feedback).some(
          (key) =>
            ![
              "id",
              "versionHash",
              "outcome",
              "conditions",
              "observation",
              "evidence",
              "taskId",
              "artifactId",
              "createdAt",
            ].includes(key),
        ) ||
        !versions.has(feedback.versionHash) ||
        !["useful", "failed", "correction"].includes(feedback.outcome) ||
        [
          feedback.id,
          feedback.conditions,
          feedback.observation,
          feedback.evidence,
          feedback.createdAt,
        ].some(
          (value) =>
            typeof value !== "string" || !value.trim() || value.length > 12000,
        ) ||
        (feedback.taskId !== undefined &&
          typeof feedback.taskId !== "string") ||
        (feedback.artifactId !== undefined &&
          typeof feedback.artifactId !== "string")
      )
        throw new Error("方法反馈未提供有效的版本、条件与依据。");
    }
  }
}

export async function importManagedSkills(
  store: Store,
  records: unknown,
  requestId: string,
  taskIdMap: Record<string, string> = {},
): Promise<Record<string, string>> {
  validateManagedSkills(records);
  if (!/^[a-zA-Z0-9_:-]{1,200}$/.test(requestId))
    throw new Error("方法恢复请求标识无效。");
  const root = rootPath(store),
    journalKey = `skills.restore.v1:${root}`;
  const fingerprint = skillHash(JSON.stringify({ records, taskIdMap }));
  let result: Record<string, string> = {};
  const operation = (locks.get(store) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const journal = store.config<
        Record<string, { fingerprint: string; mapping: Record<string, string> }>
      >(journalKey, () => ({}));
      if (journal[requestId]) {
        if (journal[requestId]!.fingerprint !== fingerprint)
          throw new Error("同一恢复请求已用于不同的方法备份。");
        result = journal[requestId]!.mapping;
        return;
      }
      const data = readData(store, root);
      const mapping = Object.fromEntries(
        records.map((entry) => [
          entry.id,
          `user-${skillHash(`${requestId}:${entry.id}`).slice(0, 36)}`,
        ]),
      );
      for (const entry of records) {
        const id = mapping[entry.id]!;
        if (data.entries.some((existing) => existing.id === id))
          throw new Error("恢复的方法编号已存在，已保留当前资产。");
        const restored = structuredClone(entry);
        restored.id = id;
        restored.enabled = false;
        for (const version of restored.versions) {
          const original = version.definition;
          const linkedTask = original.origin?.taskId
            ? taskIdMap[original.origin.taskId]
            : undefined;
          const {
            taskId: _taskId,
            artifactId: _artifactId,
            ...origin
          } = original.origin ?? { label: "历史方法资产" };
          version.definition = {
            ...original,
            id,
            source: original.source === "builtin" ? "user" : original.source,
            origin: {
              ...origin,
              label: `备份恢复 · ${origin.label}`,
              copiedFromId: original.id,
              copiedFromHash: original.hash,
              ...(linkedTask
                ? {
                    taskId: linkedTask,
                    ...(original.origin?.artifactId
                      ? { artifactId: original.origin.artifactId }
                      : {}),
                  }
                : {}),
            },
          };
          await persistVersion(root, version.definition);
        }
        restored.feedback = restored.feedback.map((feedback) => {
          const { taskId, artifactId, ...body } = feedback;
          const linkedTask = taskId ? taskIdMap[taskId] : undefined;
          return {
            ...body,
            ...(linkedTask
              ? { taskId: linkedTask, ...(artifactId ? { artifactId } : {}) }
              : {}),
          };
        });
        data.entries.push(restored);
      }
      journal[requestId] = { fingerprint, mapping };
      store.db.exec("BEGIN IMMEDIATE");
      try {
        store.setConfig(keyFor(root), data);
        store.setConfig(journalKey, journal);
        store.db.exec("COMMIT");
      } catch (cause) {
        store.db.exec("ROLLBACK");
        throw cause;
      }
      result = mapping;
    });
  locks.set(store, operation);
  await operation;
  return result;
}

export function assertNoSkillCredentials(definitions: SkillDefinition[]): void {
  validateSkillBindings(definitions);
  rejectExportedCredentials(JSON.stringify(definitions));
}
