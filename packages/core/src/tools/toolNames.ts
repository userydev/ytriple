export const TOOL_NAMES = {
  listWorkspaceFiles: "list_workspace_files",
  readWorkspaceFile: "read_workspace_file",
  searchWorkspaceText: "search_workspace_text",
  webSearch: "web_search",
  spawnSubAgent: "spawn_subagent",
  createOutputDocument: "create_output_document",
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

const KNOWN_TOOLS: ReadonlySet<string> = new Set<string>(Object.values(TOOL_NAMES));

export function isKnownTool(name: string): name is ToolName {
  return KNOWN_TOOLS.has(name);
}

export const WORKSPACE_TOOLS: readonly ToolName[] = [
  TOOL_NAMES.listWorkspaceFiles,
  TOOL_NAMES.readWorkspaceFile,
  TOOL_NAMES.searchWorkspaceText,
];
