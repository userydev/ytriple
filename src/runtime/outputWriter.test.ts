import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { DELIVERY_FILENAMES, createDeliveryPackage } from "./outputWriter";

describe("delivery package writer", () => {
  it("writes the fixed four-file PRD delivery package in a task directory", async () => {
    const outputRoot = join(tmpdir(), `ytriple-output-${crypto.randomUUID()}`);
    await mkdir(outputRoot, { recursive: true });

    const result = await createDeliveryPackage({
      outputRoot,
      taskId: "task-001",
      documents: {
        finalPrd: "# Final PRD",
        assumptions: "# Assumptions",
        researchNotes: "# Research",
        specialistReview: "# Review",
      },
    });

    expect(result.files.map((file) => file.filename)).toEqual(DELIVERY_FILENAMES);
    expect(result.artifactsDir.endsWith("ytriple-outputs/task-001")).toBe(true);
    await expect(readFile(join(result.artifactsDir, "01-final-prd.md"), "utf8")).resolves.toBe(
      "# Final PRD",
    );
  });

  it("does not overwrite an existing task output directory", async () => {
    const outputRoot = join(tmpdir(), `ytriple-output-${crypto.randomUUID()}`);
    await mkdir(join(outputRoot, "ytriple-outputs", "task-001"), { recursive: true });

    await expect(
      createDeliveryPackage({
        outputRoot,
        taskId: "task-001",
        documents: {
          finalPrd: "",
          assumptions: "",
          researchNotes: "",
          specialistReview: "",
        },
      }),
    ).rejects.toThrow(/already exists/i);
  });
});
