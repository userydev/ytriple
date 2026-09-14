import {
  createDefaultTeam,
  createFakeClock,
  createFakeFsPort,
  createFakeOutputPort,
  createFakeSearchPort,
  createScriptedUserPort,
  createTaskRuntime,
  type TaskRunResult,
} from "@ytriple/core";
import type { RuntimeCapabilities, YtripleConfig } from "@ytriple/shared";
import { eventsOfType } from "@ytriple/shared";
import { describe, expect, it } from "vitest";
import { QUALITY_SAMPLES, REQUIRED_PRD_SECTIONS, type QualitySample } from "./samples.js";
import { createSyntheticAdapter } from "./syntheticModel.js";

/**
 * Phase 5, the part that can be checked without a live model.
 *
 * Every sample is a vague idea run end to end through the real runtime. What
 * is asserted is what the product promises regardless of which model is bound:
 * one complete, on-topic document, assumptions and open questions written down
 * rather than hidden, and the same guarantees when the model misbehaves or a
 * capability is missing.
 *
 * What this cannot check is whether a real model's prose is any good. That
 * needs keys and human reading; see the notes in the PR.
 */
const binding = { providerId: "synthetic", modelId: "synthetic" };

const config: YtripleConfig = {
  providers: [
    {
      providerId: "synthetic",
      adapterId: "openai_compatible",
      displayName: "Synthetic",
      baseUrl: "https://synthetic.invalid/v1",
      credentialRef: "SYNTHETIC",
      models: [{ modelId: "synthetic", displayName: "Synthetic" }],
    },
  ],
  defaultModel: binding,
};

async function runSample(sample: QualitySample): Promise<TaskRunResult> {
  const adapter = createSyntheticAdapter({
    topic: sample.topic,
    keywords: sample.keywords,
    defect: sample.defect,
    ...(sample.failingAgentId ? { failingAgentId: sample.failingAgentId } : {}),
  });

  const capabilities: RuntimeCapabilities = {
    workspaceRead: sample.withWorkspace === true,
    outputWrite: true,
    webSearch: sample.withoutWebSearch !== true,
    localModels: false,
    persistentBackgroundRuns: false,
    streaming: false,
  };

  const runtime = createTaskRuntime({
    taskId: sample.id,
    team: createDefaultTeam(binding),
    config,
    capabilities,
    ports: {
      output: createFakeOutputPort(),
      clock: createFakeClock(),
      user: createScriptedUserPort(() => "Whatever you think is most likely; note it as an assumption."),
      ...(sample.withWorkspace
        ? {
            fs: createFakeFsPort({
              files: { "README.md": "# Existing notes\nSome prior context about the idea." },
            }),
          }
        : {}),
      ...(sample.withoutWebSearch
        ? {}
        : {
            search: createFakeSearchPort([
              { title: "Reference article", url: "https://example.com/a", snippet: "background" },
            ]),
          }),
    },
    resolveBinding: async () => ({
      adapter,
      model: { modelId: "synthetic", displayName: "Synthetic" },
    }),
  });

  return runtime.run({ userInput: sample.input });
}

describe.each(QUALITY_SAMPLES)("sample: $id ($defect)", (sample) => {
  it("turns a vague idea into one complete document", async () => {
    const result = await runSample(sample);

    expect(result.status).toBe("completed");
    expect(result.prd).toBeDefined();

    const markdown = result.prd?.markdown ?? "";
    for (const section of REQUIRED_PRD_SECTIONS) {
      expect(markdown, `missing ${section}`).toContain(section);
    }

    // No section may be left as a placeholder.
    expect(markdown).not.toContain("_Not established in this run._");
  });

  it("writes a document that is about what the user asked for", async () => {
    const result = await runSample(sample);
    const markdown = result.prd?.markdown ?? "";

    for (const term of sample.mustMention) {
      expect(markdown, `document never mentions "${term}"`).toContain(term);
    }
  });

  it("writes the assumptions and open questions down rather than hiding them", async () => {
    const result = await runSample(sample);
    const markdown = result.prd?.markdown ?? "";
    const assumptionsBlock = markdown.slice(markdown.indexOf("## Assumptions and Open Questions"));

    expect(assumptionsBlock).toContain("**Assumptions**");
    expect(assumptionsBlock).toContain("**Open questions**");
    expect(assumptionsBlock.split("\n").filter((line) => line.startsWith("- ")).length).toBeGreaterThan(1);
  });

  it("publishes a brief that covers every dispatched member before dispatch", async () => {
    const result = await runSample(sample);

    const briefIndex = result.events.findIndex((event) => event.body.type === "task_brief_updated");
    const dispatched = eventsOfType(result.events, "agent_dispatched").map((body) => body.agentId);
    const firstDispatchIndex = result.events.findIndex(
      (event) => event.body.type === "agent_dispatched",
    );

    expect(briefIndex).toBeGreaterThanOrEqual(0);
    expect(firstDispatchIndex).toBeGreaterThan(briefIndex);
    for (const agentId of dispatched) {
      expect(result.brief?.memberTasks.map((task) => task.agentId)).toContain(agentId);
    }
  });

  it("produces exactly one user-facing file", async () => {
    const result = await runSample(sample);
    const artifacts = eventsOfType(result.events, "artifact_written");

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.filename).toBe("prd.md");
  });

  it("keeps raw member output out of the document body", async () => {
    const result = await runSample(sample);
    const markdown = result.prd?.markdown ?? "";

    for (const contribution of result.contributions) {
      expect(markdown).not.toContain(contribution.schemaId);
    }
    expect(markdown).not.toContain('"summary":');
    expect(markdown).not.toContain("proposed_sections");
  });
});

describe("the suite as a whole", () => {
  it("completes every sample", async () => {
    const results = await Promise.all(QUALITY_SAMPLES.map(runSample));
    const failures = results
      .map((result, index) => ({ id: QUALITY_SAMPLES[index]!.id, status: result.status }))
      .filter((entry) => entry.status !== "completed");

    expect(failures).toEqual([]);
  });

  it("still delivers when a member is blocked", async () => {
    const sample = QUALITY_SAMPLES.find((entry) => entry.defect === "member_failure")!;
    const result = await runSample(sample);

    expect(result.status).toBe("completed");
    expect(result.contributions.map((entry) => entry.agentId)).toEqual(["specialist"]);
    expect(eventsOfType(result.events, "error")).toMatchObject([{ agentId: "researcher" }]);
    expect(result.prd?.markdown).toContain("## Product Summary");
  });

  it("says so in the document when it had no way to check the web", async () => {
    const sample = QUALITY_SAMPLES.find((entry) => entry.withoutWebSearch)!;
    const result = await runSample(sample);

    expect(result.brief?.contextAvailability.webSearch).toBe(false);
    // No sources were available, so the document must not claim any.
    expect(result.prd?.markdown).not.toContain("## Source Notes");
    expect(result.status).toBe("completed");
  });

  it("cites sources when research actually had them", async () => {
    const sample = QUALITY_SAMPLES.find((entry) => entry.id === "prd-workbench-zh")!;
    const result = await runSample(sample);

    // The synthetic model never calls web_search, so no sources are claimed.
    // What matters is that the section appears only when sources exist.
    const hasSources = result.contributions.some((entry) => entry.sources.length > 0);
    expect(result.prd?.markdown.includes("## Source Notes")).toBe(hasSources);
  });

  it("recovers from a schema violation without losing the run", async () => {
    const sample = QUALITY_SAMPLES.find((entry) => entry.defect === "invalid_once")!;
    const result = await runSample(sample);

    const repairs = result.events.filter(
      (event) =>
        event.body.type === "degradation" &&
        event.body.degradation.kind === "structured_output",
    );
    expect(repairs.length).toBeGreaterThan(0);
    expect(result.status).toBe("completed");
    expect(result.contributions).toHaveLength(2);
  });
});
