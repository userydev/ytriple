import pptxgen from "pptxgenjs";
import { parseHTML } from "linkedom";
import type { Artifact } from "../shared/types.js";

export function plainArtifact(artifact: Artifact): string {
  if (!artifact.content) throw new Error("成果没有可导出的文字。");
  if (artifact.format === "html") {
    const { document } = parseHTML(artifact.content);
    document.querySelectorAll("script,style,iframe").forEach((n) => n.remove());
    return (
      document.body?.textContent || document.documentElement.textContent || ""
    );
  }
  return artifact.content;
}
export async function presentation(artifact: Artifact): Promise<Buffer> {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "ytriple";
  pptx.subject = artifact.title;
  pptx.title = artifact.title;
  pptx.theme = { headFontFace: "PingFang SC", bodyFontFace: "PingFang SC" };
  const paragraphs = plainArtifact(artifact)
    .replace(/```[^\n]*\n/g, "")
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const pages: string[][] = [];
  let page: string[] = [];
  let chars = 0;
  for (const paragraph of paragraphs) {
    for (let offset = 0; offset < paragraph.length; offset += 300) {
      const part = paragraph.slice(offset, offset + 300);
      if (
        page.length >= 7 ||
        chars + part.length > 650 ||
        (/^#{1,2} /.test(part) && page.length > 2)
      ) {
        pages.push(page);
        page = [];
        chars = 0;
      }
      page.push(part);
      chars += part.length;
    }
  }
  if (page.length) pages.push(page);
  for (const [i, lines] of pages.entries()) {
    const slide = pptx.addSlide();
    slide.background = { color: "F7F8F5" };
    const heading = lines[0]?.startsWith("#")
      ? lines.shift()!.replace(/^#+\s*/, "")
      : artifact.title;
    slide.addText(heading, {
      x: 0.65,
      y: 0.55,
      w: 12,
      h: 0.75,
      fontSize: 26,
      bold: true,
      color: "173E35",
      breakLine: false,
      margin: 0,
      fit: "shrink",
    });
    slide.addText(
      lines
        .map((p) => p.replace(/^#+\s*/, "").replace(/\*\*/g, ""))
        .join("\n\n"),
      {
        x: 0.7,
        y: 1.65,
        w: 11.9,
        h: 4.95,
        fontSize: 18,
        color: "27332E",
        margin: 0,
        valign: "top",
        fit: "shrink",
        breakLine: false,
      },
    );
    slide.addText(`ytriple · ${i + 1} / ${pages.length}`, {
      x: 0.7,
      y: 7.05,
      w: 10,
      h: 0.2,
      fontSize: 9,
      color: "6B7D73",
      margin: 0,
    });
  }
  return Buffer.from(
    (await pptx.write({ outputType: "nodebuffer" })) as Buffer,
  );
}
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function imageDocument(artifact: Artifact): string {
  const csp =
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; script-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
  if (artifact.format === "html" && artifact.content) {
    const { document } = parseHTML(artifact.content);
    document
      .querySelectorAll(
        "script,iframe,object,embed,link,base,meta,form,audio,video",
      )
      .forEach((n) => n.remove());
    for (const el of document.querySelectorAll("*"))
      for (const attr of [...el.attributes])
        if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><style>body{margin:0;overflow:hidden}*{box-sizing:border-box}</style></head><body>${document.head?.innerHTML || ""}${document.body?.innerHTML || document.documentElement.innerHTML}</body></html>`;
  }
  const lines = plainArtifact(artifact)
    .split(/\n+/)
    .filter((p) => p.trim());
  if (
    lines[0]?.startsWith("#") &&
    lines[0].replace(/^#+\s*/, "").replace(/\s/g, "") ===
      artifact.title.replace(/\s/g, "")
  )
    lines.shift();
  const blocks = lines
    .map((p) =>
      /^#{1,3} /.test(p)
        ? `<h2>${escape(p.replace(/^#+\s*/, ""))}</h2>`
        : `<p>${escape(p.replace(/\*\*/g, ""))}</p>`,
    )
    .join("");
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><style>*{box-sizing:border-box}body{margin:0;padding:64px;background:#f3f6f1;color:#233d32;font:24px/1.6 'PingFang SC',sans-serif}header{font-size:16px;letter-spacing:3px;color:#61836e}h1{font-size:48px;line-height:1.25;margin:24px 0 40px}main{columns:2;column-gap:44px}h2{font-size:28px;break-after:avoid;margin:26px 0 14px;border-top:2px solid #cad8cb;padding-top:18px}p{font-size:22px;margin:0 0 18px;overflow-wrap:anywhere}footer{font-size:14px;color:#7d8d80;margin-top:36px}</style></head><body><header>YTRIPLE / WORKING NOTES</header><h1>${escape(artifact.title)}</h1><main>${blocks}</main><footer>由当前成果生成 · 文档版本 ${artifact.version}</footer></body></html>`;
}
