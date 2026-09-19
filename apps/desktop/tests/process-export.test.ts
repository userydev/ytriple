import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store";
import { ProcessRecords } from "../src/core/process";
import type { Contribution, SubmitInput } from "../src/core/types";
import { legacyFinish } from "./team-response";

const request = (extra: Partial<SubmitInput> = {}): SubmitInput => ({
  key: randomUUID(),
  context: "new",
  text: "导出测试",
  refs: [],
  recipient: null,
  projectId: null,
  ...extra,
});

test("export markdown matches frozen snapshot without mutating store", () => {
  const store = new Store(":memory:");
  store.initializeConfiguration();
  const run = store.submit(request());
  store.setRun(run.id, { status: "running" });
  const contribution: Contribution = {
    id: `${run.id}:0`,
    workId: run.workId,
    runId: run.id,
    memberId: "researcher",
    memberName: "研究员",
    objective: "测试",
    body: "公开分析正文",
    status: "succeeded",
    remoteId: null,
    error: null,
    createdAt: new Date().toISOString(),
  };
  store.put("contribution", contribution.id, contribution);
  legacyFinish(store, run.id, "成果", true);
  const records = new ProcessRecords(store);
  const md = records.exportMarkdown({
    workId: run.workId,
    mode: "summary",
    runId: run.id,
  });
  assert.ok(md.includes("公开分析正文"));
  assert.ok(md.startsWith("# 过程总结"));
  const prepared = records.prepare({
    workId: run.workId,
    mode: "summary",
    runId: run.id,
  });
  const frozen = store.material(prepared.refs.at(-1)!);
  assert.ok(frozen.body.includes("公开分析正文"));
  store.put("contribution", contribution.id, {
    ...contribution,
    body: "已变化",
  });
  const md2 = records.exportMarkdown({
    workId: run.workId,
    mode: "summary",
    runId: run.id,
  });
  assert.ok(md2.includes("已变化"));
  assert.ok(!frozen.body.includes("已变化"));
  store.close();
});
