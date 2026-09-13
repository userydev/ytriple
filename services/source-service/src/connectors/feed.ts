import { createHash } from "node:crypto";
import { DOMParser } from "linkedom";
import { readableText } from "./readable-text.js";
import {
  HttpUrlSchema,
  MAX_ITEM_CONTENT_BYTES,
} from "@ytriple/source-contract";
import type { NormalizedPublicItem } from "../store/database.js";
import {
  fetchPublicDocument,
  normalizePublicDocument,
  PublicURLConnectorError,
  type FetchPublicURLOptions,
  type PublicDocument,
} from "./public-url.js";

const MAX_FEED_ITEMS = 40;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function children(element: Element, name: string): Element[] {
  return Array.from(element.children).filter(
    (child) => child.localName === name || child.tagName === name,
  );
}
function text(element: Element, name: string): string {
  return children(element, name)[0]?.textContent?.trim() ?? "";
}

export function normalizeFeed(
  input: PublicDocument,
): NormalizedPublicItem[] | undefined {
  const xml = input.rawContent.trim();
  const looksLikeFeed = /<(rss|feed|rdf:RDF)(\s|>)/i.test(xml.slice(0, 4096));
  if (!looksLikeFeed) return undefined;
  if (/<!DOCTYPE|<!ENTITY/i.test(xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")))
    throw new PublicURLConnectorError(
      "SOURCE_UNSUPPORTED_CONTENT",
      "订阅源包含不支持的 XML 声明。",
    );
  const document = new DOMParser().parseFromString(xml, "text/xml");
  const root = document.documentElement as unknown as Element;
  if (!root || !["rss", "feed", "rdf:RDF", "RDF"].includes(root.localName))
    throw new PublicURLConnectorError(
      "SOURCE_CONTENT_UNREADABLE",
      "订阅源格式无法识别。",
    );
  const atom = root.localName === "feed";
  const container = atom ? root : (children(root, "channel")[0] ?? root);
  const entries = atom
    ? children(root, "entry")
    : children(container, "item").length
      ? children(container, "item")
      : children(root, "item");
  const seen = new Set<string>();
  const items: NormalizedPublicItem[] = [];
  const publicationTime = (entry: Element) =>
    Date.parse(
      text(entry, atom ? "published" : "pubDate") ||
        text(entry, "updated") ||
        text(entry, "dc:date"),
    ) || 0;
  for (const entry of entries
    .toSorted((left, right) => publicationTime(right) - publicationTime(left))
    .slice(0, MAX_FEED_ITEMS)) {
    const title = readableText(text(entry, "title")).slice(0, 500);
    const link = atom
      ? children(entry, "link")
          .find(
            (node) =>
              !node.getAttribute("rel") ||
              node.getAttribute("rel") === "alternate",
          )
          ?.getAttribute("href")
      : text(entry, "link");
    if (!title || !link) continue;
    let canonicalUrl: string;
    try {
      canonicalUrl = new URL(link, input.url).href;
    } catch {
      continue;
    }
    if (!HttpUrlSchema.safeParse(canonicalUrl).success) continue;
    const identity = text(entry, atom ? "id" : "guid") || canonicalUrl;
    const externalItemKey = `feed:${digest(identity)}`;
    if (seen.has(externalItemKey)) continue;
    seen.add(externalItemKey);
    const full = atom ? text(entry, "content") : text(entry, "content:encoded");
    const description = text(entry, atom ? "summary" : "description");
    const body = readableText(full || description);
    const rawDate =
      text(entry, atom ? "published" : "pubDate") ||
      text(entry, "updated") ||
      text(entry, "dc:date");
    const published = Number.isFinite(Date.parse(rawDate))
      ? new Date(rawDate).toISOString()
      : undefined;
    const content = [published ? `发布时间：${published}` : "", body || title]
      .filter(Boolean)
      .join("\n\n");
    if (Buffer.byteLength(content) > MAX_ITEM_CONTENT_BYTES) continue;
    items.push({
      externalItemKey,
      canonicalUrl,
      title,
      content,
      observedAt: input.observedAt,
      publishedAt: published,
      contentHash: digest(content),
      coverage: full && body ? "fulltext" : "metadata",
      missing: [
        "media",
        "authenticated-content",
        ...(full && body
          ? ["linked-page-not-fetched"]
          : ["fulltext", "feed-summary-only"]),
      ],
    });
  }
  if (entries.length && !items.length)
    throw new PublicURLConnectorError(
      "SOURCE_CONTENT_UNREADABLE",
      "订阅源没有可读取的有效条目。",
    );
  return items;
}

export async function fetchSourceItems(
  url: string,
  options: FetchPublicURLOptions = {},
): Promise<NormalizedPublicItem[]> {
  const document = await fetchPublicDocument(url, options);
  const items = normalizeFeed(document);
  if (!items) return [normalizePublicDocument(document)];
  // A bounded current reading sample is enriched on the server. Other feed
  // entries retain their actual summary coverage and remain browseable.
  const queue = items
    .filter((item) => item.coverage !== "fulltext")
    .slice(0, 12);
  await Promise.all(
    Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length) {
        const item = queue.shift()!;
        try {
          const article = normalizePublicDocument(
            await fetchPublicDocument(item.canonicalUrl, options),
          );
          const published = item.content.match(/^发布时间：[^\n]+/)?.[0];
          const content = published
            ? `${published}\n\n${article.content}`
            : article.content;
          if (Buffer.byteLength(content) > MAX_ITEM_CONTENT_BYTES)
            throw new Error("正文超过条目上限。");
          item.content = content;
          item.contentHash = digest(item.content);
          item.coverage = "fulltext";
          item.missing = article.missing;
        } catch {
          item.missing = [...item.missing, "linked-page-unavailable"];
        }
      }
    }),
  );
  return items;
}
