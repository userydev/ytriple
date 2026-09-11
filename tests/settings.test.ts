import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import type { Command, Snapshot } from "../src/shared/types.js";
import {
  normalizeTeamSettings,
  defaultMemberSettings,
} from "../src/shared/member-settings.js";
import type { SettingsSection } from "../src/workbench/Settings.js";
import { parseCommand } from "../src/desktop/commands.js";

function fixture(): Snapshot {
  return {
    version: "test",
    dataPath: "/unused/db",
    tasks: [],
    projects: [],
    profiles: [
      {
        id: "gemini",
        name: "日常 Gemini",
        provider: "gemini",
        protocol: "google",
        execution: "model",
        modelId: "gemini-3.8-flash",
        baseURL: "https://generativelanguage.googleapis.com/v1beta",
        apiKeyEnv: "GOOGLE_API_KEY",
        hasKey: true,
        status: "ready",
      },
      {
        id: "deepseek",
        name: "DeepSeek",
        provider: "deepseek",
        protocol: "openai",
        modelId: "deepseek-chat",
        baseURL: "https://api.deepseek.com/v1",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        hasKey: false,
        status: "unconfigured",
      },
    ],
    settings: {
      aiRoot: "/unused/AI",
      codeRoot: "/unused/Code",
      workspaceRoot: "/unused/AI/knowledge/workspaces",
      defaultProfileId: "gemini",
      memberProfiles: {
        coordinator: "gemini",
        researcher: "gemini",
        cto: "deepseek",
      },
      memberSettings: normalizeTeamSettings(undefined),
      projectMonitoring: true,
    },
    system: {
      state: "ready",
      aiRoot: "/unused/AI",
      codeRoot: "/unused/Code",
      policyPath: "/unused/AI/system/POLICY.md",
      issues: [],
    },
  };
}
async function withSettings(
  run: (context: {
    document: Document;
    window: Window & typeof globalThis;
    commands: Command[];
    current: () => Snapshot;
    emit: (snapshot: Snapshot) => void;
    navigate: (section: SettingsSection) => void;
    act: typeof import("react").act;
  }) => Promise<void>,
  initial = fixture(),
  initialSection?: SettingsSection,
  initiallyLoaded = true,
) {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id='root'></div></body></html>",
  );
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window,
    document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
  const { act, createElement, useRef, useState, useCallback } =
    await import("react");
  const { createRoot } = await import("react-dom/client");
  const { Settings } = await import("../src/workbench/Settings.js");
  let current = initial;
  const commands: Command[] = [];
  let emit!: (value: Snapshot) => void;
  let navigate!: (value: SettingsSection) => void;
  function Harness() {
    const [snapshot, setSnapshot] = useState<Snapshot | null>(
      initiallyLoaded ? current : null,
    );
    const [section, setSection] = useState(initialSection);
    navigate = setSection;
    const ref = useRef(current);
    if (snapshot) ref.current = snapshot;
    emit = (value) => {
      current = value;
      ref.current = value;
      setSnapshot(value);
    };
    const dispatch = useCallback(async (command: Command) => {
      parseCommand(command);
      commands.push(structuredClone(command));
      let next = structuredClone(ref.current);
      if (command.type === "settings.save")
        next.settings = {
          ...command.settings,
          memberSettings: normalizeTeamSettings(
            command.settings.memberSettings,
          ),
        };
      if (command.type === "profile.save") {
        const profile = { ...command.profile, status: "untested" as const };
        const index = next.profiles.findIndex((item) => item.id === profile.id);
        if (index < 0) next.profiles.push(profile);
        else next.profiles[index] = profile;
      }
      current = next;
      ref.current = next;
      setSnapshot(next);
      return next;
    }, []);
    return createElement(Settings, {
      snapshot,
      dispatch,
      connected: true,
      section,
      onOpenModels:
        initialSection === undefined ? undefined : () => setSection("models"),
    });
  }
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(Harness)));
    await run({
      document: document as unknown as Document,
      window: window as unknown as Window & typeof globalThis,
      commands,
      current: () => current,
      emit: (value) => emit(value),
      navigate: (value) => navigate(value),
      act,
    });
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}
function click(
  window: Window & typeof globalThis,
  element: Element | null | undefined,
) {
  assert.ok(element);
  element.dispatchEvent(new window.Event("click", { bubbles: true }));
}
function select(
  window: Window & typeof globalThis,
  element: Element | null,
  value: string,
) {
  assert.ok(element);
  // Linkedom clears a selected sibling even when assigning `false`, so clear
  // first and select the requested option last, including nested optgroups.
  const options = Array.from(element.querySelectorAll("option"));
  for (const option of options) (option as HTMLOptionElement).selected = false;
  const chosen = options.find(
    (option) => option.getAttribute("value") === value,
  );
  assert.ok(chosen);
  (chosen as HTMLOptionElement).selected = true;
  element.dispatchEvent(new window.Event("change", { bubbles: true }));
}
function input(
  window: Window & typeof globalThis,
  element: Element | null,
  value: string,
) {
  assert.ok(element);
  (element as HTMLInputElement).value = value;
  element.dispatchEvent(new window.Event("input", { bubbles: true }));
}
function tab(document: Document, name: string) {
  return Array.from(document.querySelectorAll(".page-tabs button")).find(
    (button) => button.textContent === name,
  );
}
function field(
  document: Document,
  name: string,
  root = ".environment-settings",
) {
  return (
    Array.from(document.querySelectorAll(`${root} label.field`))
      .find((label) => label.textContent?.trim().startsWith(name))
      ?.querySelector("input,select,textarea") ?? null
  );
}

test("member inputs retain empty and trailing text, reset only the prompt, and save edited fields over the latest snapshot", async () => {
  await withSettings(
    async ({ document, window, commands, current, emit, act }) => {
      await act(async () => click(window, tab(document, "常驻成员")));
      const prompt = () =>
        document.querySelector<HTMLTextAreaElement>(
          '[aria-label="研究员的提示词"]',
        )!;
      await act(async () => input(window, prompt(), "保留尾部空格 \n\n"));
      assert.equal(prompt().value, "保留尾部空格 \n\n");
      await act(async () => input(window, prompt(), ""));
      assert.equal(
        prompt().value,
        "",
        "typing an empty prompt cannot immediately restore its default",
      );
      await act(async () =>
        select(
          window,
          document.querySelector('[aria-label="研究员的回答详略"]'),
          "detailed",
        ),
      );
      await act(async () =>
        select(
          window,
          document.querySelector('[aria-label="研究员的协作方式"]'),
          "off",
        ),
      );
      await act(async () =>
        select(
          window,
          document.querySelector('[aria-label="研究员使用的模型"]'),
          "deepseek",
        ),
      );
      const card = prompt().closest(".member-settings-card")!;
      await act(async () =>
        click(
          window,
          Array.from(card.querySelectorAll("button")).find(
            (button) => button.textContent === "恢复默认提示词",
          ),
        ),
      );
      assert.equal(
        prompt().value || prompt().defaultValue,
        defaultMemberSettings("researcher").prompt,
      );
      assert.equal(
        document.querySelector<HTMLSelectElement>(
          '[aria-label="研究员的回答详略"]',
        )!.value,
        "detailed",
      );
      assert.equal(
        document.querySelector<HTMLSelectElement>(
          '[aria-label="研究员的协作方式"]',
        )!.value,
        "off",
      );
      await act(async () => input(window, prompt(), "继续使用我写下的角色 \n"));
      const updated = structuredClone(current());
      updated.settings.codeRoot = "/new/Code";
      updated.settings.defaultProfileId = "deepseek";
      updated.settings.memberSettings!.coordinator.prompt =
        "另一项操作刚保存的统筹提示词";
      updated.settings.projectMonitoring = false;
      await act(async () => emit(updated));
      await act(async () => click(window, tab(document, "模型连接")));
      await act(async () => click(window, tab(document, "常驻成员")));
      assert.equal(
        prompt().value || prompt().defaultValue,
        "继续使用我写下的角色 \n",
        "switching categories retains the draft",
      );
      await act(async () =>
        click(
          window,
          document.querySelector(
            ".environment-settings > fieldset > .form-actions .primary",
          ),
        ),
      );
      const saved = commands.find(
        (command) => command.type === "settings.save",
      );
      assert.ok(saved && saved.type === "settings.save");
      assert.equal(
        saved.settings.memberSettings?.researcher.prompt,
        "继续使用我写下的角色 \n",
      );
      assert.equal(
        saved.settings.memberSettings?.researcher.responseStyle,
        "detailed",
      );
      assert.equal(saved.settings.memberSettings?.researcher.delegation, "off");
      assert.equal(saved.settings.memberProfiles.researcher, "deepseek");
      assert.equal(
        saved.settings.memberSettings?.coordinator.prompt,
        "另一项操作刚保存的统筹提示词",
      );
      assert.equal(saved.settings.defaultProfileId, "deepseek");
      assert.equal(saved.settings.codeRoot, "/new/Code");
      assert.equal(saved.settings.projectMonitoring, false);
    },
  );
});
test("environment bootstrap commits only changed directory fields and preserves newer member and directory settings", async () => {
  await withSettings(
    async ({ document, window, commands, current, emit, act }) => {
      await act(async () => click(window, tab(document, "本机环境")));
      await act(async () =>
        input(window, field(document, "AI 根目录"), "/chosen/AI"),
      );
      const updated = structuredClone(current());
      updated.settings.codeRoot = "/latest/Code";
      updated.settings.workspaceRoot = "/latest/workspaces";
      updated.settings.memberSettings!.researcher.prompt = "新的研究员角色";
      updated.settings.memberSettings!.researcher.delegation = "off";
      await act(async () => emit(updated));
      assert.equal(
        (field(document, "Code 根目录") as HTMLInputElement).value,
        "/latest/Code",
      );
      await act(async () =>
        click(
          window,
          Array.from(
            document.querySelectorAll(".environment-settings button"),
          ).find((button) => button.textContent?.includes("检查并补齐规则")),
        ),
      );
      const saved = commands[0];
      assert.equal(saved.type, "settings.save");
      if (saved.type !== "settings.save") return;
      assert.equal(saved.settings.aiRoot, "/chosen/AI");
      assert.equal(saved.settings.codeRoot, "/latest/Code");
      assert.equal(saved.settings.workspaceRoot, "/latest/workspaces");
      assert.equal(
        saved.settings.memberSettings?.researcher.prompt,
        "新的研究员角色",
      );
      assert.equal(saved.settings.memberSettings?.researcher.delegation, "off");
      assert.equal(commands[1].type, "system.bootstrap");
    },
  );
});
test("Google catalog creates an independent Agent connection without replacing the default Gemini or copying credentials", async () => {
  await withSettings(async ({ document, window, commands, current, act }) => {
    const original = structuredClone(current().profiles[0]);
    await act(async () =>
      select(
        window,
        document.querySelector('[aria-label="用于新连接的 Google 模型目录"]'),
        "deep-research-preview-04-2026",
      ),
    );
    assert.equal(
      (field(document, "模型 ID", ".profile-form") as HTMLInputElement).value,
      "gemini-3.8-flash",
    );
    await act(async () =>
      click(
        window,
        Array.from(
          document.querySelectorAll(".catalog-new-connection button"),
        ).find((button) => button.textContent?.includes("添加为新连接")),
      ),
    );
    assert.equal(
      (field(document, "模型 ID", ".profile-form") as HTMLInputElement).value,
      "deep-research-preview-04-2026",
    );
    assert.equal(
      document.querySelector<HTMLSelectElement>('[aria-label="执行方式"]')!
        .value,
      "google-agent",
    );
    assert.equal(
      (field(document, "密钥环境变量", ".profile-form") as HTMLInputElement)
        .value,
      "GOOGLE_API_KEY",
    );
    assert.equal(
      commands.length,
      0,
      "choosing and preparing a new profile must not save over an existing profile",
    );
    await act(async () =>
      document
        .querySelector(".profile-form")!
        .dispatchEvent(
          new window.Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    const saved = commands[0];
    assert.equal(saved.type, "profile.save");
    if (saved.type !== "profile.save") return;
    assert.notEqual(saved.profile.id, "gemini");
    assert.equal(saved.profile.execution, "google-agent");
    assert.equal(saved.profile.protocol, "google");
    assert.equal(saved.profile.hasKey, false);
    assert.ok(!("apiKey" in saved));
    assert.equal(current().settings.defaultProfileId, "gemini");
    assert.deepEqual(
      current().profiles.find((profile) => profile.id === "gemini"),
      original,
    );
    await act(async () =>
      select(
        window,
        document.querySelector('[aria-label="Google 模型目录"]'),
        "gemini-3.8-flash",
      ),
    );
    assert.equal(
      document.querySelector<HTMLSelectElement>('[aria-label="执行方式"]')!
        .value,
      "model",
    );
    await act(async () =>
      document
        .querySelector(".profile-form")!
        .dispatchEvent(
          new window.Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    const updated = commands[1];
    assert.equal(updated.type, "profile.save");
    if (updated.type === "profile.save") {
      assert.equal(updated.profile.id, saved.profile.id);
      assert.equal(updated.profile.execution, "model");
    }
    assert.deepEqual(
      current().profiles.find((profile) => profile.id === "gemini"),
      original,
    );
  });
});

test("an existing Google connection can save and verify with the default API address", async () => {
  const initial = fixture();
  initial.profiles[0].baseURL = "";
  await withSettings(async ({ document, window, commands, act }) => {
    const address = field(
      document,
      "API 地址",
      ".profile-form",
    ) as HTMLInputElement;
    assert.equal(address.value, "");
    assert.equal(address.hasAttribute("required"), false);
    assert.equal(
      address.placeholder,
      "https://generativelanguage.googleapis.com/v1beta",
    );
    const verify = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".profile-form button"),
    ).find((button) => button.textContent === "保存并验证");
    assert.ok(verify);
    assert.equal(verify.disabled, false);
    await act(async () => click(window, verify));
    assert.equal(commands[0].type, "profile.save");
    if (commands[0].type === "profile.save") {
      assert.equal(commands[0].profile.id, "gemini");
      assert.equal(commands[0].profile.baseURL, "");
      assert.ok(!("apiKey" in commands[0]));
    }
    assert.deepEqual(commands[1], {
      type: "profile.probe",
      profileId: "gemini",
    });
  }, initial);
});

test("dedicated settings pages keep model, team and environment drafts separate while navigation preserves them", async () => {
  await withSettings(
    async ({ document, window, commands, current, navigate, act }) => {
      assert.equal(document.querySelector(".page-tabs"), null);
      assert.equal(document.querySelector("h1")!.textContent, "多 Agent 团队");
      assert.ok(
        document
          .querySelector(".profile-form")!
          .closest(".settings-tab-hidden"),
      );
      assert.equal(
        document.querySelector(
          ".team-settings-section .default-model-settings",
        ),
        null,
      );
      assert.equal(
        document.querySelector(".team-settings-section input[type=password]"),
        null,
      );
      const prompt = () =>
        document.querySelector<HTMLTextAreaElement>(
          '[aria-label="研究员的提示词"]',
        )!;
      await act(async () => input(window, prompt(), "先核查来源，再总结。\n"));
      await act(async () =>
        click(window, document.querySelector(".team-model-reference button")),
      );
      assert.equal(document.querySelector("h1")!.textContent, "AI 模型");
      assert.equal(
        document
          .querySelector(".profile-form")!
          .closest(".settings-tab-hidden"),
        null,
      );
      assert.ok(
        document
          .querySelector(".environment-settings")!
          .closest(".settings-tab-hidden"),
      );
      await act(async () =>
        input(
          window,
          field(document, "连接名称", ".profile-form"),
          "尚未保存的模型名称",
        ),
      );
      await act(async () =>
        select(
          window,
          document.querySelector('[aria-label="工作台默认模型"]'),
          "deepseek",
        ),
      );
      await act(async () => navigate("environment"));
      assert.equal(document.querySelector("h1")!.textContent, "本机环境");
      await act(async () =>
        input(window, field(document, "AI 根目录"), "/draft/AI"),
      );
      await act(async () => navigate("team"));
      assert.equal(
        prompt().value || prompt().defaultValue,
        "先核查来源，再总结。\n",
      );
      await act(async () =>
        click(
          window,
          document.querySelector(
            ".environment-settings > fieldset > .form-actions .primary",
          ),
        ),
      );
      assert.equal(
        current().settings.memberSettings!.researcher.prompt,
        "先核查来源，再总结。",
      );
      assert.equal(
        current().settings.defaultProfileId,
        "gemini",
        "saving team settings must not commit the model default draft",
      );
      assert.equal(
        current().settings.aiRoot,
        "/unused/AI",
        "saving team settings must not commit the environment draft",
      );
      assert.equal(
        commands.filter((command) => command.type === "profile.save").length,
        0,
      );
      await act(async () => navigate("models"));
      assert.equal(
        (field(document, "连接名称", ".profile-form") as HTMLInputElement)
          .value,
        "尚未保存的模型名称",
      );
      assert.equal(
        document.querySelector<HTMLSelectElement>(
          '[aria-label="工作台默认模型"]',
        )!.value,
        "deepseek",
      );
      await act(async () =>
        click(window, document.querySelector(".default-model-actions button")),
      );
      assert.equal(current().settings.defaultProfileId, "deepseek");
      assert.equal(
        current().settings.memberSettings!.researcher.prompt,
        "先核查来源，再总结。",
      );
      assert.equal(current().settings.aiRoot, "/unused/AI");
      await act(async () => navigate("environment"));
      assert.equal(
        (field(document, "AI 根目录") as HTMLInputElement).value,
        "/draft/AI",
      );
      await act(async () =>
        click(
          window,
          document.querySelector(
            ".environment-settings > fieldset > .form-actions .primary",
          ),
        ),
      );
      assert.equal(current().settings.aiRoot, "/draft/AI");
      assert.equal(current().settings.defaultProfileId, "deepseek");
      assert.equal(
        current().settings.memberSettings!.researcher.prompt,
        "先核查来源，再总结。",
      );
    },
    fixture(),
    "team",
  );
});

test("settings mounted before the first snapshot selects an existing connection only once", async () => {
  await withSettings(
    async ({ document, window, current, emit, act }) => {
      assert.equal(document.querySelector(".profile-item.active"), null);
      await act(async () => emit(current()));
      assert.equal(
        (field(document, "连接名称", ".profile-form") as HTMLInputElement)
          .value,
        "日常 Gemini",
      );
      await act(async () =>
        click(window, document.querySelector(".add-profile")),
      );
      await act(async () =>
        input(
          window,
          field(document, "连接名称", ".profile-form"),
          "准备添加的连接",
        ),
      );
      await act(async () => emit(structuredClone(current())));
      assert.equal(
        (field(document, "连接名称", ".profile-form") as HTMLInputElement)
          .value,
        "准备添加的连接",
      );
      assert.equal(document.querySelector(".profile-item.active"), null);
    },
    fixture(),
    "models",
    false,
  );
});

test("an explicitly started new connection is preserved when the first snapshot arrives", async () => {
  await withSettings(
    async ({ document, window, current, emit, act }) => {
      await act(async () =>
        click(window, document.querySelector(".add-profile")),
      );
      await act(async () =>
        input(
          window,
          field(document, "连接名称", ".profile-form"),
          "我的新连接",
        ),
      );
      await act(async () => emit(current()));
      assert.equal(
        (field(document, "连接名称", ".profile-form") as HTMLInputElement)
          .value,
        "我的新连接",
      );
      assert.equal(document.querySelector(".profile-item.active"), null);
    },
    fixture(),
    "models",
    false,
  );
});
