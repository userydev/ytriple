import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AppSettings, Artifact, ArtifactKind, ArtifactVersion, CoreResult, Draft, EventInput, Intent,
  Material, Message, PublicEvent, Reference, RunSnapshot, RunStatus, SaveArtifactRequest,
  SubmitRequest, ViewState, Work, WorkDetail,
} from '../shared/contracts';
import { DEFAULT_SETTINGS, DEFAULT_VIEW } from '../shared/defaults';

export const STORAGE_LIMITS = {
  materialCharacters: 200_000,
  workMaterialCharacters: 1_000_000,
  promptCharacters: 100_000,
  artifactCharacters: 1_000_000,
} as const;

const SCHEMA_VERSION = 1;
const INTENTS = new Set<Intent>(['discuss', 'change-goal', 'revise', 'explain', 'summarize', 'reflect']);
const EVENT_TYPES = new Set(['plan', 'delegation', 'analysis', 'review', 'revision', 'tool', 'status', 'usage', 'error']);
const TERMINAL_STATUSES = new Set<RunStatus>(['stopped', 'completed', 'failed', 'interrupted', 'superseded']);
const RUN_STATUSES = new Set<RunStatus>(['running', 'stopping', ...TERMINAL_STATUSES]);
type Row = Record<string, unknown>;

function parse<T>(value: unknown): T { return JSON.parse(String(value)) as T; }
function now(): string { return new Date().toISOString(); }
function text(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`${field}不能为空。`);
  if (value.length > max) throw new Error(`${field}最多支持 ${max.toLocaleString('en-US')} 个字符；请拆分后重试，原内容未被截断。`);
  return value;
}
function integer(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`${field}必须是 ${min}～${max} 的整数。`);
  return Number(value);
}

/** Persist only known non-secret fields, including when an untyped IPC/HTTP client adds properties. */
function cleanSettings(input: AppSettings): AppSettings {
  if (!input || typeof input !== 'object' || !input.provider || !input.team || !input.limits) throw new Error('模型与团队设置不完整。');
  if (input.strategy !== 'team-v1') throw new Error('不支持此协作策略。');
  const { provider, team, skills, limits } = input;
  if (provider.kind !== 'gemini' && provider.kind !== 'openai-compatible') throw new Error('不支持此模型提供方。');
  const model = text(provider.model, '模型名称', 200).trim();
  const baseUrl = text(provider.baseUrl, 'API 地址', 2000, true).trim();
  if (baseUrl) {
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw new Error('API 地址格式不正确。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('API 地址须为 HTTP(S)，不能包含凭据、查询参数或片段。');
    }
  }
  if (!Array.isArray(team.members) || team.members.length < 1 || team.members.length > 12) throw new Error('团队须有 1～12 位成员。');
  const ids = new Set<string>();
  const members = team.members.map((member) => {
    const id = text(member.id, '成员身份', 100).trim();
    if (ids.has(id)) throw new Error('团队成员身份不能重复。');
    ids.add(id);
    return {
      id, name: text(member.name, '成员名称', 200).trim(), role: text(member.role, '成员职责', 2000),
      instructions: text(member.instructions, '成员指令', 20_000),
      ...(member.model ? { model: text(member.model, '成员模型', 200).trim() } : {}),
    };
  });
  if (!Array.isArray(skills) || skills.length > 50) throw new Error('方法配置格式不正确。');
  const skillIds = new Set<string>();
  const safeSkills = skills.map((skill) => {
    const id = text(skill.id, '方法身份', 100).trim();
    if (skillIds.has(id)) throw new Error('方法身份不能重复。');
    skillIds.add(id);
    if (!Array.isArray(skill.requires) || skill.requires.length > 100 || typeof skill.enabled !== 'boolean') throw new Error('方法依赖或启用状态不正确。');
    return {
      id, name: text(skill.name, '方法名称', 200), version: text(skill.version, '方法版本', 100),
      description: text(skill.description, '方法说明', 10_000, true), instructions: text(skill.instructions, '方法指令', 30_000),
      enabled: skill.enabled, requires: skill.requires.map((dependency) => text(dependency, '方法依赖', 200)),
    };
  });
  return {
    version: 1, strategy: input.strategy, provider: { kind: provider.kind, model, baseUrl },
    team: { version: 1, members }, skills: safeSkills,
    limits: {
      maxCalls: integer(limits.maxCalls, '调用上限', 1, 100), maxConcurrency: integer(limits.maxConcurrency, '并行上限', 1, 12),
      timeoutMs: integer(limits.timeoutMs, '超时时间', 1000, 3_600_000), maxOutputTokens: integer(limits.maxOutputTokens, '输出上限', 128, 131_072),
    },
  };
}

/** Owns durable business state. Agent strategies may only return proposals through this boundary. */
export class Repository {
  private readonly db: DatabaseSync;
  private inTransaction = false;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    try {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
      this.migrate();
    } catch (error) { this.db.close(); throw error; }
  }

  close(): void { this.db.close(); }

  private transaction<T>(operation: () => T): T {
    if (this.inTransaction) return operation();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
  }

  private migrate(): void {
    const version = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
    if (version > SCHEMA_VERSION) throw new Error(`此数据库版本为 ${version}，高于当前应用支持的 ${SCHEMA_VERSION}；请使用较新版本。`);
    if (version === SCHEMA_VERSION) return;
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE works (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, goal_revision INTEGER NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
        ) STRICT;
        CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), payload_json TEXT NOT NULL) STRICT;
        CREATE TABLE runs (
          id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id), status TEXT NOT NULL,
          created_at TEXT NOT NULL, snapshot_json TEXT NOT NULL, result_recorded INTEGER NOT NULL DEFAULT 0,
          result_json TEXT, UNIQUE(id, work_id)
        ) STRICT;
        CREATE TABLE messages (
          id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id), run_id TEXT,
          created_at TEXT NOT NULL, payload_json TEXT NOT NULL,
          FOREIGN KEY(run_id, work_id) REFERENCES runs(id, work_id)
        ) STRICT;
        CREATE TABLE events (
          id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id), run_id TEXT NOT NULL,
          sequence INTEGER NOT NULL, event_key TEXT, payload_json TEXT NOT NULL,
          UNIQUE(run_id, sequence), UNIQUE(run_id, event_key),
          FOREIGN KEY(run_id, work_id) REFERENCES runs(id, work_id)
        ) STRICT;
        CREATE TABLE materials (
          id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id), title TEXT NOT NULL,
          content TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(work_id, hash)
        ) STRICT;
        CREATE TABLE artifacts (
          id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id), title TEXT NOT NULL,
          kind TEXT NOT NULL, current_version INTEGER NOT NULL DEFAULT 0,
          UNIQUE(work_id, kind), UNIQUE(id, work_id)
        ) STRICT;
        CREATE TABLE artifact_versions (
          artifact_id TEXT NOT NULL, work_id TEXT NOT NULL, version INTEGER NOT NULL,
          content TEXT NOT NULL, created_at TEXT NOT NULL, run_id TEXT, base_version INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('current', 'history', 'proposal')), note TEXT,
          PRIMARY KEY(artifact_id, version),
          FOREIGN KEY(artifact_id, work_id) REFERENCES artifacts(id, work_id),
          FOREIGN KEY(run_id, work_id) REFERENCES runs(id, work_id)
        ) STRICT;
        CREATE TABLE device_states (
          work_id TEXT NOT NULL REFERENCES works(id), device_id TEXT NOT NULL,
          draft_json TEXT NOT NULL, view_json TEXT NOT NULL, PRIMARY KEY(work_id, device_id)
        ) STRICT;
        CREATE INDEX runs_work ON runs(work_id);
        CREATE INDEX messages_work ON messages(work_id);
        CREATE INDEX events_work ON events(work_id);
        PRAGMA user_version = 1;
      `);
      this.db.prepare('INSERT INTO settings(id, payload_json) VALUES(1, ?)').run(JSON.stringify(cleanSettings(DEFAULT_SETTINGS)));
    });
  }

  private work(workId: string): Work {
    const row = this.db.prepare('SELECT * FROM works WHERE id = ?').get(text(workId, '工作身份', 200)) as Row | undefined;
    if (!row) throw new Error('工作不存在。');
    return {
      id: String(row.id), title: String(row.title), goal: String(row.goal), goalRevision: Number(row.goal_revision),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at), archived: Boolean(row.archived),
    };
  }

  private touch(workId: string): void { this.db.prepare('UPDATE works SET updated_at = ? WHERE id = ?').run(now(), workId); }
  private run(runId: string): RunSnapshot {
    const row = this.db.prepare('SELECT snapshot_json FROM runs WHERE id = ?').get(text(runId, '运行身份', 200)) as Row | undefined;
    if (!row) throw new Error('运行不存在。');
    return parse<RunSnapshot>(row.snapshot_json);
  }
  private updateRun(run: RunSnapshot): void {
    this.db.prepare('UPDATE runs SET status = ?, snapshot_json = ? WHERE id = ?').run(run.status, JSON.stringify(run), run.id);
  }
  private messages(workId: string): Message[] {
    return (this.db.prepare('SELECT payload_json FROM messages WHERE work_id = ? ORDER BY rowid').all(workId) as Row[])
      .map((row) => parse<Message>(row.payload_json));
  }
  private materials(workId: string): Material[] {
    return (this.db.prepare('SELECT * FROM materials WHERE work_id = ? ORDER BY rowid').all(workId) as Row[]).map((row) => ({
      id: String(row.id), workId: String(row.work_id), title: String(row.title), content: String(row.content), hash: String(row.hash), createdAt: String(row.created_at),
    }));
  }
  private artifact(artifactId: string, workId: string): Artifact {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ? AND work_id = ?').get(artifactId, workId) as Row | undefined;
    if (!row) throw new Error('成果不属于当前工作或不存在。');
    const versions = (this.db.prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version').all(artifactId) as Row[]).map((version): ArtifactVersion => ({
      version: Number(version.version), content: String(version.content), createdAt: String(version.created_at),
      ...(version.run_id ? { runId: String(version.run_id) } : {}), baseVersion: Number(version.base_version),
      status: version.status as ArtifactVersion['status'], ...(version.note ? { note: String(version.note) } : {}),
    }));
    return { id: String(row.id), workId: String(row.work_id), title: String(row.title), kind: row.kind as ArtifactKind, currentVersion: Number(row.current_version), versions };
  }
  private state(workId: string, deviceId: string): { draft: Draft; view: ViewState } {
    text(deviceId, '设备身份', 200);
    const row = this.db.prepare('SELECT draft_json, view_json FROM device_states WHERE work_id = ? AND device_id = ?').get(workId, deviceId) as Row | undefined;
    return row ? { draft: parse<Draft>(row.draft_json), view: parse<ViewState>(row.view_json) }
      : { draft: { text: '', intent: 'discuss' }, view: structuredClone(DEFAULT_VIEW) };
  }
  private saveState(workId: string, deviceId: string, state: { draft: Draft; view: ViewState }): void {
    this.db.prepare(`INSERT INTO device_states(work_id, device_id, draft_json, view_json) VALUES(?, ?, ?, ?)
      ON CONFLICT(work_id, device_id) DO UPDATE SET draft_json = excluded.draft_json, view_json = excluded.view_json`)
      .run(workId, deviceId, JSON.stringify(state.draft), JSON.stringify(state.view));
  }

  listWorks(): Work[] {
    return (this.db.prepare('SELECT id FROM works ORDER BY updated_at DESC, rowid DESC').all() as Row[]).map((row) => this.work(String(row.id)));
  }
  createWork(input: { title: string; goal: string }): WorkDetail {
    return this.transaction(() => {
      const title = text(input.title, '工作名称', 300).trim();
      const goal = text(input.goal, '工作目标', STORAGE_LIMITS.promptCharacters, true);
      const id = randomUUID(); const timestamp = now();
      this.db.prepare('INSERT INTO works(id, title, goal, goal_revision, created_at, updated_at) VALUES(?, ?, ?, 1, ?, ?)')
        .run(id, title, goal, timestamp, timestamp);
      return this.getWork(id);
    });
  }
  getWork(workId: string, deviceId = 'desktop'): WorkDetail {
    const work = this.work(workId);
    return {
      work, messages: this.messages(workId), materials: this.materials(workId),
      runs: (this.db.prepare('SELECT snapshot_json FROM runs WHERE work_id = ? ORDER BY rowid').all(workId) as Row[]).map((row) => parse<RunSnapshot>(row.snapshot_json)),
      events: (this.db.prepare('SELECT payload_json FROM events WHERE work_id = ? ORDER BY rowid').all(workId) as Row[]).map((row) => parse<PublicEvent>(row.payload_json)),
      artifacts: (this.db.prepare('SELECT id FROM artifacts WHERE work_id = ? ORDER BY rowid').all(workId) as Row[]).map((row) => this.artifact(String(row.id), workId)),
      ...this.state(workId, deviceId),
    };
  }
  renameWork(input: { workId: string; title: string }): void {
    this.work(input.workId);
    this.db.prepare('UPDATE works SET title = ?, updated_at = ? WHERE id = ?').run(text(input.title, '工作名称', 300).trim(), now(), input.workId);
  }
  archiveWork(input: { workId: string; archived: boolean }): void {
    this.work(input.workId);
    if (typeof input.archived !== 'boolean') throw new Error('归档状态不正确。');
    this.db.prepare('UPDATE works SET archived = ?, updated_at = ? WHERE id = ?').run(Number(input.archived), now(), input.workId);
  }
  getSettings(): AppSettings {
    return parse<AppSettings>((this.db.prepare('SELECT payload_json FROM settings WHERE id = 1').get() as Row).payload_json);
  }
  getRun(runId: string): RunSnapshot { return this.run(runId); }
  validateSettings(settings: AppSettings): void { cleanSettings(settings); }
  saveSettings(settings: AppSettings): AppSettings {
    return this.transaction(() => {
      const current = this.getSettings(); const next = cleanSettings(settings);
      next.version = current.version + 1;
      next.team.version = current.team.version + (JSON.stringify(next.team.members) === JSON.stringify(current.team.members) ? 0 : 1);
      this.db.prepare('UPDATE settings SET payload_json = ? WHERE id = 1').run(JSON.stringify(next));
      return next;
    });
  }
  saveDraft(input: { workId: string; draft: Draft }, deviceId = 'desktop'): void {
    this.transaction(() => {
      this.work(input.workId);
      if (!input.draft || !INTENTS.has(input.draft.intent)) throw new Error('草稿意图不正确。');
      const draft: Draft = { text: text(input.draft.text, '草稿', STORAGE_LIMITS.promptCharacters, true), intent: input.draft.intent };
      if (input.draft.targetMemberId) draft.targetMemberId = text(input.draft.targetMemberId, '成员身份', 100);
      if (input.draft.reference) draft.reference = this.reference(input.workId, input.draft.reference).reference;
      this.saveState(input.workId, deviceId, { ...this.state(input.workId, deviceId), draft });
    });
  }
  saveView(input: { workId: string; view: Partial<ViewState> }, deviceId = 'desktop'): void {
    this.transaction(() => {
      this.work(input.workId);
      const state = this.state(input.workId, deviceId); const next = { ...state.view }; const view = input.view;
      if (view.focusedPane !== undefined) {
        if (!['all', 'conversation', 'process', 'result'].includes(view.focusedPane)) throw new Error('窗口状态不正确。');
        next.focusedPane = view.focusedPane;
      }
      if (view.activePane !== undefined) {
        if (!['conversation', 'process', 'result'].includes(view.activePane)) throw new Error('活动窗口不正确。');
        next.activePane = view.activePane;
      }
      if (view.widths !== undefined) {
        if (!Array.isArray(view.widths) || view.widths.length !== 3 || view.widths.some((width) => !Number.isFinite(width) || width < 0 || width > 100)) throw new Error('窗口宽度不正确。');
        next.widths = [...view.widths];
      }
      if (view.scroll !== undefined) {
        if (!view.scroll || typeof view.scroll !== 'object' || Object.keys(view.scroll).length > 100) throw new Error('滚动状态不正确。');
        const entries = Object.entries(view.scroll).map(([key, value]) => {
          text(key, '滚动位置', 200);
          if (!Number.isFinite(value) || value < 0) throw new Error('滚动位置不正确。');
          return [key, value] as const;
        });
        next.scroll = { ...next.scroll, ...Object.fromEntries(entries) };
      }
      if ('artifactId' in view) {
        if (view.artifactId) { this.artifact(view.artifactId, input.workId); next.artifactId = view.artifactId; }
        else { delete next.artifactId; delete next.artifactVersion; }
        if (view.artifactId !== state.view.artifactId) delete next.artifactVersion;
      }
      if ('artifactVersion' in view) {
        if (view.artifactVersion === undefined) delete next.artifactVersion;
        else {
          if (!next.artifactId || !this.artifact(next.artifactId, input.workId).versions.some((version) => version.version === view.artifactVersion)) throw new Error('成果版本不属于当前工作或不存在。');
          next.artifactVersion = view.artifactVersion;
        }
      }
      if ('eventMemberFilter' in view) {
        if (view.eventMemberFilter) next.eventMemberFilter = text(view.eventMemberFilter, '成员筛选', 100);
        else delete next.eventMemberFilter;
      }
      this.saveState(input.workId, deviceId, { draft: state.draft, view: next });
    });
  }
  addMaterial(input: { workId: string; title: string; content: string }): Material {
    return this.transaction(() => {
      this.work(input.workId);
      const content = text(input.content, '单份材料', STORAGE_LIMITS.materialCharacters);
      const title = text(input.title, '材料标题', 300).trim();
      const hash = createHash('sha256').update(content).digest('hex');
      const existing = this.materials(input.workId);
      const duplicate = existing.find((material) => material.hash === hash);
      if (duplicate) return duplicate;
      if (existing.reduce((total, material) => total + material.content.length, 0) + content.length > STORAGE_LIMITS.workMaterialCharacters) {
        throw new Error(`当前工作材料总计最多支持 ${STORAGE_LIMITS.workMaterialCharacters.toLocaleString('en-US')} 个字符；请拆分工作，原内容未被截断。`);
      }
      const material: Material = { id: randomUUID(), workId: input.workId, title, content, hash, createdAt: now() };
      this.db.prepare('INSERT INTO materials(id, work_id, title, content, hash, created_at) VALUES(?, ?, ?, ?, ?, ?)')
        .run(material.id, material.workId, material.title, material.content, material.hash, material.createdAt);
      this.touch(input.workId);
      return material;
    });
  }

  private reference(workId: string, input: Reference): { reference: Reference; content: string } {
    const id = text(input.id, '引用身份', 200); let content: string; let reference: Reference;
    if (input.kind === 'artifact') {
      const artifact = this.artifact(id, workId);
      const number = input.version ?? artifact.currentVersion;
      const version = artifact.versions.find((candidate) => candidate.version === number);
      if (!version) throw new Error('引用的成果版本不存在。');
      content = version.content; reference = { kind: 'artifact', id, version: version.version };
    } else if (input.kind === 'event') {
      const row = this.db.prepare('SELECT payload_json FROM events WHERE id = ? AND work_id = ?').get(id, workId) as Row | undefined;
      if (!row || input.version !== undefined) throw new Error('过程引用不属于当前工作或不存在。');
      content = parse<PublicEvent>(row.payload_json).body; reference = { kind: 'event', id };
    } else throw new Error('引用类型不正确。');
    if (input.quote !== undefined) {
      const quote = text(input.quote, '引用片段', STORAGE_LIMITS.artifactCharacters);
      if (!content.includes(quote)) throw new Error('引用片段已变化或不属于指定版本，请重新选择。');
      reference.quote = quote;
    }
    return { reference, content };
  }

  createRun(input: SubmitRequest, settings: AppSettings): RunSnapshot {
    return this.transaction(() => {
      let work = this.work(input.workId);
      const prompt = text(input.prompt, '输入内容', STORAGE_LIMITS.promptCharacters);
      if (!INTENTS.has(input.intent)) throw new Error('工作意图不正确。');
      const safeSettings = cleanSettings(settings);
      safeSettings.version = integer(settings.version, '设置版本', 1, Number.MAX_SAFE_INTEGER);
      safeSettings.team.version = integer(settings.team.version, '团队版本', 1, Number.MAX_SAFE_INTEGER);
      if (input.targetMemberId && !safeSettings.team.members.some((member) => member.id === input.targetMemberId)) throw new Error('指定成员不属于本次团队。');
      const referenced = input.reference ? this.reference(work.id, input.reference) : undefined;
      let base: Artifact | undefined;
      if (referenced?.reference.kind === 'artifact' && (input.intent === 'revise' || input.intent === 'explain')) base = this.artifact(referenced.reference.id, work.id);
      else {
        const kind: ArtifactKind = input.intent === 'summarize' ? 'summary' : input.intent === 'reflect' ? 'reflection' : 'deliverable';
        const row = this.db.prepare('SELECT id FROM artifacts WHERE work_id = ? AND kind = ?').get(work.id, kind) as Row | undefined;
        if (row) base = this.artifact(String(row.id), work.id);
      }
      const baseNumber = base && referenced?.reference.kind === 'artifact' && referenced.reference.id === base.id
        ? referenced.reference.version : base?.currentVersion;
      const baseVersion = base?.versions.find((version) => version.version === baseNumber);
      if (input.intent === 'revise' && !baseVersion) throw new Error('当前工作还没有可修订的成果，请先讨论形成成果。');
      if (input.intent === 'change-goal') {
        this.db.prepare('UPDATE works SET goal = ?, goal_revision = goal_revision + 1, updated_at = ? WHERE id = ?').run(prompt, now(), work.id);
        work = this.work(work.id);
      } else if (!work.goal.trim()) {
        this.db.prepare('UPDATE works SET goal = ?, updated_at = ? WHERE id = ?').run(prompt, now(), work.id);
        work = this.work(work.id);
      }
      const previous = this.db.prepare("SELECT id FROM runs WHERE work_id = ? AND status IN ('running', 'stopping')").all(work.id) as Row[];
      for (const row of previous) this.finishRun(String(row.id), 'superseded', '用户已开始新一轮工作；此运行的迟到结果只能保留为历史提案。');
      let contextEvents: PublicEvent[] | undefined;
      let contextNote: string | undefined;
      let contextArtifact: RunSnapshot['contextArtifact'];
      if (input.intent === 'summarize' || input.intent === 'reflect' || referenced?.reference.kind === 'event') {
        const eventRun = referenced?.reference.kind === 'event'
          ? this.db.prepare('SELECT run_id FROM events WHERE id = ? AND work_id = ?').get(referenced.reference.id, work.id) as Row | undefined : undefined;
        const rows = eventRun
          ? this.db.prepare('SELECT payload_json FROM events WHERE run_id = ? ORDER BY sequence').all(String(eventRun.run_id)) as Row[]
          : this.db.prepare('SELECT payload_json FROM events WHERE work_id = ? ORDER BY rowid').all(work.id) as Row[];
        contextEvents = rows.map((row) => parse<PublicEvent>(row.payload_json));
        contextNote = eventRun ? `过程上下文为所选事件所属运行的全部 ${contextEvents.length} 条已记录事件，未截断。`
          : `过程上下文为当前工作此前全部 ${contextEvents.length} 条已记录事件，未截断。`;
      }
      if (input.intent === 'reflect') {
        const deliverableRow = this.db.prepare("SELECT id FROM artifacts WHERE work_id = ? AND kind = 'deliverable'").get(work.id) as Row | undefined;
        const deliverable = deliverableRow ? this.artifact(String(deliverableRow.id), work.id) : undefined;
        const currentVersion = deliverable?.versions.find((version) => version.version === deliverable.currentVersion);
        if (deliverable && currentVersion) {
          contextArtifact = { id: deliverable.id, title: deliverable.title, kind: deliverable.kind, version: currentVersion.version, content: currentVersion.content };
          contextNote += `\n本次复盘同时对照主成果“${deliverable.title}”第 ${currentVersion.version} 版的完整正文。复盘报告单独保存，不修改主成果。`;
        } else contextNote += '\n当前工作尚无已采纳的主成果，不应假定成果已经完成。';
      }
      const run: RunSnapshot = {
        id: randomUUID(), workId: work.id, goal: work.goal, goalRevision: work.goalRevision, prompt, intent: input.intent,
        ...(input.targetMemberId ? { targetMemberId: input.targetMemberId } : {}),
        ...(referenced ? { reference: referenced.reference, referenceContent: referenced.content } : {}),
        createdAt: now(), status: 'running', strategyVersion: safeSettings.strategy,
        settings: safeSettings, materials: this.materials(work.id), messages: this.messages(work.id),
        ...(base && baseVersion ? { baseArtifact: { id: base.id, title: base.title, kind: base.kind, version: baseVersion.version, content: baseVersion.content } } : {}),
        ...(contextEvents ? { contextEvents, contextNote } : {}),
        ...(contextArtifact ? { contextArtifact } : {}),
        usage: { inputTokens: 0, outputTokens: 0, calls: 0, known: false },
      };
      this.db.prepare('INSERT INTO runs(id, work_id, status, created_at, snapshot_json) VALUES(?, ?, ?, ?, ?)')
        .run(run.id, run.workId, run.status, run.createdAt, JSON.stringify(run));
      const message: Message = { id: randomUUID(), workId: work.id, role: 'user', content: prompt, createdAt: run.createdAt, runId: run.id,
        ...(run.targetMemberId ? { memberId: run.targetMemberId } : {}), ...(run.reference ? { reference: run.reference } : {}) };
      this.insertMessage(message);
      this.touch(work.id);
      return run;
    });
  }

  private insertMessage(message: Message): void {
    this.db.prepare('INSERT INTO messages(id, work_id, run_id, created_at, payload_json) VALUES(?, ?, ?, ?, ?)')
      .run(message.id, message.workId, message.runId ?? null, message.createdAt, JSON.stringify(message));
  }

  appendEvent(runId: string, input: EventInput): PublicEvent {
    return this.transaction(() => {
      const run = this.run(runId);
      if (!EVENT_TYPES.has(input.type)) throw new Error('过程事件类型不正确。');
      const title = text(input.title, '过程标题', 1000);
      const body = text(input.body, '过程内容', STORAGE_LIMITS.artifactCharacters, true);
      if (input.memberId && !run.settings.team.members.some((member) => member.id === input.memberId)) throw new Error('过程成员不属于此运行的团队快照。');
      const optionalText = (value: string | undefined, name: string, max = 200): string | undefined => value === undefined ? undefined : text(value, name, max);
      const key = optionalText(input.key, '事件幂等键');
      const priorRow = key ? this.db.prepare('SELECT payload_json FROM events WHERE run_id = ? AND event_key = ?').get(runId, key) as Row | undefined : undefined;
      const prior = priorRow ? parse<PublicEvent>(priorRow.payload_json) : undefined;
      if (prior && (prior.type !== input.type || prior.memberId !== input.memberId || prior.taskId !== input.taskId || prior.parentTaskId !== input.parentTaskId)) {
        throw new Error('同一事件键不能更改事件类型、成员或任务身份。');
      }
      const sourceIds = input.sourceIds?.map((id) => {
        if (!run.materials.some((material) => material.id === id)) throw new Error('材料引用不属于此运行的输入快照。');
        return id;
      });
      const relatedEventIds = input.relatedEventIds?.map((id) => {
        if (!this.db.prepare('SELECT 1 FROM events WHERE id = ? AND work_id = ?').get(id, run.workId)) throw new Error('相关过程不属于当前工作或不存在。');
        return id;
      });
      let usage: PublicEvent['usage'];
      if (input.usage !== undefined) {
        if (input.type !== 'usage' || typeof input.usage.known !== 'boolean') throw new Error('用量事件格式不正确。');
        usage = {
          calls: integer(input.usage.calls, '调用次数', 0, 1_000_000), known: input.usage.known,
          ...(input.usage.inputTokens === undefined ? {} : { inputTokens: integer(input.usage.inputTokens, '输入用量', 0, Number.MAX_SAFE_INTEGER) }),
          ...(input.usage.outputTokens === undefined ? {} : { outputTokens: integer(input.usage.outputTokens, '输出用量', 0, Number.MAX_SAFE_INTEGER) }),
        };
        if (usage.known && (usage.inputTokens === undefined || usage.outputTokens === undefined)) throw new Error('完整用量必须同时包含输入和输出数值。');
      }
      const event: PublicEvent = {
        id: prior?.id ?? randomUUID(), workId: run.workId, runId, sequence: prior?.sequence ?? Number((this.db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM events WHERE run_id = ?').get(runId) as Row).next),
        createdAt: prior?.createdAt ?? now(), type: input.type, title, body,
        ...(input.memberId ? { memberId: input.memberId } : {}),
        ...(input.taskId ? { taskId: optionalText(input.taskId, '任务身份') } : {}),
        ...(input.parentTaskId ? { parentTaskId: optionalText(input.parentTaskId, '父任务身份') } : {}),
        ...(input.requirement ? { requirement: optionalText(input.requirement, '完成要求', 20_000) } : {}),
        ...(sourceIds ? { sourceIds } : {}), ...(relatedEventIds ? { relatedEventIds } : {}),
        ...(input.streaming !== undefined ? { streaming: run.status === 'running' && Boolean(input.streaming) } : {}), ...(key ? { key } : {}),
        ...(usage ? { usage } : {}),
      };
      if (prior) this.db.prepare('UPDATE events SET payload_json = ? WHERE id = ?').run(JSON.stringify(event), prior.id);
      else this.db.prepare('INSERT INTO events(id, work_id, run_id, sequence, event_key, payload_json) VALUES(?, ?, ?, ?, ?, ?)')
        .run(event.id, event.workId, event.runId, event.sequence, key ?? null, JSON.stringify(event));
      if (usage || prior?.usage) {
        // Recompute from settled call events: retries/upserts can correct usage without double counting.
        const recordedUsage = (this.db.prepare('SELECT payload_json FROM events WHERE run_id = ?').all(runId) as Row[])
          .map((row) => parse<PublicEvent>(row.payload_json).usage).filter((entry): entry is NonNullable<PublicEvent['usage']> => entry !== undefined);
        run.usage = {
          calls: recordedUsage.reduce((sum, entry) => sum + entry.calls, 0),
          inputTokens: recordedUsage.reduce((sum, entry) => sum + (entry.inputTokens ?? 0), 0),
          outputTokens: recordedUsage.reduce((sum, entry) => sum + (entry.outputTokens ?? 0), 0),
          known: recordedUsage.length > 0 && recordedUsage.every((entry) => entry.known),
        };
        this.updateRun(run);
      }
      return event;
    });
  }

  private artifactVersion(artifact: Artifact, content: string, baseVersion: number, proposal: boolean, runId?: string, note?: string): void {
    const number = (artifact.versions.at(-1)?.version ?? 0) + 1;
    if (!proposal) this.db.prepare("UPDATE artifact_versions SET status = 'history' WHERE artifact_id = ? AND status = 'current'").run(artifact.id);
    this.db.prepare('INSERT INTO artifact_versions(artifact_id, work_id, version, content, created_at, run_id, base_version, status, note) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(artifact.id, artifact.workId, number, content, now(), runId ?? null, baseVersion, proposal ? 'proposal' : 'current', note ?? null);
    if (!proposal) this.db.prepare('UPDATE artifacts SET current_version = ? WHERE id = ?').run(number, artifact.id);
  }

  completeRun(runId: string, result: CoreResult): void {
    this.transaction(() => {
      const run = this.run(runId);
      const recorded = this.db.prepare('SELECT result_recorded FROM runs WHERE id = ?').get(runId) as Row;
      if (recorded.result_recorded) return;
      const answer = text(result.answer, '回复', STORAGE_LIMITS.artifactCharacters, true);
      const changes = result.changes === undefined ? undefined : text(result.changes, '修改说明', STORAGE_LIMITS.artifactCharacters, true);
      const work = this.work(run.workId);
      const current = run.status === 'running' && run.goalRevision === work.goalRevision;
      let proposalReason: string | undefined = current ? undefined : '此运行已停止、被替代或不再对应当前目标；结果保留为提案，未更新当前成果。';
      let storedArtifact: CoreResult['artifact'];
      if (run.intent !== 'explain' && result.artifact) {
        const title = text(result.artifact.title, '成果标题', 300).trim();
        const content = text(result.artifact.content, '成果正文', STORAGE_LIMITS.artifactCharacters);
        const kind: ArtifactKind = run.intent === 'summarize' ? 'summary' : run.intent === 'reflect' ? 'reflection' : run.baseArtifact?.kind ?? 'deliverable';
        let row = this.db.prepare('SELECT id FROM artifacts WHERE work_id = ? AND kind = ?').get(run.workId, kind) as Row | undefined;
        if (!row) {
          const id = randomUUID();
          this.db.prepare('INSERT INTO artifacts(id, work_id, title, kind) VALUES(?, ?, ?, ?)').run(id, run.workId, title, kind);
          row = { id };
        }
        const artifact = this.artifact(String(row.id), run.workId);
        const baseVersion = run.baseArtifact?.id === artifact.id ? run.baseArtifact.version : 0;
        if (artifact.currentVersion !== baseVersion) proposalReason ??= '生成期间成果已被修改，或本次基于历史版本；新内容保存为提案，未覆盖当前版本。';
        this.artifactVersion(artifact, content, baseVersion, Boolean(proposalReason), run.id, proposalReason ?? changes);
        if (!proposalReason) this.db.prepare('UPDATE artifacts SET title = ? WHERE id = ?').run(title, artifact.id);
        storedArtifact = { title, content, kind };
      }
      if (current) {
        this.insertMessage({ id: randomUUID(), workId: run.workId, role: 'assistant', content: answer, createdAt: now(), runId,
          ...(run.targetMemberId ? { memberId: run.targetMemberId } : {}) });
        run.status = 'completed'; run.finishedAt = now();
        this.updateRun(run);
      }
      if (proposalReason) this.appendEvent(runId, { type: 'status', title: current ? '成果提案待处理' : '迟到结果已隔离', body: `${proposalReason}${!current && answer ? `\n\n原运行返回：\n${answer}` : ''}` });
      this.db.prepare('UPDATE runs SET result_recorded = 1, result_json = ? WHERE id = ?')
        .run(JSON.stringify({ answer, ...(storedArtifact ? { artifact: storedArtifact } : {}), ...(changes ? { changes } : {}) }), runId);
      this.touch(run.workId);
    });
  }

  finishRun(runId: string, status: RunStatus, message?: string): void {
    this.transaction(() => {
      const run = this.run(runId);
      if (!RUN_STATUSES.has(status) || status === 'running') throw new Error('结束状态不正确。');
      if (TERMINAL_STATUSES.has(run.status)) return;
      if (run.status === 'stopping' && status === 'completed') return;
      run.status = status;
      if (status !== 'stopping') run.finishedAt = now();
      if (message !== undefined) run.error = text(message, '运行说明', 30_000, true);
      this.updateRun(run);
      // A cancelled stream must not continue looking active after reopening the application.
      if (status !== 'stopping') {
        const events = this.db.prepare('SELECT id, payload_json FROM events WHERE run_id = ?').all(runId) as Row[];
        for (const row of events) {
          const event = parse<PublicEvent>(row.payload_json);
          if (event.streaming) { event.streaming = false; this.db.prepare('UPDATE events SET payload_json = ? WHERE id = ?').run(JSON.stringify(event), String(row.id)); }
        }
      }
      this.touch(run.workId);
    });
  }

  saveArtifact(input: SaveArtifactRequest): Artifact {
    return this.transaction(() => {
      this.work(input.workId);
      const artifact = this.artifact(input.artifactId, input.workId);
      const content = text(input.content, '成果正文', STORAGE_LIMITS.artifactCharacters, true);
      integer(input.baseVersion, '编辑基线', 1, Number.MAX_SAFE_INTEGER);
      if (!artifact.versions.some((version) => version.version === input.baseVersion)) throw new Error('编辑基线版本不存在。');
      const conflict = artifact.currentVersion !== input.baseVersion;
      this.artifactVersion(artifact, content, input.baseVersion, conflict, undefined,
        conflict ? '编辑基线已变化；保存为提案，未覆盖当前版本。' : '用户编辑');
      this.touch(input.workId);
      return this.artifact(artifact.id, artifact.workId);
    });
  }
  recoverInterruptedRuns(): number {
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT id FROM runs WHERE status IN ('running', 'stopping')").all() as Row[];
      for (const row of rows) this.finishRun(String(row.id), 'interrupted', '上次运行随进程中断，远端结果未知；未自动重试。');
      return rows.length;
    });
  }
}
