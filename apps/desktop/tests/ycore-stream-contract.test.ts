import { test } from "node:test";
import assert from "node:assert/strict";
import { teamResponseOutputSchema } from "../src/core/team-response";
import {
  buildManagedStreamRequestBody,
  YCORE_STREAM_SUPPORTS_OUTPUT_SCHEMA,
} from "../src/core/ycore";
import type { Prompt } from "../src/core/ycore";

test("managed stream body omits output_schema while ycore rejects stream+schema", () => {
  assert.equal(YCORE_STREAM_SUPPORTS_OUTPUT_SCHEMA, false);
  const prompt: Prompt = {
    taskId: "task-1",
    refs: [],
    messages: [{ role: "user", content: "hi" }],
    outputSchema: teamResponseOutputSchema(),
  };
  const body = buildManagedStreamRequestBody(prompt);
  assert.equal("output_schema" in body, false);
  assert.equal(body.mode, "stream");
});

test("buildManagedStreamRequestBody would attach schema only when supported", () => {
  const prompt: Prompt = {
    taskId: "task-2",
    refs: [],
    messages: [{ role: "user", content: "hi" }],
    outputSchema: { type: "object" },
  };
  const body = buildManagedStreamRequestBody(prompt);
  if (!YCORE_STREAM_SUPPORTS_OUTPUT_SCHEMA) {
    assert.equal(JSON.stringify(body).includes("output_schema"), false);
    return;
  }
  assert.ok("output_schema" in body);
});
