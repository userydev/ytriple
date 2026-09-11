import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { importFile, fetchPublicText } from "../src/core/sources.js";
import { parseCommand } from "../src/desktop/commands.js";
test("本地资料导入取得真实文本，JSON 解析失败明确报错", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ytriple-import-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "input.md"), "# 研究\n本地事实");
  const source = await importFile(path.join(root, "input.md"));
  assert.equal(source.type, "file");
  assert.match(source.text, /本地事实/);
  await fs.writeFile(path.join(root, "broken.json"), "{broken");
  await assert.rejects(importFile(path.join(root, "broken.json")), /JSON/);
});
test("网页来源拒绝本机、IPv6 映射地址与其他协议", async () => {
  for (const url of [
    "http://127.0.0.1",
    "http://10.0.0.1",
    "http://[::1]",
    "http://[::ffff:127.0.0.1]",
    "file:///etc/passwd",
    "http://localhost",
    "http://100.64.0.1",
  ])
    await assert.rejects(fetchPublicText(url));
});
test("渲染进程不能发出内部导入命令；密钥字段不混入 profile", () => {
  assert.throws(() =>
    parseCommand({
      type: "source.import.paths",
      taskId: "x",
      paths: ["/etc/passwd"],
    }),
  );
  const command = parseCommand({
    type: "profile.save",
    profile: {
      id: "p",
      name: "P",
      provider: "compatible",
      protocol: "openai",
      baseURL: "",
      modelId: "",
      apiKeyEnv: "",
      hasKey: false,
      status: "untested",
      apiKey: "not-a-real-key",
    },
  });
  assert.equal("apiKey" in (command as { profile: object }).profile, false);
});
