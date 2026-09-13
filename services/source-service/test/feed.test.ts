import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFeed, fetchSourceItems } from "../src/connectors/feed.js";

const input = (rawContent: string) => ({
  url: "https://example.com/feed",
  rawContent,
  contentType: "application/rss+xml",
  observedAt: "2026-09-12T12:00:00.000Z",
});
const rss = (items: string) =>
  `<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>${items}</channel></rss>`;
const item = (id: string, body = "<p>Feed summary</p>") =>
  `<item><guid>${id}</guid><title>Article ${id}</title><link>https://example.com/${id}</link><description><![CDATA[${body}]]></description></item>`;

test("RSS retains separate stable items, readable paragraphs and truthful summary coverage", () => {
  const result = normalizeFeed(
    input(
      rss(
        item(
          "a",
          "<p>Hello &amp; welcome</p><p>Second paragraph</p><script>alert(1)</script>",
        ) +
          item("b") +
          item("a"),
      ),
    ),
  )!;
  assert.equal(result.length, 2);
  assert.match(result[0]!.content, /Hello & welcome\n\nSecond paragraph/);
  assert.doesNotMatch(result[0]!.content, /alert/);
  assert.equal(result[0]!.coverage, "metadata");
  assert.ok(result[0]!.missing.includes("fulltext"));
  const reordered = normalizeFeed(input(rss(item("b") + item("a"))))!;
  assert.equal(result[0]!.externalItemKey, reordered[1]!.externalItemKey);
});

test("RSS encoded content and Atom entries preserve content, safe links and publication evidence", () => {
  const full = normalizeFeed(
    input(
      rss(
        `<item><guid>full</guid><title>Full article</title><link>https://example.com/full</link><content:encoded><![CDATA[<p>A body containing an example: &lt;!DOCTYPE html&gt;</p>]]></content:encoded></item>`,
      ),
    ),
  )![0]!;
  assert.equal(full.coverage, "fulltext");
  const atom = normalizeFeed(
    input(
      `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>atom-1</id><title>Atom article</title><link rel="self" href="/feed/1"/><link rel="alternate" href="/article"/><published>2026-09-10T12:00:00Z</published><content type="html">&lt;p&gt;Actual Atom text&lt;/p&gt;</content></entry></feed>`,
    ),
  )![0]!;
  assert.equal(atom.canonicalUrl, "https://example.com/article");
  assert.equal(atom.coverage, "fulltext");
  assert.match(atom.content, /发布时间：2026-09-10.*Actual Atom text/s);
});

test("feed accepts an empty observation, bounds a snapshot, rejects XML entities and unsafe entry links", () => {
  assert.deepEqual(normalizeFeed(input(rss(""))), []);
  assert.equal(
    normalizeFeed(
      input(
        rss(Array.from({ length: 60 }, (_, i) => item(String(i))).join("")),
      ),
    )!.length,
    40,
  );
  assert.throws(
    () =>
      normalizeFeed(
        input(
          `<!DOCTYPE rss [<!ENTITY secret SYSTEM "file:///etc/passwd">]>${rss(item("a"))}`,
        ),
      ),
    /XML/,
  );
  assert.throws(
    () =>
      normalizeFeed(
        input(
          rss(
            item("a").replace("https://example.com/a", "javascript:alert(1)"),
          ),
        ),
      ),
    /有效条目/,
  );
  assert.equal(
    normalizeFeed(input("<html><body>ordinary page</body></html>")),
    undefined,
  );
});

test("server enrichment uses the same protected transport and preserves a summary when the article is unavailable", async () => {
  const requested: string[] = [];
  const items = await fetchSourceItems("https://example.com/feed", {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async ({ url }) => {
      requested.push(url.href);
      if (url.pathname === "/feed")
        return {
          status: 200,
          headers: { "content-type": "application/rss+xml" },
          body: rss(item("good") + item("failed")),
        };
      if (url.pathname === "/good")
        return {
          status: 200,
          headers: { "content-type": "text/plain" },
          body: "A full article body fetched by the server and independent of the desktop.",
        };
      return { status: 403, headers: {}, body: "Unavailable" };
    },
  });
  assert.equal(requested.length, 3);
  assert.equal(items[0]!.coverage, "fulltext");
  assert.equal(items[1]!.coverage, "metadata");
  assert.ok(items[1]!.missing.includes("linked-page-unavailable"));
});
