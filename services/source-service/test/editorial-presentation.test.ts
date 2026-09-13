import assert from "node:assert/strict";
import test from "node:test";
import {
  geminiEditorialPresenter,
  validatePresentation,
} from "../src/editorial-presentation.js";
import {
  editorialPresentation,
  editorialRevision,
} from "../../../tests/fixtures/editorial.js";

test("presentation requires the exact revision and located support, including limitations", () => {
  const revision = editorialRevision();
  const value = editorialPresentation(revision);
  assert.deepEqual(validatePresentation(value, revision), value);
  assert.throws(() =>
    validatePresentation({ ...value, revisionId: revision.issueId }, revision),
  );
  assert.throws(() =>
    validatePresentation(
      {
        ...value,
        visual: {
          ...value.visual,
          items: [
            { ...value.visual.items[0]!, sectionIndex: 6 },
            value.visual.items[1]!,
          ],
        },
      },
      revision,
    ),
  );
  assert.throws(() =>
    validatePresentation(
      {
        ...value,
        boundary: { text: "已独立验证", quote: "这里是一条完全虚构的所谓引文" },
      },
      revision,
    ),
  );
  assert.throws(() =>
    validatePresentation(
      { ...value, visual: { ...value.visual, kind: "none" } },
      revision,
    ),
  );
});

test("visual editing receives published text, not credentials or private routing data", async () => {
  const revision = editorialRevision();
  const present = geminiEditorialPresenter(
    "private-key",
    "fixture",
    async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      assert.equal(body.store, false);
      assert.doesNotMatch(body.input, /private-key|private-tenant/);
      assert.match(body.input, /不是第二次事实研究/);
      return Response.json({
        output_text: JSON.stringify(editorialPresentation(revision)),
      });
    },
  );
  assert.deepEqual(
    await present({ ...revision, ...{ tenantId: "private-tenant" } }),
    editorialPresentation(revision),
  );
});
