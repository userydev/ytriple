import { randomUUID } from "node:crypto";
import {
  EditorialCorrectionSchema,
  EditorialEditionSchema,
  EditorialIssueSchema,
  EditorialRevisionSchema,
  type EditorialCorrection,
  type EditorialCorrectionRequest,
  type EditorialIssue,
  type EditorialResponse,
  type EditorialRevision,
} from "@ytriple/source-contract";
import {
  ConflictError,
  IdempotencyConflictError,
  NotFoundError,
  type SourceDatabase,
} from "./store/database.js";

export function correctionFromRow(
  row: Record<string, unknown>,
): EditorialCorrection {
  return EditorialCorrectionSchema.parse({
    id: row.id,
    issueId: row.issue_id,
    revisionId: row.revision_id,
    text: row.text,
    createdAt: new Date(row.created_at as string).toISOString(),
    status: row.status,
    response: row.response ?? undefined,
    reviewedAt: row.reviewed_at
      ? new Date(row.reviewed_at as string).toISOString()
      : undefined,
  });
}

export async function editorialFeed(
  database: SourceDatabase,
  tenantId: string,
): Promise<Omit<EditorialResponse, "meta">> {
  const client = await database.pool.connect();
  const { current, versions, corrections, runs, editions } =
    await (async () => {
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const current = await client.query(
          `SELECT i.*,r.body,p.body AS presentation FROM editorial_issue i JOIN editorial_revision r ON r.tenant_id=i.tenant_id AND r.id=i.latest_revision_id LEFT JOIN editorial_presentation p ON p.tenant_id=r.tenant_id AND p.revision_id=r.id WHERE i.tenant_id=$1 ORDER BY i.updated_at DESC,i.id LIMIT 24`,
          [tenantId],
        );
        const ids = current.rows.map((row) => row.id);
        const versions = await client.query(
          `SELECT issue_id,body->>'id' AS id,(body->>'version')::integer AS version,body->>'createdAt' AS created_at,body->>'changeKind' AS kind,body->>'changeSummary' AS summary FROM (SELECT *,row_number() OVER(PARTITION BY issue_id ORDER BY version DESC) AS n FROM editorial_revision WHERE tenant_id=$1 AND issue_id=ANY($2::uuid[])) revisions WHERE n<=30 ORDER BY issue_id,version DESC`,
          [tenantId, ids],
        );
        const corrections = await client.query(
          `SELECT * FROM (SELECT *,row_number() OVER(PARTITION BY issue_id ORDER BY created_at DESC) AS n FROM editorial_correction WHERE tenant_id=$1 AND issue_id=ANY($2::uuid[])) corrections WHERE n<=30 ORDER BY created_at DESC`,
          [tenantId, ids],
        );
        const runs = await client.query(
          "SELECT attempted_at,error FROM editorial_run WHERE tenant_id=$1 ORDER BY attempted_at DESC",
          [tenantId],
        );
        const editions = await client.query(
          "SELECT body FROM editorial_edition WHERE tenant_id=$1 AND body IS NOT NULL ORDER BY published_at DESC LIMIT 1",
          [tenantId],
        );
        await client.query("COMMIT");
        return { current, versions, corrections, runs, editions };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    })();
  const edition = editions.rows[0]
    ? EditorialEditionSchema.parse(editions.rows[0].body)
    : undefined;
  if (edition)
    edition.entries = edition.entries.filter((entry) =>
      current.rows.some(
        (row) =>
          row.id === entry.issueId &&
          row.body.id === entry.presentation.revisionId,
      ),
    );
  const issues: EditorialIssue[] = current.rows.map((row) =>
    EditorialIssueSchema.parse({
      id: row.id,
      focus: row.focus,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      latest: {
        ...row.body,
        cover: edition?.entries.find(
          (entry) => entry.presentation.revisionId === row.body.id,
        )?.cover,
        presentation:
          edition?.entries.find(
            (entry) => entry.presentation.revisionId === row.body.id,
          )?.presentation ??
          row.presentation ??
          undefined,
      },
      history: versions.rows
        .filter((version) => version.issue_id === row.id)
        .map((version) => ({
          id: version.id,
          issueId: row.id,
          version: Number(version.version),
          createdAt: version.created_at,
          changeKind: version.kind,
          changeSummary: version.summary,
        })),
      corrections: corrections.rows
        .filter((correction) => correction.issue_id === row.id)
        .map(correctionFromRow),
    }),
  );
  const failed = runs.rows.some((row) => row.error);
  return {
    issues,
    edition,
    status: {
      state: failed ? "retrying" : issues.length ? "ready" : "waiting",
      lastAttemptAt: runs.rows[0]?.attempted_at.toISOString(),
      message: failed ? "本轮整理尚未完成，已有解读仍可阅读。" : undefined,
    },
  };
}

export async function editorialVersion(
  database: SourceDatabase,
  tenantId: string,
  issueId: string,
  revisionId: string,
): Promise<EditorialRevision> {
  const result = await database.pool.query(
    `SELECT r.body,COALESCE(e.presentation,p.body) AS presentation,e.cover FROM editorial_revision r LEFT JOIN editorial_presentation p ON p.tenant_id=r.tenant_id AND p.revision_id=r.id LEFT JOIN LATERAL (SELECT entry->'presentation' AS presentation,entry->'cover' AS cover FROM editorial_edition ed CROSS JOIN LATERAL jsonb_array_elements(ed.body->'entries') entry WHERE ed.tenant_id=r.tenant_id AND entry->'presentation'->>'revisionId'=r.id::text ORDER BY ed.published_at DESC LIMIT 1) e ON true WHERE r.tenant_id=$1 AND r.issue_id=$2 AND r.id=$3`,
    [tenantId, issueId, revisionId],
  );
  if (!result.rows[0]) throw new NotFoundError();
  return EditorialRevisionSchema.parse({
    ...result.rows[0].body,
    presentation: result.rows[0].presentation ?? undefined,
    cover: result.rows[0].cover ?? undefined,
  });
}

export async function correctEditorial(
  database: SourceDatabase,
  tenantId: string,
  issueId: string,
  input: EditorialCorrectionRequest,
  key: string,
): Promise<EditorialCorrection> {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${tenantId}:editorial-correction:${key}`,
    ]);
    const existing = await client.query(
      "SELECT * FROM editorial_correction WHERE tenant_id=$1 AND request_key=$2",
      [tenantId, key],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (
        row.issue_id !== issueId ||
        row.revision_id !== input.revisionId ||
        row.text !== input.text
      )
        throw new IdempotencyConflictError();
      await client.query("COMMIT");
      return correctionFromRow(row);
    }
    const issue = await client.query(
      "SELECT latest_revision_id FROM editorial_issue WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [tenantId, issueId],
    );
    if (!issue.rows[0]) throw new NotFoundError();
    if (issue.rows[0].latest_revision_id !== input.revisionId)
      throw new ConflictError("解读已有新版本，请阅读当前版本后再提交纠正。");
    const result = await client.query(
      `INSERT INTO editorial_correction(tenant_id,id,issue_id,revision_id,request_key,text) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [tenantId, randomUUID(), issueId, input.revisionId, key, input.text],
    );
    await client.query("COMMIT");
    return correctionFromRow(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
