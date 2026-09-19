import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleRadarMaterials } from "../src/core/material-list";
import { Store } from "../src/core/store";
import type { Material } from "../src/core/types";

const publicMaterial = (
  localId: string,
  scope: string,
  upstreamId: string,
  url: string,
  version: number,
  provenance: NonNullable<Material["upstream"]>["provenance"] = [],
): Material => ({
  id: localId,
  version,
  title: localId,
  body: localId,
  coverage: "summary",
  url,
  upstream: {
    scope,
    id: upstreamId,
    revision: version,
    publisher: provenance.length ? "Publisher" : null,
    publishedAt: null,
    discoveredAt: "2026-09-18T00:00:00Z",
    updatedAt: "2026-09-18T00:00:00Z",
    topics: provenance.length ? ["technology"] : [],
    provenance,
    contentHash: provenance.length ? "hash" : "",
    fullArticle: false,
  },
  createdAt: "2026-09-18T00:00:00Z",
});

test("Radar display groups the same public upstream document across scopes without changing stored references", () => {
  const store = new Store(":memory:");
  const old = publicMaterial(
    "ycore:legacy:doc-a",
    "legacy",
    "doc-a",
    "https://example.com/a",
    2,
  );
  const current = publicMaterial(
    "ycore:managed:doc-a",
    "managed",
    "doc-a",
    "https://example.com/a",
    2,
    [
      {
        sourceId: "arstechnica-rss",
        adapter: "rss",
        upstreamId: "entry-a",
        discoveredAt: "2026-09-18T00:00:00Z",
        rawRef: "raw-a",
      },
    ],
  );
  const newer = publicMaterial(
    "ycore:third:doc-a",
    "third",
    "doc-a",
    "https://example.com/a",
    3,
  );
  const otherDocument = publicMaterial(
    "ycore:managed:doc-b",
    "managed",
    "doc-b",
    "https://example.com/a",
    1,
  );
  const local: Material = {
    id: "local",
    version: 1,
    title: "Local",
    body: "Local",
    coverage: "local_text",
    url: "https://example.com/a",
    createdAt: "2026-09-18T00:00:00Z",
  };

  store.put("material", `${old.id}@${old.version}`, old);
  store.put("material", `${current.id}@${current.version}`, current);
  const visibleStored = visibleRadarMaterials(store.all("material"));
  assert.deepEqual(visibleStored, [current]);
  assert.equal(visibleRadarMaterials([old, current])[0], current);
  assert.deepEqual(
    visibleRadarMaterials([old, current, newer, otherDocument, local]),
    [local, otherDocument, newer],
  );
  assert.equal(old.id, "ycore:legacy:doc-a");
  assert.equal(current.id, "ycore:managed:doc-a");
  assert.equal(old.version, 2);
  assert.equal(current.version, 2);
  assert.deepEqual(
    store.require<Material>("material", `${old.id}@${old.version}`),
    old,
  );
  assert.deepEqual(
    store.require<Material>("material", `${current.id}@${current.version}`),
    current,
  );
  store.close();
});
