import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultMemberSettings,
  normalizeMemberSettings,
  normalizeTeamSettings,
  MEMBER_PROMPT_LIMIT,
} from "../src/shared/member-settings.js";

test("old or partial settings inherit independent member defaults without shared mutation", () => {
  const old = normalizeTeamSettings(undefined);
  assert.match(old.researcher.prompt, /证据核查/);
  assert.equal(old.coordinator.delegation, "auto");
  old.coordinator.prompt = "only this copy";
  assert.notEqual(
    defaultMemberSettings("coordinator").prompt,
    "only this copy",
  );
  const partial = normalizeTeamSettings({
    cto: { prompt: "只评估实现成本", delegation: "off" },
  });
  assert.equal(partial.cto.prompt, "只评估实现成本");
  assert.equal(partial.cto.delegation, "off");
  assert.equal(partial.cto.responseStyle, "concise");
  assert.match(partial.researcher.prompt, /研究员/);
});
test("member settings normalize malformed values and bound custom prompt length", () => {
  assert.deepEqual(
    normalizeMemberSettings(
      { prompt: " ", responseStyle: "other", delegation: "ask" },
      "researcher",
    ),
    defaultMemberSettings("researcher"),
  );
  assert.equal(
    normalizeMemberSettings(
      {
        prompt: "a".repeat(MEMBER_PROMPT_LIMIT + 10),
        responseStyle: "detailed",
      },
      "cto",
    ).prompt.length,
    MEMBER_PROMPT_LIMIT,
  );
  assert.equal(normalizeTeamSettings([]).coordinator.responseStyle, "concise");
});
