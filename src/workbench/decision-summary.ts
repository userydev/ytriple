import { fromMarkdown } from "mdast-util-from-markdown";
import { mathFromMarkdown } from "mdast-util-math";
import { math } from "micromark-extension-math";
import { normalizeMathDelimiters } from "../shared/markdown";

type Block = ReturnType<typeof fromMarkdown>["children"][number];
type TextNode = { type: string; value?: string; children?: TextNode[] };
const plainText = (node: TextNode): string =>
  node.value ?? node.children?.map(plainText).join("") ?? "";

/** Keep a meeting-sized report intact. Long reports retain complete decision sections. */
export function decisionExcerpt(content: string): {
  text: string;
  detailed: boolean;
} {
  const clean = content.trim();
  if (clean.length <= 2400) return { text: clean, detailed: false };
  const normalized = normalizeMathDelimiters(clean);
  const blocks = fromMarkdown(normalized, {
    extensions: [math()],
    mdastExtensions: [mathFromMarkdown()],
  }).children;
  const raw = (block: Block) =>
    normalized.slice(block.position!.start.offset, block.position!.end.offset);
  const readable = (block: Block) =>
    !["code", "html", "thematicBreak", "definition"].includes(block.type);
  const take = (items: Block[], budget: number): string => {
    const selected: string[] = [];
    let used = 0;
    for (const block of items) {
      if (!readable(block)) continue;
      const text = raw(block);
      // Never cut a sentence, list item, formula or link in half.
      if (used + text.length > budget) break;
      selected.push(text);
      used += text.length + 2;
    }
    return selected.length === 1 && /^#{1,6}\s/.test(selected[0])
      ? ""
      : selected.join("\n\n");
  };
  const sections = blocks.flatMap((block, index) => {
    if (block.type !== "heading") return [];
    const title = plainText(block).replace(/^\d+[.、)）\s]+/, "");
    const priority = /结论|摘要|汇报|建议|推荐|判断/.test(title)
      ? 0
      : /关键依据|主要依据|核心依据|关键发现|事实|现状/.test(title)
        ? 1
        : /取舍|分歧|风险|限制|不确定/.test(title)
          ? 2
          : /决策|拍板|待确认|需要.{0,8}(决定|确认)|下一步/.test(title)
            ? 3
            : -1;
    if (priority < 0) return [];
    let end = index + 1;
    while (end < blocks.length) {
      const next = blocks[end];
      if (next.type === "heading" && next.depth <= block.depth) break;
      end++;
    }
    return [{ index, end, priority, blocks: blocks.slice(index, end) }];
  });
  const selected = sections
    .map((section) => {
      const child = sections.find(
        (item) => item.index > section.index && item.index < section.end,
      );
      return {
        ...section,
        blocks: blocks.slice(section.index, child?.index ?? section.end),
      };
    })
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .slice(0, 6)
    .sort((a, b) => a.index - b.index);
  const report = selected
    .map((section) => take(section.blocks, 850))
    .filter(Boolean)
    .join("\n\n");
  const excerpt =
    report ||
    take(blocks, 2000) ||
    "这份汇报包含较长的正文，可在右侧阅读完整内容。";
  const definitions = blocks
    .filter((block) => block.type === "definition")
    .map(raw)
    .join("\n");
  return {
    text: definitions ? `${excerpt}\n\n${definitions}` : excerpt,
    detailed: true,
  };
}
