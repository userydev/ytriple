import test from "node:test";
import assert from "node:assert/strict";
import {
  clampBounds,
  restoreLayout,
  defaultBounds,
} from "../src/desktop/window-layout.js";
import { parseCommand } from "../src/desktop/commands.js";

test("legacy native windows migrate to one large embedded workspace without losing task selection", () => {
  const area = { x: 0, y: 38, width: 1728, height: 1040 };
  const legacy = {
    mode: "single",
    taskId: "task-1",
    bounds: {
      main: { x: 8, y: 41, width: 886, height: 978 },
      evidence: { x: 902, y: 41, width: 818, height: 485 },
    },
    collapsed: { main: true, evidence: true, artifact: true },
  };
  const restored = restoreLayout(legacy, [area], area);
  assert.equal(restored.version, 2);
  assert.equal(restored.taskId, "task-1");
  assert.equal(restored.mode, "triple");
  assert.deepEqual(restored.bounds, defaultBounds(area));
  assert.ok(restored.bounds.width > legacy.bounds.main.width);
  assert.deepEqual(restored.ratios, { main: 0.52, evidence: 0.5 });
  assert.deepEqual(restored.collapsed, {
    main: false,
    evidence: false,
    artifact: false,
  });
});
test("embedded layout restores panel ratios and folds separately from native geometry", () => {
  const area = { x: -1920, y: 0, width: 1920, height: 1080 };
  const saved = {
    version: 2,
    mode: "triple",
    taskId: "task-2",
    bounds: { x: -1800, y: 80, width: 1500, height: 800 },
    ratios: { main: 0.4, evidence: 0.7 },
    collapsed: { main: true, evidence: false, artifact: true },
    expanded: null,
  };
  const restored = restoreLayout(saved, [area], area);
  assert.deepEqual(restored, saved);
  const newDisplay = { x: 0, y: 28, width: 1280, height: 740 };
  assert.deepEqual(
    restoreLayout(saved, [newDisplay], newDisplay).bounds,
    newDisplay,
  );
  assert.deepEqual(
    clampBounds({ x: 9999, y: 9999, width: 1100, height: 650 }, newDisplay),
    { x: 180, y: 118, width: 1100, height: 650 },
  );
});
test("malformed preferences cannot create invisible panels or move the app off screen", () => {
  const area = { x: 0, y: 28, width: 1280, height: 740 };
  const restored = restoreLayout(
    {
      version: 2,
      bounds: { ...area, width: NaN },
      ratios: { main: -100, evidence: Infinity },
      collapsed: { artifact: "yes" },
      expanded: "outside",
    },
    [area],
    area,
  );
  assert.deepEqual(restored.bounds, defaultBounds(area));
  assert.deepEqual(restored.ratios, { main: 0.2, evidence: 0.5 });
  assert.equal(restored.collapsed.artifact, false);
  assert.equal(restored.expanded, null);
  const expanded = restoreLayout(
    {
      version: 2,
      mode: "single",
      expanded: "artifact",
      collapsed: { artifact: true },
    },
    [area],
    area,
  );
  assert.equal(expanded.mode, "triple");
  assert.equal(expanded.collapsed.artifact, false);
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
  assert.throws(() =>
    parseCommand({ type: "window.resize", main: NaN, evidence: 0.5 }),
  );
  assert.throws(() =>
    parseCommand({ type: "window.resize", main: 0.52, evidence: 1.5 }),
  );
  assert.throws(() =>
    parseCommand({ type: "window.expand", window: "outside" }),
  );
  assert.deepEqual(parseCommand({ type: "window.expand", window: null }), {
    type: "window.expand",
    window: null,
  });
  const valid = {
    type: "library.collect",
    taskId: "t",
    artifactId: "a",
    expectedHash: "0".repeat(64),
    tags: ["阅读"],
  };
  assert.deepEqual(parseCommand({ ...valid, path: "/outside" }), valid);
});
