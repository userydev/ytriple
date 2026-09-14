export const TOOL_NAMES = {
  listWorkspaceFiles: "list_workspace_files",
  readWorkspaceFile: "read_workspace_file",
  searchWorkspaceText: "search_workspace_text",
  webSearch: "web_search",
  spawnSubAgent: "spawn_subagent",
  createOutputDocument: "create_output_document",
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];
