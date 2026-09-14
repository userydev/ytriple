/**
 * Just enough Markdown for the `prd.md` preview.
 *
 * A dependency would bring a sanitiser question with it; the generated document
 * only ever uses headings, lists, bold, links and paragraphs, so this handles
 * exactly those and escapes everything else.
 */
export type MarkdownBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "bullets"; items: string[] }
  | { kind: "numbered"; items: string[] }
  | { kind: "paragraph"; text: string };

export function parseMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = source.split("\n");

  let bullets: string[] = [];
  let numbered: string[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (bullets.length > 0) {
      blocks.push({ kind: "bullets", items: bullets });
      bullets = [];
    }
    if (numbered.length > 0) {
      blocks.push({ kind: "numbered", items: numbered });
      numbered = [];
    }
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      flush();
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flush();
      blocks.push({
        kind: "heading",
        level: heading[1]!.length as 1 | 2 | 3,
        text: heading[2]!,
      });
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      if (numbered.length > 0 || paragraph.length > 0) flush();
      bullets.push(bullet[1]!);
      continue;
    }

    const numberedItem = /^\d+\.\s+(.*)$/.exec(trimmed);
    if (numberedItem) {
      if (bullets.length > 0 || paragraph.length > 0) flush();
      numbered.push(numberedItem[1]!);
      continue;
    }

    if (bullets.length > 0 || numbered.length > 0) flush();
    paragraph.push(trimmed);
  }

  flush();
  return blocks;
}

export type InlineSpan =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "link"; text: string; href: string };

const INLINE_PATTERN = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function parseInline(source: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let lastIndex = 0;

  for (const match of source.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      spans.push({ kind: "text", text: source.slice(lastIndex, index) });
    }
    if (match[1] !== undefined) {
      spans.push({ kind: "strong", text: match[1] });
    } else if (match[2] !== undefined && match[3] !== undefined) {
      spans.push({ kind: "link", text: match[2], href: match[3] });
    }
    lastIndex = index + match[0].length;
  }

  if (lastIndex < source.length) {
    spans.push({ kind: "text", text: source.slice(lastIndex) });
  }
  return spans;
}
