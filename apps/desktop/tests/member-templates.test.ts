import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  instantiateMemberTemplate,
  listMemberTemplates,
  memberTemplateCatalog,
} from "../src/core/member-templates";
import { teamSchema } from "../src/core/configuration";

test("catalog exposes eight agency templates with provenance", () => {
  assert.equal(memberTemplateCatalog.length, 8);
  const listed = listMemberTemplates();
  assert.equal(listed.length, 8);
  for (const item of listed) {
    assert.match(item.provenance.source.commit, /^[a-f0-9]{40}$/);
    assert.equal(item.provenance.source.license, "MIT");
  }
});

test("instantiate copies instruction and keeps permissions empty", () => {
  const member = instantiateMemberTemplate("agency-code-reviewer", []);
  assert.equal(member.skillKeys?.length ?? 0, 0);
  assert.equal(member.toolKeys?.length ?? 0, 0);
  assert.ok(member.provenance?.templateId === "agency-code-reviewer");
  const team = teamSchema.parse({
    id: "editorial",
    version: 1,
    name: "测试",
    members: [member],
  });
  assert.equal(team.members[0].name, "代码审查");
});

test("member ids stay unique within twelve members", () => {
  const members: ReturnType<typeof instantiateMemberTemplate>[] = [];
  for (const t of memberTemplateCatalog) {
    members.push(instantiateMemberTemplate(t.id, members));
  }
  assert.equal(new Set(members.map((m) => m.id)).size, members.length);
});


test("catalog and provenance are immutable, each adapted instruction has a verified digest", () => {
  for (const t of memberTemplateCatalog) {
    assert.equal(t.instructionSha256, createHash("sha256").update(t.instruction).digest("hex"));
    assert.ok(Object.isFrozen(t.provenance.source));
    const first = instantiateMemberTemplate(t.id, []);
    first.provenance!.source.path = "edited";
    assert.notEqual(instantiateMemberTemplate(t.id, []).provenance!.source.path, "edited");
  }
});
