import type {
  SkillCatalogEntry,
  SkillDefinition,
  SkillPolicy,
} from "../shared/skills.js";
import type { Task } from "../shared/types.js";
import type { Store } from "./store.js";
import { validateSkillBindings } from "./skills.js";
import { managedSkillCatalog } from "./skill-library.js";

const CONFIG_KEY = "skills.enabled";
export const MAX_AUTO_SKILLS = 32;
function relevance(skill: SkillCatalogEntry, task: Task): number {
  const goal = (task.goal ?? "").toLowerCase();
  const terms =
    `${skill.name} ${skill.description}`
      .toLowerCase()
      .match(/[a-z0-9]{3,}|[\u4e00-\u9fff]{2}/g) ?? [];
  return [...new Set(terms)].reduce(
    (score, term) => score + (goal.includes(term) ? term.length : 0),
    0,
  );
}

export function skillCatalog(store: Store): SkillCatalogEntry[] {
  const enabled = store.config<Record<string, boolean>>(CONFIG_KEY, () => ({}));
  return managedSkillCatalog(store).map((skill) => ({
    ...skill,
    enabled: enabled?.[skill.id] ?? skill.enabled,
  }));
}

export function setSkillEnabled(
  store: Store,
  id: string,
  enabled: boolean,
): void {
  if (!managedSkillCatalog(store).some((skill) => skill.id === id))
    throw new Error("找不到这个 Skill，请重新打开资产目录。");
  if (typeof enabled !== "boolean") throw new Error("Skill 启用状态无效。");
  store.setConfig(CONFIG_KEY, {
    ...store.config<Record<string, boolean>>(CONFIG_KEY, () => ({})),
    [id]: enabled,
  });
}

export function validateSkillPolicy(
  input: SkillPolicy | undefined,
): SkillPolicy {
  const policy = input ?? { mode: "auto", skillIds: [] };
  if (
    !["auto", "explicit", "off"].includes(policy.mode) ||
    !Array.isArray(policy.skillIds) ||
    policy.skillIds.length > 3 ||
    new Set(policy.skillIds).size !== policy.skillIds.length ||
    policy.skillIds.some(
      (id) => typeof id !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(id),
    ) ||
    (policy.mode === "explicit"
      ? policy.skillIds.length === 0
      : policy.skillIds.length !== 0)
  )
    throw new Error(
      "请选择有效的 Skill：指定模式需要选择 1–3 项，自动或不用模式不附带指定项。",
    );
  return structuredClone(policy);
}

/** Pin method content, never execution authority, at the next run boundary. */
export function bindTaskSkills(store: Store, task: Task): SkillDefinition[] {
  const policy = validateSkillPolicy(
    task.skillPolicy ??
      (task.surface === "background"
        ? { mode: "off", skillIds: [] }
        : undefined),
  );
  if (policy.mode === "off") return [];
  const pins = validateSkillBindings(task.skillPins ?? task.skillBindings);
  const catalog = skillCatalog(store);
  const selected =
    policy.mode === "explicit"
      ? policy.skillIds.map((id) => {
          const skill = catalog.find((candidate) => candidate.id === id);
          if (!skill)
            throw new Error("请选择有效的 Skill，目录中找不到指定方法。");
          if (!skill.enabled)
            throw new Error(
              `「${skill.name}」已停用，请在当前工作中改选方法或重新启用。`,
            );
          if (skill.availability === "missing-dependencies")
            throw new Error(
              `「${skill.name}」依赖尚未确认可用，请先在资产中核对实际条件。`,
            );
          if (skill.allowedMembers?.length === 0)
            throw new Error(`「${skill.name}」尚未允许任何成员使用。`);
          return skill;
        })
      : catalog
          .filter(
            (skill) =>
              skill.enabled &&
              skill.availability !== "missing-dependencies" &&
              skill.allowedMembers?.length !== 0,
          )
          .sort((left, right) => relevance(right, task) - relevance(left, task))
          .slice(0, MAX_AUTO_SKILLS);
  const bindings = selected.map((skill) => {
    const previous = pins.find((binding) => binding.id === skill.id);
    if (previous) return structuredClone(previous);
    const {
      enabled: _enabled,
      validation: _validation,
      revision: _revision,
      versions: _versions,
      feedback: _feedback,
      availability: _availability,
      editable: _editable,
      ...definition
    } = skill;
    return definition;
  });
  validateSkillBindings(bindings);
  return bindings;
}

/** Keep pinned history when the effective run set changes or becomes empty. */
export function mergeTaskSkillPins(
  task: Task,
  bindings: SkillDefinition[],
): SkillDefinition[] {
  const pins = validateSkillBindings(task.skillPins ?? task.skillBindings);
  for (const binding of validateSkillBindings(bindings)) {
    if (!pins.some((pin) => pin.id === binding.id)) pins.push(binding);
  }
  return structuredClone(pins);
}
