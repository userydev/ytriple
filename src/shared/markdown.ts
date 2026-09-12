import { fromMarkdown } from "mdast-util-from-markdown";

/** Accept common model TeX delimiters while leaving code and existing dollar math intact. */
export function normalizeMathDelimiters(markdown: string): string {
  if (!markdown.includes("\\(") && !markdown.includes("\\[")) return markdown;
  const protectedRanges = new Map<number, number>();
  const protect = (
    node:
      | ReturnType<typeof fromMarkdown>
      | ReturnType<typeof fromMarkdown>["children"][number],
  ) => {
    if (
      ["code", "inlineCode", "html", "link", "image", "definition"].includes(
        node.type,
      )
    ) {
      const start = node.position?.start.offset,
        end = node.position?.end.offset;
      if (start !== undefined && end !== undefined)
        protectedRanges.set(start, end);
      return;
    }
    if ("children" in node) node.children.forEach(protect);
  };
  protect(fromMarkdown(markdown));
  let output = "";
  let index = 0;
  let fence: { marker: string; length: number } | undefined;
  while (index < markdown.length) {
    const protectedEnd = protectedRanges.get(index);
    if (protectedEnd !== undefined) {
      output += markdown.slice(index, protectedEnd);
      index = protectedEnd;
      continue;
    }
    const lineStart = index === 0 || markdown[index - 1] === "\n";
    if (lineStart) {
      const end = markdown.indexOf("\n", index);
      const line = markdown.slice(index, end < 0 ? markdown.length : end + 1);
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence || marker || /^( {4}|\t)/.test(line)) {
        if (fence) {
          if (
            marker &&
            marker[1][0] === fence.marker &&
            marker[1].length >= fence.length &&
            !line.slice(marker[0].length).trim()
          )
            fence = undefined;
        } else if (marker)
          fence = { marker: marker[1][0], length: marker[1].length };
        output += line;
        index += line.length;
        continue;
      }
    }
    if (markdown[index] === "`") {
      const delimiter = /^`+/.exec(markdown.slice(index))![0];
      let end = markdown.indexOf(delimiter, index + delimiter.length);
      while (
        end >= 0 &&
        (markdown[end - 1] === "`" || markdown[end + delimiter.length] === "`")
      )
        end = markdown.indexOf(delimiter, end + delimiter.length);
      if (end >= 0) {
        output += markdown.slice(index, end + delimiter.length);
        index = end + delimiter.length;
        continue;
      }
    }
    if (markdown[index] === "$" && markdown[index - 1] !== "\\") {
      const delimiter = markdown[index + 1] === "$" ? "$$" : "$";
      let end = markdown.indexOf(delimiter, index + delimiter.length);
      while (end >= 0 && markdown[end - 1] === "\\")
        end = markdown.indexOf(delimiter, end + delimiter.length);
      if (end >= 0) {
        output += markdown.slice(index, end + delimiter.length);
        index = end + delimiter.length;
        continue;
      }
    }
    if (markdown[index] === "\\") {
      const opening = markdown[index + 1];
      if (opening === "(" || opening === "[") {
        const closing = opening === "(" ? "\\)" : "\\]";
        const end = markdown.indexOf(closing, index + 2);
        const body = end < 0 ? "" : markdown.slice(index + 2, end);
        if (
          end >= 0 &&
          body.trim() &&
          !body.includes("`") &&
          !body.includes("$") &&
          !/\n\s*\n/.test(body) &&
          (opening === "[" || !body.includes("\n"))
        ) {
          output +=
            opening === "[" ? `\n$$\n${body.trim()}\n$$\n` : `$${body}$`;
          index = end + 2;
          continue;
        }
      }
      // An escaped backslash cannot open a math expression.
      output += markdown.slice(index, index + 2);
      index += 2;
      continue;
    }
    output += markdown[index++];
  }
  return output;
}

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hProperties?: Record<string, unknown> };
};
/** A plain br is safe document formatting; other HTML remains inert. */
export function remarkSafeLineBreaks() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (node.type === "html" && /^<br\s*\/?\s*>$/i.test(node.value ?? "")) {
        node.type = "break";
        delete node.value;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
/** Stable local heading IDs allow document navigation without touching the app URL. */
export function remarkHeadingIds() {
  return (tree: MarkdownNode) => {
    const counts = new Map<string, number>();
    const content = (node: MarkdownNode): string =>
      node.value ?? node.children?.map(content).join("") ?? "";
    const visit = (node: MarkdownNode) => {
      if (node.type === "heading") {
        const slug =
          content(node)
            .toLowerCase()
            .trim()
            .replace(/[^\p{L}\p{N}\s_-]/gu, "")
            .replace(/\s+/g, "-") || "section";
        const count = counts.get(slug) ?? 0;
        counts.set(slug, count + 1);
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            id: count ? `${slug}-${count}` : slug,
          },
        };
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
