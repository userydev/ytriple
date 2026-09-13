import assert from "node:assert/strict";
import test from "node:test";
import { geminiEditorialModel } from "../src/editorial-model.js";
import { focusFor, uniqueMaterials } from "../src/editorial-worker.js";
import { editorialRevision } from "../../../tests/fixtures/editorial.js";

test("editorial keyword candidates and repeated originals stay distinct from independent evidence", () => {
  assert.equal(
    focusFor("Federal Reserve issues monetary statement", "金融", ""),
    "金融",
  );
  assert.equal(
    focusFor("NVIDIA Announces Financial Results", "科技", "AI"),
    "股票",
  );
  assert.equal(
    focusFor("Weekly recipes", "生活", "Fruit and vegetables"),
    undefined,
  );
  const [material] = editorialRevision().evidence;
  assert.equal(
    uniqueMaterials([
      material!,
      {
        ...material!,
        itemId: "repost",
        url: material!.url + "?utm_source=x",
        contentHash: "b".repeat(64),
      },
    ]).length,
    1,
  );
  assert.equal(
    uniqueMaterials([
      material!,
      { ...material!, itemId: "mirror", url: "https://example.org/mirror" },
    ]).length,
    1,
  );
  assert.equal(
    uniqueMaterials([
      material!,
      {
        ...material!,
        itemId: "independent",
        url: "https://example.org/report",
        contentHash: "b".repeat(64),
      },
    ]).length,
    2,
  );
});

test("editorial model uses final structured output and excludes routing identity, secrets, and thoughts", async () => {
  const result = { pitches: [], skipReason: "材料尚不足以形成新的理解。" };
  const model = geminiEditorialModel(
    "private-key",
    "fixture",
    async (_url, request) => {
      const body = JSON.parse(String(request?.body));
      assert.equal(body.store, false);
      assert.equal(body.response_format.mime_type, "application/json");
      assert.doesNotMatch(body.input, /private-key|private-tenant-id/);
      assert.match(body.input, /共同|独立/);
      return Response.json({
        steps: [
          {
            type: "model_output",
            content: [
              { type: "thought", text: "private thought" },
              { type: "text", text: JSON.stringify(result) },
            ],
          },
        ],
      });
    },
  );
  assert.deepEqual(
    await model.select({
      focus: "AI",
      materials: editorialRevision().evidence,
      existing: [],
      ...{ tenantId: "private-tenant-id" },
    }),
    result,
  );
  await assert.rejects(
    geminiEditorialModel("key", "fixture", async () =>
      Response.json({ error: "secret provider body" }, { status: 500 }),
    ).select({ focus: "AI", materials: [], existing: [] }),
    (error) =>
      error instanceof Error && !error.message.includes("secret provider body"),
  );
});
