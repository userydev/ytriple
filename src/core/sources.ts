import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import mammoth from "mammoth";
import { textSource } from "./files.js";
import type { Source } from "../shared/types.js";
const exec = promisify(execFile);
const MAX_BYTES = 20 * 1024 * 1024;

export async function importFile(filePath: string): Promise<Source> {
  if (!path.isAbsolute(filePath)) throw new Error("请选择有效的本地文件。");
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size > MAX_BYTES)
    throw new Error("文件不可读或超过 20 MB，请拆分后导入。");
  const ext = path.extname(filePath).toLowerCase();
  let text: string;
  let coverage = "正文文本";
  if ([".md", ".txt", ".csv", ".json"].includes(ext)) {
    text = await fs.readFile(filePath, "utf8");
    if (ext === ".json") {
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        throw new Error("JSON 格式无效，请检查文件。");
      }
    }
  } else if (ext === ".docx") {
    const result = await mammoth.extractRawText({ path: filePath });
    text = result.value;
    coverage = "DOCX 文字提取；图片、版面与批注未包含";
  } else if (ext === ".pdf") {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loading = getDocument({
      data: new Uint8Array(await fs.readFile(filePath)),
      useSystemFonts: true,
    });
    const document = await loading.promise;
    try {
      if (document.numPages > 200)
        throw new Error("PDF 超过 200 页，请按章节拆分后导入。");
      const pages: string[] = [];
      for (let i = 1; i <= document.numPages; i++) {
        const page = await document.getPage(i);
        const content = await page.getTextContent();
        const lines = content.items
          .map((item) =>
            "str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : "",
          )
          .join("");
        pages.push(`## 第 ${i} 页\n${lines}`);
      }
      text = pages.join("\n\n");
      if (pages.every((p) => p.replace(/## 第 \d+ 页/g, "").trim().length < 3))
        throw new Error(
          "这份 PDF 没有可提取的文字，需要 OCR；当前不会假装已经读懂扫描内容。",
        );
      coverage = `PDF ${document.numPages} 页文字；图片、复杂版面与扫描文字未识别`;
    } finally {
      await loading.destroy();
    }
  } else if (ext === ".doc" && process.platform === "darwin") {
    const result = await exec(
      "/usr/bin/textutil",
      ["-convert", "txt", "-stdout", filePath],
      { timeout: 30000, maxBuffer: 2 * 1024 * 1024 },
    );
    text = result.stdout;
    coverage = "DOC 文字转换；图片与原排版未包含";
  } else
    throw new Error(
      "当前可导入 MD、TXT、JSON、CSV、PDF、DOCX，以及 macOS 的 DOC 文件。",
    );
  return {
    ...textSource(path.basename(filePath), text, "file", filePath),
    coverage,
  };
}
