import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { DELIVERY_FILENAMES, createDeliveryPackage } from "./outputWriter";

describe("delivery package writer", () => {
  it("writes a single prd.md deliverable in a task directory", async () => {
    const outputRoot = join(tmpdir(), `ytriple-output-${crypto.randomUUID()}`);
    await mkdir(outputRoot, { recursive: true });

    const result = await createDeliveryPackage({
      outputRoot,
      taskId: "task-001",
      documents: {
        prd: "# Final PRD",
      },
    });

    expect(result.files.map((file) => file.filename)).toEqual(DELIVERY_FILENAMES);
    expect(result.artifactsDir.endsWith("ytriple-outputs/task-001")).toBe(true);
    await expect(readFile(join(result.artifactsDir, "prd.md"), "utf8")).resolves.toBe("# Final PRD");
  });

  it("does not overwrite an existing task output directory", async () => {
    const outputRoot = join(tmpdir(), `ytriple-output-${crypto.randomUUID()}`);
    await mkdir(join(outputRoot, "ytriple-outputs", "task-001"), { recursive: true });

    await expect(
      createDeliveryPackage({
        outputRoot,
        taskId: "task-001",
        documents: {
          prd: "",
        },
      }),
    ).rejects.toThrow(/already exists/i);
  });
});
