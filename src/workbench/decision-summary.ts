/** A display excerpt of the original answer; full text remains available in results. */
export function decisionExcerpt(content: string): {
  text: string;
  detailed: boolean;
} {
  const clean = content.trim();
  if (clean.length <= 380 && clean.split("\n").length <= 9)
    return { text: clean, detailed: false };
  const sections = clean.split(/\n(?=#{1,4}\s)/);
  const conclusion = sections.find((section) =>
    /^#{1,4}\s*(?:\d+[.、]\s*)?(?:结论|核心结论|总结|建议|我的判断|最终判断|回答)/.test(
      section,
    ),
  );
  const body = (conclusion ?? clean).replace(/^#{1,4}[^\n]*\n/, "").trim();
  const first =
    body
      .split(/\n\s*\n/)
      .find((block) => block.trim() && !/^```|^\$\$|^\|/.test(block.trim())) ??
    "";
  const lines = first.split("\n").slice(0, 4).join("\n");
  const excerpt =
    lines.length <= 320
      ? lines
      : lines.slice(0, 320).replace(/[^。！？.!?\n]*$/, "");
  return {
    text: excerpt.trim() || "已形成详细分析，可以在右侧查看完整内容。",
    detailed: true,
  };
}
