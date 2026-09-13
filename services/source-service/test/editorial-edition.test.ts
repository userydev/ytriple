import assert from "node:assert/strict";
import test from "node:test";
import {
  geminiEditionEditor,
  applyEditionReview,
  validateEdition,
} from "../src/editorial-edition.js";
import {
  editorialPresentation,
  editorialRevision,
} from "../../../tests/fixtures/editorial.js";

const revision = editorialRevision();
const entry = {
  issueId: revision.issueId,
  presentation: editorialPresentation(revision),
  reason: "澄清报价与完成任务成本之间的区别。",
};
const draft = { entries: [entry], note: "仅选择具有明确条件关系的议题。" };
const reviewed = {
  note: draft.note,
  entries: [
    {
      issueId: entry.issueId,
      headline: entry.presentation.headline,
      summary: entry.presentation.summary,
      reason: entry.reason,
      visual: {
        keep: true,
        title: entry.presentation.visual.title,
        conclusion: entry.presentation.visual.conclusion,
        items: entry.presentation.visual.items.map(
          ({ label, text }, index) => ({ index, label, text }),
        ),
      },
      boundary: entry.presentation.boundary.text,
      watch: entry.presentation.watch.text,
    },
  ],
};

test("source review may tighten copy but cannot invent or rewrite citation bindings", () => {
  assert.deepEqual(applyEditionReview(reviewed, draft, [revision]), draft);
  const reversed = structuredClone(reviewed);
  reversed.entries[0]!.visual.items.reverse();
  const result = applyEditionReview(reversed, draft, [revision]);
  assert.equal(
    result.entries[0]!.presentation.visual.items[0]!.quote,
    entry.presentation.visual.items[0]!.quote,
  );
  assert.equal(
    result.entries[0]!.presentation.visual.items[0]!.sectionIndex,
    0,
  );
  reversed.entries[0]!.visual.items[0]!.index = 3;
  assert.throws(() => applyEditionReview(reversed, draft, [revision]));
});

test("an edition selects exact unique revisions and keeps claim support intact", () => {
  assert.deepEqual(validateEdition(draft, [revision]), draft);
  assert.deepEqual(
    validateEdition({ entries: [], note: "本轮没有值得新增的理解。" }, [
      revision,
    ]).entries,
    [],
  );
  assert.throws(() =>
    validateEdition({ ...draft, entries: [entry, entry] }, [revision]),
  );
  assert.throws(() => validateEdition(draft, []));
  assert.throws(() =>
    validateEdition(
      {
        ...draft,
        entries: [
          {
            ...entry,
            presentation: {
              ...entry.presentation,
              revisionId: revision.issueId,
            },
          },
        ],
      },
      [revision],
    ),
  );
  assert.throws(() =>
    validateEdition(
      {
        ...draft,
        entries: [
          {
            ...entry,
            presentation: { ...entry.presentation, headline: "长".repeat(31) },
          },
        ],
      },
      [revision],
    ),
  );
  assert.throws(() =>
    validateEdition(
      {
        ...draft,
        entries: [
          {
            ...entry,
            presentation: {
              ...entry.presentation,
              boundary: {
                text: "已证实",
                quote: "不存在于原文中的虚构证据范围",
              },
            },
          },
        ],
      },
      [revision],
    ),
  );
});

test("editing reads source text and dates, repairs copy once, and sends no private routing data", async () => {
  let calls = 0;
  const editor = geminiEditionEditor(
    "private-key",
    "fixture",
    async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      assert.equal(body.store, false);
      assert.match(body.input, /确定性测试材料/);
      assert.doesNotMatch(body.input, /private-key|private-tenant/);
      if (calls === 1) assert.match(body.input, /刚才的版面未通过校验/);
      if (calls === 2) assert.match(body.input, /发布前复核/);
      calls++;
      return Response.json({
        output_text: JSON.stringify(
          calls === 1
            ? {
                ...draft,
                entries: [
                  {
                    ...entry,
                    presentation: {
                      ...entry.presentation,
                      headline: "长".repeat(31),
                    },
                  },
                ],
              }
            : calls === 3
              ? reviewed
              : draft,
        ),
      });
    },
  );
  assert.deepEqual(
    await editor([{ ...revision, ...{ tenantId: "private-tenant" } }]),
    draft,
  );
  assert.equal(calls, 3);
});
