import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store";
import type { Material } from "../src/core/types";
import { YCore } from "../src/core/ycore";

const response = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "X-YCore-Contract": "0.1.0" } });

const document = (revision: number, title = `Revision ${revision}`) => ({
  id: "stable-document",
  revision,
  url: "https://publisher.example/item",
  publisher: "Publisher",
  published_at: null,
  discovered_at: "2026-09-17T10:00:00Z",
  updated_at: `2026-09-18T0${revision}:00:00Z`,
  topics: revision === 1 ? ["ai"] : ["ai", "agents"],
  content: {
    title,
    summary: `Summary ${revision}`,
    body: null,
    format: "text",
    coverage: "summary",
    full_article: false,
  },
  provenance: [
    {
      source_id: "source-rss",
      adapter: "rss",
      upstream_id: "entry-42",
      discovered_at: "2026-09-17T10:00:00Z",
      raw_ref: `raw-${revision}`,
    },
  ],
  content_hash: `content-${revision}`,
  visibility: "public",
  ...(revision === 2
    ? {
        image: {
          url: "https://publisher.example/cover.jpg",
          origin: "enclosure" as const,
          credit: "Publisher",
        },
      }
    : {}),
});

test("material sync preserves stable identity, revisions, provenance and local relations across replay", async () => {
  const store = new Store(":memory:");
  let changeCalls = 0;
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/sources")
      return response({ data: [{ id: "source-rss", name: "RSS", status: "active", last_error: null }] });
    if (url.pathname === "/v1/documents")
      return response({ data: [document(1)], next_cursor: null, sync_cursor: "snapshot" });
    changeCalls++;
    return response({
      data: [
        {
          sequence: "90071992547409930",
          operation: "upsert",
          document: document(2),
        },
      ],
      next_cursor: "increment-2",
      has_more: false,
    });
  };
  const client = new YCore("https://core.example", "token", fetcher);
  await client.sync(store);
  const materialId = `ycore:${client.scope}:stable-document`;
  store.put("radar-topic", "topic-local", {
    id: "topic-local",
    revision: 1,
    title: "Local topic",
    focus: "",
    sources: [{ materialId, policy: "auto", reason: "" }],
    updatedAt: "2026-09-18T00:00:00Z",
  });
  store.put("radar-reading", "edition-local", {
    id: "edition-local",
    saved: true,
    read: true,
    scroll: 240,
  });

  await client.sync(store);

  const revisions = store
    .all<Material>("material")
    .filter((item) => item.id === materialId)
    .sort((a, b) => a.version - b.version);
  assert.equal(revisions.length, 2);
  assert.equal(revisions[0].createdAt, "2026-09-17T10:00:00Z");
  assert.deepEqual(revisions[1].upstream?.topics, ["ai", "agents"]);
  assert.deepEqual(revisions[1].upstream?.provenance, [
    {
      sourceId: "source-rss",
      adapter: "rss",
      upstreamId: "entry-42",
      discoveredAt: "2026-09-17T10:00:00Z",
      rawRef: "raw-2",
    },
  ]);
  assert.equal(revisions[1].upstream?.contentHash, "content-2");
  assert.equal(revisions[1].upstream?.fullArticle, false);
  assert.equal(revisions[1].coverage, "summary");
  assert.equal(revisions[1].image?.url, "https://publisher.example/cover.jpg");
  store.put("material", `${materialId}@2`, {
    ...revisions[1],
    derived: {
      processorVersion: "neutral-brief-v1+gemini-3.8-flash",
      status: "ready",
      titleZh: "修订要点",
      digest: "Summary 2",
      keypoints: [{ text: "要点", quote: "Summary 2" }],
      coverage: "summary",
      model: "gemini-3.8-flash",
      processedAt: "2026-09-18T02:00:00Z",
      contentHash: "content-2",
      revision: 2,
      error: null,
    },
  });
  await client.sync(store);
  const kept = store.get<Material>("material", `${materialId}@2`);
  assert.equal(kept?.derived?.titleZh, "修订要点");
  assert.equal(store.all("material").length, 2);
  assert.equal(changeCalls, 3);
  assert.equal(
    store.get<any>("radar-topic", "topic-local").sources[0].materialId,
    materialId,
  );
  assert.deepEqual(store.get("radar-reading", "edition-local"), {
    id: "edition-local",
    saved: true,
    read: true,
    scroll: 240,
  });
  store.close();
});

test("expired cursors rebuild in the same sync and failures retain prior material and cursor state", async () => {
  const store = new Store(":memory:");
  let mode: "initial" | "expired" | "failed" = "initial";
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (url.pathname === "/v1/sources") return response({ data: [] });
    if (url.pathname === "/v1/documents")
      return response({
        data: [document(mode === "initial" ? 1 : 2)],
        next_cursor: null,
        sync_cursor: "rebuilt",
      });
    if (mode === "expired" && url.searchParams.get("cursor") === "initial")
      return response(
        { error: { code: "CURSOR_EXPIRED", message: "expired" } },
        410,
      );
    if (mode === "failed")
      return response({ error: { code: "SOURCE_UNAVAILABLE", message: "offline" } }, 503);
    return response({
      data: [],
      next_cursor: mode === "initial" ? "initial" : "current",
      has_more: false,
    });
  };
  const client = new YCore("https://core.example", "token", fetcher);
  await client.sync(store);
  mode = "expired";
  await client.sync(store);
  assert.equal(store.get("meta", `sync:${client.scope}`), "current");
  assert.ok(calls.some((path) => path === "/v1/documents?limit=50"));
  assert.deepEqual(
    store.all<Material>("material").map((item) => item.version).sort(),
    [1, 2],
  );

  mode = "failed";
  await assert.rejects(client.sync(store), /offline/);
  assert.equal(store.get("meta", `sync:${client.scope}`), "current");
  assert.equal(store.all("material").length, 2);
  store.close();
});
