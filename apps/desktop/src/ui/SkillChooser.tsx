import type { Snapshot } from "../core/types";
import {
  skillAvailability,
  skillKey,
  isTrialMethod,
} from "../core/skill-contract";
export function SkillChooser({
  data,
  selected,
  onChange,
  limit = 4,
  member = false,
}: {
  data: Snapshot;
  selected: string[];
  onChange: (keys: string[]) => void;
  limit?: number;
  member?: boolean;
}) {
  return (
    <div className="skill-choices">
      <p className="muted">
        {member
          ? "内置方法默认可选。勾选其他方法供此成员按需加载，保存搭配后生效。"
          : "指定本轮使用的方法；未指定时，成员仍可从获准目录按需选择。"}
      </p>
      {data.skills
        .filter(
          (s) =>
            !member ||
            (s.source.kind !== "builtin" &&
              !isTrialMethod(s, data.skillAdoptions)),
        )
        .map((s) => {
          const key = skillKey(s),
            checked = selected.includes(key),
            state = skillAvailability(s, data.skillStates);
          return (
            <label key={key} className="skill-choice">
              <input
                type="checkbox"
                checked={checked}
                disabled={
                  !checked && (state !== "ready" || selected.length >= limit)
                }
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...selected, key]
                      : selected.filter((k) => k !== key),
                  )
                }
              />
              <span>
                <strong>{s.name}</strong>{" "}
                <small>
                  v{s.version}
                  {isTrialMethod(s, data.skillAdoptions) ? " · 试用草案" : ""}
                  {state === "disabled"
                    ? " · 已停用"
                    : state === "missing_dependency"
                      ? " · 缺少依赖"
                      : ""}
                </small>
                <span className="muted skill-description">{s.description}</span>
              </span>
            </label>
          );
        })}
      {selected
        .filter((key) => !data.skills.some((s) => skillKey(s) === key))
        .map((key) => (
          <label key={key} className="skill-choice">
            <input
              type="checkbox"
              checked
              onChange={() => onChange(selected.filter((k) => k !== key))}
            />
            <span>版本已不可用 · {key}</span>
          </label>
        ))}
      <small>
        {selected.length} / {limit}
      </small>
    </div>
  );
}
