import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser, parseHTML } from "linkedom";
import { importFile } from "../src/core/sources.js";
import { presentation, imageDocument } from "../src/core/exports.js";
import type { Artifact } from "../src/shared/types.js";

async function fixture(t: { after(fn: () => unknown): void }): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ytriple-formats-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

// Minimal ISO PDF structure with exact byte offsets: real font/page/content objects, not a parser mock.
function standardPDF(pageTexts: string[]): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [" +
      pageTexts.map((_, i) => 4 + i * 2 + " 0 R").join(" ") +
      "] /Count " +
      pageTexts.length +
      " >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [i, text] of pageTexts.entries()) {
    const contentId = 5 + i * 2;
    objects.push(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents " +
        contentId +
        " 0 R >>",
    );
    const content = text
      ? "BT /F1 14 Tf 72 720 Td (" +
        text.replace(/[\\()]/g, "\\$&") +
        ") Tj ET\n"
      : "q 1 1 1 rg 0 0 200 200 re f Q\n";
    objects.push(
      "<< /Length " +
        Buffer.byteLength(content, "ascii") +
        " >>\nstream\n" +
        content +
        "endstream",
    );
  }
  let pdf = "%PDF-1.4\n% Synthetic format verification\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += index + 1 + " 0 obj\n" + object + "\nendobj\n";
  });
  const xref = Buffer.byteLength(pdf, "ascii");
  pdf += "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n";
  pdf += offsets
    .slice(1)
    .map((offset) => String(offset).padStart(10, "0") + " 00000 n \n")
    .join("");
  pdf +=
    "trailer\n<< /Size " +
    (objects.length + 1) +
    " /Root 1 0 R >>\nstartxref\n" +
    xref +
    "\n%%EOF\n";
  return Buffer.from(pdf, "ascii");
}

async function standardDOCX(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>YTRIPLE_DOCX_842</w:t></w:r></w:p><w:p><w:r><w:t>中文需求：首版工作台 &amp; 文档处理</w:t></w:r></w:p><w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="5000"/></w:tblGrid><w:tr><w:tc><w:tcPr/><w:p><w:r><w:t>表格证据 TABLE_27182</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>',
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function artifact(content: string, format: "md" | "html" = "md"): Artifact {
  return {
    id: "format-fixture",
    title: "格式验证成果",
    path: "/synthetic/not-read.md",
    format,
    version: 1,
    hash: "synthetic-not-used",
    goalVersion: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    versions: [],
    content,
  };
}

test("TXT and JSON imports retain real UTF-8 text, structured values and source provenance", async (t) => {
  const root = await fixture(t);
  const textPath = path.join(root, "notes.txt");
  const text = "中文工作资料\nTXT_SENTINEL_31415\n保留用户提供的内容。";
  await fs.writeFile(textPath, text);
  const plain = await importFile(textPath);
  assert.equal(plain.text, text);
  assert.equal(plain.location, textPath);
  assert.equal(plain.type, "file");
  const jsonPath = path.join(root, "evidence.json"),
    data = {
      title: "研究依据",
      count: 42,
      items: ["JSON_SENTINEL_27182", { confirmed: true }],
    };
  await fs.writeFile(jsonPath, JSON.stringify(data));
  const structured = await importFile(jsonPath);
  assert.deepEqual(JSON.parse(structured.text), data);
  assert.match(structured.text, /\n  "title"/);
  assert.equal(structured.location, jsonPath);
  const invalid = path.join(root, "invalid.json");
  await fs.writeFile(invalid, '{"unfinished":');
  await assert.rejects(importFile(invalid), /JSON 格式无效/);
});

test("standard two-page PDF is actually parsed with text and page order retained", async (t) => {
  const root = await fixture(t),
    pdfPath = path.join(root, "standard.pdf");
  await fs.writeFile(
    pdfPath,
    standardPDF(["YTRIPLE PDF ORCHID 31415", "Second page evidence 27182"]),
  );
  const source = await importFile(pdfPath);
  assert.match(source.text, /YTRIPLE PDF ORCHID 31415/);
  assert.match(source.text, /Second page evidence 27182/);
  assert.ok(
    source.text.indexOf("## 第 1 页") <
      source.text.indexOf("YTRIPLE PDF ORCHID 31415"),
  );
  assert.ok(
    source.text.indexOf("YTRIPLE PDF ORCHID 31415") <
      source.text.indexOf("## 第 2 页"),
  );
  assert.match(source.coverage, /PDF 2 页文字/);
  assert.match(source.coverage, /扫描文字未识别/);
  assert.equal(source.location, pdfPath);
});

test("PDF without extractable text requests OCR instead of accepting page headings as content", async (t) => {
  const root = await fixture(t),
    pdfPath = path.join(root, "no-text.pdf");
  await fs.writeFile(pdfPath, standardPDF([""]));
  await assert.rejects(importFile(pdfPath), /OCR/);
});

test("standard DOCX package yields Chinese paragraphs and table text through the actual importer", async (t) => {
  const root = await fixture(t),
    docxPath = path.join(root, "standard.docx");
  await fs.writeFile(docxPath, await standardDOCX());
  const source = await importFile(docxPath);
  assert.match(source.text, /YTRIPLE_DOCX_842/);
  assert.match(source.text, /中文需求：首版工作台 & 文档处理/);
  assert.match(source.text, /表格证据 TABLE_27182/);
  assert.ok(
    source.text.indexOf("YTRIPLE_DOCX_842") <
      source.text.indexOf("TABLE_27182"),
  );
  assert.match(source.coverage, /DOCX 文字提取/);
  assert.match(source.coverage, /图片、版面与批注未包含/);
});

test("PPTX exports an actual presentation package with editable text shapes and valid slide relationships", async (t) => {
  const root = await fixture(t),
    pptxPath = path.join(root, "editable.pptx");
  const body = [
    "# 可编辑研究成果",
    "PPTX_SENTINEL_31415",
    "Research & evidence <remain editable>",
    ...Array.from(
      { length: 9 },
      (_, i) => "第 " + (i + 1) + " 条研究证据：保留来源与用户修正。",
    ),
  ].join("\n");
  const output = await presentation(artifact(body));
  await fs.writeFile(pptxPath, output);
  const zip = await JSZip.loadAsync(await fs.readFile(pptxPath));
  const contentTypes = await zip.file("[Content_Types].xml")!.async("string");
  assert.match(
    contentTypes,
    /application\/vnd\.openxmlformats-officedocument\.presentationml\.presentation\.main\+xml/,
  );
  assert.ok(zip.file("ppt/presentation.xml"));
  assert.ok(zip.file("ppt/_rels/presentation.xml.rels"));
  const slidePaths = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort(
      (a, b) =>
        Number(a.match(/slide(\d+)/)![1]) - Number(b.match(/slide(\d+)/)![1]),
    );
  assert.ok(
    slidePaths.length >= 2,
    "longer material should produce multiple actual slides",
  );
  const text: string[] = [];
  for (const slidePath of slidePaths) {
    const xml = await zip.file(slidePath)!.async("string");
    const document = new DOMParser().parseFromString(xml, "text/xml");
    assert.ok(
      document.getElementsByTagName("p:sp").length >= 2,
      "content is composed of editable shapes",
    );
    assert.ok(
      document.getElementsByTagName("p:txBody").length >= 2,
      "text lives in native DrawingML text bodies",
    );
    assert.equal(
      document.getElementsByTagName("p:pic").length,
      0,
      "text must not be a flattened screenshot",
    );
    text.push(
      ...Array.from(document.getElementsByTagName("a:t")).map(
        (node) => node.textContent || "",
      ),
    );
    assert.ok(
      zip.file(slidePath.replace("slides/", "slides/_rels/") + ".rels"),
    );
  }
  const joined = text.join("\n");
  assert.match(joined, /可编辑研究成果/);
  assert.match(joined, /PPTX_SENTINEL_31415/);
  assert.match(joined, /Research & evidence <remain editable>/);
  assert.match(joined, /第 9 条研究证据/);
});

test("HTML image document removes executable elements and event handlers, with CSP blocking external resources", () => {
  const input = artifact(
    '<!doctype html><html><head><title>Fixture</title><base href="https://outside.invalid/"><meta http-equiv="refresh" content="0;url=https://outside.invalid/"><link rel="stylesheet" href="https://outside.invalid/style.css"><style>@import url("https://outside.invalid/import.css"); .card{color:#123456}</style><script src="https://outside.invalid/code.js">bad()</script></head><body onload="bad()"><h1>保留信息图正文 HTML_SENTINEL_42</h1><p class="card" onclick="bad()">可见依据</p><iframe src="https://outside.invalid/frame"></iframe><object data="https://outside.invalid/object"></object><embed src="https://outside.invalid/embed"><form action="https://outside.invalid/submit"><input name="value"></form><img src="https://outside.invalid/image.png" onerror="bad()"><img src="data:image/png;base64,iVBORw0KGgo="><a href="javascript:bad()" onclick="bad()">链接</a><audio src="https://outside.invalid/audio"></audio><video src="https://outside.invalid/video"></video></body></html>',
    "html",
  );
  const result = imageDocument(input),
    { document } = parseHTML(result);
  assert.match(
    document.body.textContent || "",
    /保留信息图正文 HTML_SENTINEL_42/,
  );
  assert.equal(
    document.querySelectorAll(
      'script,iframe,object,embed,link,base,form,audio,video,meta[http-equiv="refresh"]',
    ).length,
    0,
  );
  for (const el of document.querySelectorAll("*"))
    assert.ok([...el.attributes].every((attr) => !/^on/i.test(attr.name)));
  const policies = document.querySelectorAll(
    'meta[http-equiv="Content-Security-Policy"]',
  );
  assert.equal(policies.length, 1);
  const csp = policies[0]!.getAttribute("content") || "";
  for (const directive of [
    "default-src 'none'",
    "script-src 'none'",
    "frame-src 'none'",
    "img-src data:",
    "font-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ])
    assert.ok(csp.includes(directive));
  assert.ok(
    !csp.includes("https:") && !csp.includes("http:") && !csp.includes("*"),
  );
  // Inline style/data images remain usable, while remote image/CSS URLs are blocked by CSP.
  assert.match(result, /color:#123456/);
  assert.ok(document.querySelector('img[src^="data:"]'));
});

test("Markdown image document escapes HTML instead of executing embedded markup", () => {
  const result = imageDocument(
    artifact(
      "# 安全文本\n<script>synthetic()</script>\n<img src=x onerror=synthetic()>",
    ),
  );
  const { document } = parseHTML(result);
  assert.equal(document.querySelectorAll("script,img").length, 0);
  assert.match(
    document.body.textContent || "",
    /<script>synthetic\(\)<\/script>/,
  );
});
