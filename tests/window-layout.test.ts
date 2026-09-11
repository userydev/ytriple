import test from "node:test";
import assert from "node:assert/strict";
import {
  clampBounds,
  restoreLayout,
  tileWindows,
} from "../src/desktop/window-layout.js";
import { parseCommand } from "../src/desktop/commands.js";

test("three panes fit the visible display without overlaps, including a second display", () => {
  for (const area of [
    { x: 0, y: 38, width: 1440, height: 862 },
    { x: -1920, y: 0, width: 1920, height: 1080 },
  ]) {
    const panes = tileWindows(area);
    for (const p of Object.values(panes)) {
      assert.ok(p.x >= area.x && p.y >= area.y);
      assert.ok(p.x + p.width <= area.x + area.width);
      assert.ok(p.y + p.height <= area.y + area.height);
    }
    assert.ok(panes.main.x + panes.main.width < panes.evidence.x);
    assert.ok(panes.evidence.y + panes.evidence.height < panes.artifact.y);
    assert.equal(panes.evidence.width, panes.artifact.width);
    assert.ok(panes.main.width < area.width * 0.6);
  }
});
test("removed displays recover saved windows onto an available display and preserve folds", () => {
  const area = { x: 0, y: 28, width: 1280, height: 740 };
  const saved = {
    mode: "triple",
    taskId: "task-1",
    bounds: { main: { x: -1900, y: 0, width: 1800, height: 1080 } },
    collapsed: { main: true },
  };
  const restored = restoreLayout(saved, [area], area);
  assert.deepEqual(restored.bounds.main, area);
  assert.equal(restored.collapsed.main, true);
  assert.equal(restored.taskId, "task-1");
  assert.equal(
    restoreLayout(
      {
        bounds: { main: { ...area, width: NaN } },
        collapsed: { artifact: "yes" },
      },
      [area],
      area,
    ).collapsed.artifact,
    false,
  );
  assert.deepEqual(
    clampBounds({ x: 9999, y: 9999, width: 600, height: 400 }, area),
    { x: 680, y: 368, width: 600, height: 400 },
  );
});
test("new desktop and library IPC reject forged commands and require conflict tokens", () => {
  assert.deepEqual(parseCommand({ type: "window.select", taskId: null }), {
    type: "window.select",
    taskId: null,
  });
  assert.throws(() =>
    parseCommand({ type: "window.collapse", window: "other", collapsed: true }),
  );
  assert.throws(() =>
    parseCommand({ type: "library.collect", taskId: "t", artifactId: "a" }),
  );
  assert.throws(() =>
    parseCommand({
      type: "artifact.refine",
      taskId: "t",
      artifactId: "a",
      expectedHash: "0".repeat(64),
      instruction: "",
    }),
  );
  const valid = {
    type: "library.collect",
    taskId: "t",
    artifactId: "a",
    expectedHash: "0".repeat(64),
    tags: ["阅读"],
  };
  assert.deepEqual(parseCommand({ ...valid, path: "/outside" }), valid);
});
