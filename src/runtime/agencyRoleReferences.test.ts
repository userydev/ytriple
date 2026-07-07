import { describe, expect, it } from "vitest";
import { AGENCY_AGENT_DIVISIONS, AGENCY_AGENT_ROLES, AGENCY_AGENTS_SOURCE } from "./agencyAgentsCatalog";
import { AGENCY_ROLE_REFERENCES, roleReferenceForAgent } from "./agencyRoleReferences";

describe("agency role references", () => {
  it("imports agency-agents as a marked role-library catalog", () => {
    expect(AGENCY_AGENTS_SOURCE.repository).toBe("msitarzewski/agency-agents");
    expect(AGENCY_AGENTS_SOURCE.license).toBe("MIT");
    expect(AGENCY_AGENT_DIVISIONS.length).toBeGreaterThanOrEqual(17);
    expect(AGENCY_AGENT_ROLES.length).toBeGreaterThanOrEqual(200);
    expect(AGENCY_AGENT_ROLES.some((role) => role.path === "product/product-manager.md")).toBe(true);
    expect(AGENCY_AGENT_ROLES.some((role) => role.path === "product/product-trend-researcher.md")).toBe(true);
    expect(AGENCY_AGENT_ROLES.some((role) => role.path === "specialized/agents-orchestrator.md")).toBe(true);
  });

  it("keeps selected agency-agents roles inside the fixed yTriple tri-agent slots", () => {
    expect(AGENCY_ROLE_REFERENCES.map((role) => role.sourceSlug)).toEqual([
      "product/product-manager.md",
      "product/product-trend-researcher.md",
      "specialized/agents-orchestrator.md",
    ]);

    expect(roleReferenceForAgent("specialist")?.ytripleSlot).toBe("specialist");
    expect(roleReferenceForAgent("researcher")?.ytripleSlot).toBe("researcher");
    expect(roleReferenceForAgent("conductor")?.ytripleSlot).toBe("conductor");
  });
});
