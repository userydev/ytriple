import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
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

function isPrivate(address: string): boolean {
  const a = address.toLowerCase();
  if (!isIP(a)) return true;
  // Only native global-unicast IPv6; exclude transition/documentation ranges.
  if (a.includes(":"))
    return (
      !/^[23][0-9a-f]{3}:/.test(a) ||
      a.startsWith("2002:") ||
      /^2001:(?:0:|db8:|10:|20:)/.test(a)
    );
  const [first, second, third] = a.split(".").map(Number) as [
    number,
    number,
    number,
  ];
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && (second === 168 || second === 0)) ||
    (first === 198 &&
      (second === 18 || second === 19 || (second === 51 && third === 100))) ||
    (first === 203 && second === 0 && third === 113)
  );
}
export async function fetchPublicText(
  raw: string,
): Promise<{ url: string; text: string; contentType: string }> {
  let url = new URL(raw);
  for (let redirects = 0; redirects < 5; redirects++) {
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("请输入不带账号密码的 HTTP 或 HTTPS 链接。");
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (
      hostname === "localhost" ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".localhost")
    )
      throw new Error("链接导入只读取公开网络资料。");
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await lookup(hostname, { all: true });
    // HTTPS hostnames may resolve into a local TUN proxy's Fake-IP pool; TLS still verifies the public hostname.
    if (
      !addresses.length ||
      addresses.some(
        (a) =>
          isPrivate(a.address) &&
          !(
            url.protocol === "https:" &&
            !isIP(hostname) &&
            /^198\.(18|19)\./.test(a.address)
          ),
      )
    )
      throw new Error("链接指向本机或私人网络，不能作为公开来源导入。");
    const chosen = addresses[0]!;
    const result = await new Promise<{
      status: number;
      location?: string;
      contentType: string;
      text: string;
    }>((resolve, reject) => {
      const request = (url.protocol === "https:" ? https : http).get(
        url,
        {
          headers: {
            "User-Agent": "ytriple/0.1 (user-requested research)",
            Accept: "text/html,text/plain,application/json",
          },
          lookup: (_host, options, callback) => {
            if (typeof options === "object" && options.all)
              callback(null, [
                { address: chosen.address, family: chosen.family },
              ]);
            else callback(null, chosen.address, chosen.family);
          },
          timeout: 20000,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 3 * 1024 * 1024) {
              response.destroy();
              reject(new Error("网页过大，请导入正文文件或直接粘贴内容。"));
            } else chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              location: response.headers.location,
              contentType: response.headers["content-type"] ?? "",
              text: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      request.on("timeout", () =>
        request.destroy(new Error("来源读取超时，请稍后重试。")),
      );
      request.on("error", reject);
    });
    if (result.status >= 300 && result.status < 400 && result.location) {
      url = new URL(result.location, url);
      continue;
    }
    if (result.status < 200 || result.status >= 300)
      throw new Error(`来源返回 HTTP ${result.status}，尚未取得正文。`);
    return {
      url: url.href,
      text: result.text,
      contentType: result.contentType,
    };
  }
  throw new Error("来源跳转次数过多，请使用最终文章链接。");
}
export async function importURL(url: string): Promise<Source> {
  const result = await fetchPublicText(url);
  let title = new URL(result.url).hostname;
  let text = result.text;
  if (result.contentType.includes("html")) {
    const { document } = parseHTML(text);
    const article = new Readability(document as unknown as Document).parse();
    title = article?.title || document.title || title;
    text = article?.textContent || "";
    if (text.trim().length < 40)
      throw new Error(
        "没有取得可读正文，页面可能需要登录或动态加载。请导入文件或粘贴内容。",
      );
  } else if (!/text\/|application\/json/.test(result.contentType))
    throw new Error("这个链接不是可读取的文章，请下载文档后导入。");
  return {
    ...textSource(title, text, "url", result.url),
    coverage: "网页正文提取；未下载媒体、未读取登录内容",
  };
}
