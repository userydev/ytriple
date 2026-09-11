import test from "node:test";
import assert from "node:assert/strict";
import {
  clampBounds,
  restoreLayout,
  defaultBounds,
  setRightPaneMode,
  focusLayoutPane,
  setPanelLayout,
  layoutDesktopState,
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
  assert.deepEqual(restored, { ...saved, rightMode: "split" });
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

test("right-side mode persists without changing decision width, split ratio, task or native bounds", () => {
  const area = { x: 0, y: 28, width: 1440, height: 900 };
  const layout = restoreLayout(
    {
      version: 2,
      taskId: "persisted-task",
      ratios: { main: 0.46, evidence: 0.4 },
      collapsed: { main: false, evidence: true, artifact: true },
    },
    [area],
    area,
  );
  const geometry = structuredClone(layout.bounds);
  for (const mode of ["evidence", "artifact", "split"] as const) {
    layout.expanded = "artifact";
    setRightPaneMode(layout, mode);
    assert.equal(layout.mode, "triple");
    assert.equal(layout.expanded, null);
    assert.equal(layout.taskId, "persisted-task");
    assert.deepEqual(layout.ratios, { main: 0.46, evidence: 0.4 });
    assert.deepEqual(layout.bounds, geometry);
    const restored = restoreLayout(
      JSON.parse(JSON.stringify(layout)),
      [area],
      area,
    );
    assert.equal(restored.rightMode, mode);
    assert.deepEqual(layoutDesktopState(restored, 7).open, {
      main: true,
      evidence: mode !== "artifact",
      artifact: mode !== "evidence",
    });
  }
  assert.deepEqual(layout.collapsed, {
    main: false,
    evidence: false,
    artifact: false,
  });
});
test("focusing a hidden right panel reveals it, while full-workspace expansion restores the saved right mode", () => {
  const area = { x: 0, y: 28, width: 1440, height: 900 };
  const layout = restoreLayout(
    {
      version: 2,
      rightMode: "artifact",
      ratios: { main: 0.44, evidence: 0.38 },
    },
    [area],
    area,
  );
  focusLayoutPane(layout, "evidence");
  assert.equal(layout.rightMode, "evidence");
  assert.deepEqual(layoutDesktopState(layout, 2).open, {
    main: true,
    evidence: true,
    artifact: false,
  });
  focusLayoutPane(layout, "main");
  assert.equal(layout.rightMode, "evidence");
  layout.expanded = "artifact";
  assert.deepEqual(layoutDesktopState(layout, 3).open, {
    main: false,
    evidence: false,
    artifact: true,
  });
  const resumed = restoreLayout(
    JSON.parse(JSON.stringify(layout)),
    [area],
    area,
  );
  assert.equal(resumed.rightMode, "evidence");
  resumed.expanded = null;
  assert.deepEqual(layoutDesktopState(resumed, 4).open, {
    main: true,
    evidence: true,
    artifact: false,
  });
  setPanelLayout(resumed, "single");
  assert.equal(resumed.rightMode, "evidence");
  focusLayoutPane(resumed, "artifact");
  assert.equal(resumed.mode, "triple");
  assert.equal(resumed.rightMode, "artifact");
  setPanelLayout(resumed, "triple", true);
  assert.equal(resumed.rightMode, "split");
  assert.deepEqual(resumed.ratios, { main: 0.52, evidence: 0.5 });
});
test("missing or invalid right modes use split and IPC only accepts the three supported modes", () => {
  const area = { x: 0, y: 28, width: 1440, height: 900 };
  for (const rightMode of [undefined, "native", "outside", null, 42])
    assert.equal(
      restoreLayout({ version: 2, rightMode }, [area], area).rightMode,
      "split",
    );
  for (const mode of ["split", "evidence", "artifact"])
    assert.deepEqual(parseCommand({ type: "window.rightMode", mode }), {
      type: "window.rightMode",
      mode,
    });
  assert.throws(() =>
    parseCommand({ type: "window.rightMode", mode: "outside" }),
  );
});
