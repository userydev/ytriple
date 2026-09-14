import type { OutputPort } from "@ytriple/shared";
import { TOOL_NAMES } from "./toolNames.js";
import { readStringArg, toolFailure, type ToolDefinition, type ToolResult } from "./types.js";

export interface OutputToolOptions {
  output: OutputPort;
  taskId: string;
  /** Fixed by the output contract; passed in so the team definition owns it. */
  primaryDocument: "prd.md";
}

/**
 * The single write channel. The team validator keeps this tool off every
 * non-orchestrator allowlist, and `OutputPort` can only write into the task's
 * own output directory.
 */
export function createOutputTool(options: OutputToolOptions): ToolDefinition {
  return {
    name: TOOL_NAMES.createOutputDocument,
    description: `Write the task's single deliverable (${options.primaryDocument}). Cannot overwrite an existing file.`,
    parameters: {
      type: "object",
      required: ["content"],
      properties: {
        content: { type: "string", description: "Complete Markdown document" },
      },
    },
    async execute(args): Promise<ToolResult> {
      const content = readStringArg(args, "content");
      if (!content) return toolFailure(`${TOOL_NAMES.createOutputDocument} needs content`);

      try {
        const written = await options.output.writeDocument({
          taskId: options.taskId,
          filename: options.primaryDocument,
          content,
        });
        return {
          ok: true,
          summary: `wrote ${options.primaryDocument}`,
          detail: `Wrote ${written.path}`,
          data: { path: written.path },
        };
      } catch (error) {
        // Failing to materialise the deliverable is a blocking failure.
        return toolFailure(
          `could not write ${options.primaryDocument}`,
          `Writing ${options.primaryDocument} failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      }
    },
  };
}
