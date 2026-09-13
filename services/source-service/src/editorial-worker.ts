import { createHash, randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import {
  EditorialBodySchema,
  EditorialMaterialSchema,
  EditorialRevisionSchema,
  type EditorialFocus,
  type EditorialMaterial,
  type EditorialRevision,
} from "@ytriple/source-contract";
import { type PoolClient } from "pg";
import { type SourceDatabase } from "./store/database.js";
import { correctionFromRow } from "./editorial-store.js";
import {
  EditorialDraftSchema,
  EditorialSelectionSchema,
  type EditorialModel,
  type EditorialPitch,
  type ExistingEditorial,
} from "./editorial-model.js";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const matchers: Record<EditorialFocus, RegExp> = {
  AI: /\bai\b|人工智能|大模型|智能体|gemini|copilot|agent|machine learning|hugging face/i,
  科技: /科技|数码|芯片|硬件|软件|开发工具|代码|手机|科学|\bcode\b|github|technology|iphone|apple|research/i,
  金融: /金融|宏观|利率|货币|银行|联储|通胀|federal reserve|monetary|interest rate|inflation|central bank/i,
  股票: /股票|财报|营收|上市|证券|季度业绩|earnings|shareholder|stock market|stock price|financial results/i,
};
export function focusFor(
  title: string,
  category: string,
  excerpt: string,
): EditorialFocus | undefined {
  return (Object.entries(matchers) as [EditorialFocus, RegExp][])
    .map(([focus, pattern]) => ({
      focus,
      score:
        Number(pattern.test(title)) * 5 +
        Number(pattern.test(category)) * 3 +
        Number(pattern.test(excerpt.slice(0, 1800))),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.focus;
}
function canonical(url: string): string {
  const value = new URL(url);
  value.hash = "";
  for (const key of [...value.searchParams.keys()])
    if (/^utm_|^(fbclid|gclid)$/i.test(key)) value.searchParams.delete(key);
  return value.href;
}
export function uniqueMaterials(
  materials: EditorialMaterial[],
): EditorialMaterial[] {
  const urls = new Set<string>(),
    hashes = new Set<string>();
  return materials.filter((material) => {
    const url = canonical(material.url);
    if (urls.has(url) || hashes.has(material.contentHash)) return false;
    urls.add(url);
    hashes.add(material.contentHash);
    return true;
  });
}

export async function editorialInputs(
  database: SourceDatabase,
): Promise<
  { tenantId: string; focus: EditorialFocus; materials: EditorialMaterial[] }[]
> {
  const result = await database.pool.query(`
    SELECT * FROM (
      SELECT *,row_number() OVER(PARTITION BY tenant_id ORDER BY COALESCE(published_at,observed_at) DESC,item_id) AS n FROM (
        SELECT DISTINCT ON (f.tenant_id,i.id) f.tenant_id,i.id AS item_id,i.title,i.canonical_url,
          r.id AS revision_id,r.content,r.content_hash,r.coverage,r.missing,r.published_at,r.observed_at,
          f.name AS source_name,f.category,f.origin
        FROM source_follow f JOIN source_item i ON i.tenant_id=f.tenant_id AND i.source_id=f.source_id
        JOIN item_revision r ON r.tenant_id=i.tenant_id AND r.id=i.latest_revision_id
        WHERE f.state='active' ORDER BY f.tenant_id,i.id,CASE WHEN f.origin='user' THEN 0 ELSE 1 END,f.id
      ) current_material
    ) recent WHERE n<=160 ORDER BY COALESCE(published_at,observed_at) DESC,item_id
  `);
  const groups = new Map<
    string,
    { tenantId: string; focus: EditorialFocus; materials: EditorialMaterial[] }
  >();
  for (const row of result.rows) {
    const focus = focusFor(row.title, row.category, row.content);
    if (!focus) continue;
    const key = `${row.tenant_id}:${focus}`;
    const group = groups.get(key) ?? {
      tenantId: row.tenant_id,
      focus,
      materials: [] as EditorialMaterial[],
    };
    group.materials.push(
      EditorialMaterialSchema.parse({
        itemId: row.item_id,
        revisionId: row.revision_id,
        contentHash: row.content_hash,
        title: row.title,
        url: row.canonical_url,
        sourceName: row.source_name,
        origin: row.origin,
        coverage: row.coverage,
        missing: [
          ...row.missing,
          ...(row.content.length > 7000
            ? ["此次解读仅读取正文前 7000 字符；后续内容未进入判断依据。"]
            : []),
        ],
        publishedAt: row.published_at?.toISOString(),
        observedAt: row.observed_at.toISOString(),
        excerpt: row.content.slice(0, 7000),
      }),
    );
    groups.set(key, group);
  }
  // A correction to an older issue must be reviewed even when no current feed
  // entry still matches that focus. Its immutable evidence remains available.
  const pending = await database.pool.query(
    `SELECT DISTINCT c.tenant_id,i.focus FROM editorial_correction c JOIN editorial_issue i ON i.tenant_id=c.tenant_id AND i.id=c.issue_id WHERE c.status='pending'`,
  );
  for (const row of pending.rows) {
    const key = `${row.tenant_id}:${row.focus}`;
    if (!groups.has(key))
      groups.set(key, {
        tenantId: row.tenant_id,
        focus: row.focus,
        materials: [],
      });
  }
  return [...groups.values()].map((group) => ({
    ...group,
    materials: uniqueMaterials(group.materials).slice(0, 24),
  }));
}

export class EditorialWorker {
  private stopping = false;
  private running?: Promise<void>;
  private controller = new AbortController();
  constructor(
    private database: SourceDatabase,
    private model: EditorialModel,
    private modelName: string,
  ) {}

  async refresh(): Promise<void> {
    for (const input of await editorialInputs(this.database)) {
      if (this.stopping) return;
      const client = await this.database.pool.connect();
      const lock = `${input.tenantId}:editorial:${input.focus}`;
      let held = false;
      try {
        const result = await client.query(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS held",
          [lock],
        );
        if (!result.rows[0]?.held) continue;
        held = true;
        const correctionRows = await client.query(
          `SELECT c.* FROM editorial_correction c JOIN editorial_issue i ON i.tenant_id=c.tenant_id AND i.id=c.issue_id WHERE c.tenant_id=$1 AND i.focus=$2 ORDER BY c.created_at,c.id`,
          [input.tenantId, input.focus],
        );
        const inputHash = hash({
          pipeline: "editorial-v1",
          model: this.modelName,
          focus: input.focus,
          materials: input.materials.map((material) => [
            material.itemId,
            material.revisionId,
          ]),
          corrections: correctionRows.rows.map((row) => [row.id, row.text]),
        });
        const run = (
          await client.query(
            "SELECT * FROM editorial_run WHERE tenant_id=$1 AND focus=$2",
            [input.tenantId, input.focus],
          )
        ).rows[0];
        if (
          run?.input_hash === inputHash &&
          (run.completed_hash === inputHash ||
            Date.now() - run.attempted_at.getTime() < 300_000)
        )
          continue;
        await client.query(
          `INSERT INTO editorial_run(tenant_id,focus,input_hash) VALUES($1,$2,$3) ON CONFLICT(tenant_id,focus) DO UPDATE SET input_hash=$3,plan=CASE WHEN editorial_run.input_hash=$3 THEN editorial_run.plan ELSE NULL END,attempted_at=now(),error=NULL`,
          [input.tenantId, input.focus, inputHash],
        );
        try {
          const knownRows = (
            await client.query(
              `SELECT i.id,i.issue_key,i.focus,r.body FROM editorial_issue i JOIN editorial_revision r ON r.tenant_id=i.tenant_id AND r.id=i.latest_revision_id WHERE i.tenant_id=$1 AND (i.id IN (SELECT id FROM editorial_issue WHERE tenant_id=$1 ORDER BY updated_at DESC LIMIT 60) OR i.id IN (SELECT issue_id FROM editorial_correction WHERE tenant_id=$1 AND status='pending')) ORDER BY i.updated_at DESC`,
              [input.tenantId],
            )
          ).rows;
          const existing: ExistingEditorial[] = knownRows.map((row) => ({
            id: row.id,
            key: row.issue_key,
            focus: row.focus,
            latest: EditorialRevisionSchema.parse(row.body),
          }));
          const selected = EditorialSelectionSchema.parse(
            run?.input_hash === inputHash && run.plan
              ? run.plan
              : input.materials.length
                ? await this.model.select({ ...input, existing })
                : { pitches: [], skipReason: "当前仅复核已有议题的纠正。" },
          );
          const available = new Map(
            input.materials.map((material) => [material.itemId, material]),
          );
          const seen = new Set<string>();
          for (const pitch of selected.pitches) {
            if (
              seen.has(pitch.key) ||
              pitch.materialIds.some((id) => !available.has(id))
            )
              throw new Error("选题引用无效。");
            seen.add(pitch.key);
            if (
              pitch.existingIssueId &&
              !existing.some(
                (issue) =>
                  issue.id === pitch.existingIssueId && issue.key === pitch.key,
              )
            )
              throw new Error("选题的历史议题无效。");
          }
          const pending = correctionRows.rows.filter(
            (row) => row.status === "pending",
          );
          const pitches = [...selected.pitches];
          for (const row of pending) {
            const issue = existing.find(
              (candidate) => candidate.id === row.issue_id,
            );
            if (!issue) throw new Error("纠正对应的议题暂不可读。");
            if (!pitches.some((pitch) => pitch.key === issue.key))
              pitches.push({
                key: issue.key,
                existingIssueId: issue.id,
                question: issue.latest.question,
                why: "复核用户对当前理解的纠正。",
                materialIds: [],
              });
          }
          await client.query(
            "UPDATE editorial_run SET plan=$3::jsonb WHERE tenant_id=$1 AND focus=$2",
            [input.tenantId, input.focus, JSON.stringify(selected)],
          );
          for (const pitch of pitches) {
            if (this.stopping) return;
            const previous = existing.find(
              (issue) => issue.key === pitch.key,
            )?.latest;
            const chosen = pitch.materialIds.map((id) => available.get(id)!);
            const materialIds = new Set(
              chosen.map((material) => material.itemId),
            );
            const material = uniqueMaterials([
              ...chosen,
              ...(previous?.evidence ?? []).filter(
                (item) => !materialIds.has(item.itemId),
              ),
            ]).slice(0, 12);
            if (!material.length) throw new Error("没有可读取的选题材料。");
            const corrections = pending
              .filter((row) => row.issue_id === previous?.issueId)
              .slice(0, 30)
              .map(correctionFromRow);
            await this.produce(
              client,
              input.tenantId,
              input.focus,
              pitch,
              material,
              previous,
              corrections,
            );
          }
          const remaining = await client.query(
            "SELECT 1 FROM editorial_correction c JOIN editorial_issue i ON i.tenant_id=c.tenant_id AND i.id=c.issue_id WHERE c.tenant_id=$1 AND i.focus=$2 AND c.status='pending' LIMIT 1",
            [input.tenantId, input.focus],
          );
          await client.query(
            "UPDATE editorial_run SET completed_hash=$3,error=NULL WHERE tenant_id=$1 AND focus=$2",
            [
              input.tenantId,
              input.focus,
              remaining.rowCount ? null : inputHash,
            ],
          );
        } catch (error) {
          const problem =
            error instanceof ZodError
              ? error.issues.map((issue) => ({
                  path: issue.path,
                  code: issue.code,
                }))
              : error instanceof Error &&
                  /^(栏目|选题|解读|纠正|采纳|没有|议题)/.test(error.message)
                ? error.message
                : "invalid_editorial_response";
          process.stderr.write(
            JSON.stringify({
              event: "editorial.retry",
              focus: input.focus,
              problem,
            }) + "\n",
          );
          await client.query(
            "UPDATE editorial_run SET error='本轮栏目制作暂未完成，保留已有解读并稍后重试。' WHERE tenant_id=$1 AND focus=$2",
            [input.tenantId, input.focus],
          );
        }
      } finally {
        if (held)
          await client
            .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lock])
            .catch(() => {});
        client.release();
      }
    }
  }

  private async produce(
    client: PoolClient,
    tenantId: string,
    focus: EditorialFocus,
    pitch: EditorialPitch,
    materials: EditorialMaterial[],
    previous: EditorialRevision | undefined,
    corrections: ReturnType<typeof correctionFromRow>[],
  ): Promise<void> {
    const inputHash = hash({
      pipeline: "editorial-v1",
      model: this.modelName,
      key: pitch.key,
      materials: materials.map((material) => [
        material.itemId,
        material.revisionId,
      ]),
      corrections: corrections.map((correction) => [
        correction.id,
        correction.text,
      ]),
    });
    const row = (
      await client.query(
        "SELECT * FROM editorial_issue WHERE tenant_id=$1 AND issue_key=$2",
        [tenantId, pitch.key],
      )
    ).rows[0];
    if (row?.last_input_hash === inputHash) return;
    const draft = EditorialDraftSchema.parse(
      await this.model.write({
        focus,
        pitch,
        materials,
        previous,
        corrections,
      }),
    );
    const ids = new Set(materials.map((material) => material.itemId));
    const appraised = new Set(
      draft.body.sourceAppraisals.map((source) => source.itemId),
    );
    if (
      appraised.size !== draft.body.sourceAppraisals.length ||
      draft.body.sourceAppraisals.some(
        (source) =>
          !ids.has(source.itemId) ||
          (source.sharedOriginWith !== null &&
            (!ids.has(source.sharedOriginWith) ||
              source.sharedOriginWith === source.itemId)),
      ) ||
      draft.body.sections.some((section) =>
        section.sourceIds.some((id) => !appraised.has(id)),
      )
    )
      throw new Error("解读证据引用无效。");
    const correctionIds = new Set(
      corrections.map((correction) => correction.id),
    );
    if (
      draft.correctionResponses.length !== corrections.length ||
      new Set(draft.correctionResponses.map((response) => response.id)).size !==
        corrections.length ||
      draft.correctionResponses.some(
        (response) => !correctionIds.has(response.id),
      )
    )
      throw new Error("纠正复核结果不完整。");
    const core = (body: unknown) => {
      const parsed = EditorialBodySchema.parse(body);
      return hash({
        takeaway: parsed.takeaway,
        relationship: parsed.relationship,
        sections: parsed.sections,
        uncertainties: parsed.uncertainties,
        watchFor: parsed.watchFor,
      });
    };
    const publish =
      draft.publish && (!previous || core(draft.body) !== core(previous));
    if (
      !publish &&
      draft.correctionResponses.some(
        (response) => response.status === "accepted",
      )
    )
      throw new Error("采纳纠正必须修改解读。");
    await client.query("BEGIN");
    try {
      // Different focus batches may discover the same issue. Fence the write
      // against the exact previous revision supplied to the model.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`${tenantId}:editorial-issue:${pitch.key}`],
      );
      const current = (
        await client.query(
          "SELECT * FROM editorial_issue WHERE tenant_id=$1 AND issue_key=$2 FOR UPDATE",
          [tenantId, pitch.key],
        )
      ).rows[0];
      if (current?.last_input_hash === inputHash) {
        await client.query("COMMIT");
        return;
      }
      if ((current?.latest_revision_id ?? undefined) !== previous?.id)
        throw new Error("议题已更新，需重新复核。");
      const issueId = current?.id ?? randomUUID();
      if (!current)
        await client.query(
          "INSERT INTO editorial_issue(tenant_id,id,issue_key,focus) VALUES($1,$2,$3,$4)",
          [tenantId, issueId, pitch.key, focus],
        );
      if (publish) {
        const revision = EditorialRevisionSchema.parse({
          ...draft.body,
          id: randomUUID(),
          issueId,
          version: (previous?.version ?? 0) + 1,
          createdAt: new Date().toISOString(),
          changeKind: previous
            ? corrections.length
              ? "correction"
              : "update"
            : "new",
          changeSummary: draft.changeSummary,
          model: this.modelName,
          evidence: materials,
        });
        await client.query(
          "INSERT INTO editorial_revision(tenant_id,id,issue_id,version,body) VALUES($1,$2,$3,$4,$5::jsonb)",
          [
            tenantId,
            revision.id,
            issueId,
            revision.version,
            JSON.stringify(revision),
          ],
        );
        await client.query(
          "UPDATE editorial_issue SET latest_revision_id=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2",
          [tenantId, issueId, revision.id],
        );
      }
      await client.query(
        "UPDATE editorial_issue SET last_input_hash=$3 WHERE tenant_id=$1 AND id=$2",
        [tenantId, issueId, inputHash],
      );
      for (const response of draft.correctionResponses)
        await client.query(
          "UPDATE editorial_correction SET status=$3,response=$4,reviewed_at=now() WHERE tenant_id=$1 AND id=$2 AND status='pending'",
          [tenantId, response.id, response.status, response.response],
        );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  }
  start(): Promise<void> {
    return (this.running ??= (async () => {
      while (!this.stopping) {
        try {
          await this.refresh();
        } catch {
          /* A database outage must not permanently stop editorial work. */
        }
        try {
          await delay(30_000, undefined, { signal: this.controller.signal });
        } catch {
          if (!this.stopping) throw new Error("栏目调度中断。");
        }
      }
    })());
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.controller.abort();
    await this.running;
  }
}
