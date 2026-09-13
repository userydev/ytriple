import assert from "node:assert/strict";
import test from "node:test";
import { coverReader, rasterSize } from "../src/editorial-cover.js";
import { editorialRevision } from "../../../tests/fixtures/editorial.js";

function png(width = 800, height = 450) {
  const data = Buffer.alloc(32);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data);
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

test("covers follow only a captured source citation and retain the actual publisher and image", async () => {
  const revision = editorialRevision();
  revision.evidence[0]!.excerpt += "\nhttps://report.example.com/story/actual";
  const visited: string[] = [];
  const cover = await coverReader({}, async (url) => {
    visited.push(url);
    return {
      url,
      observedAt: revision.createdAt,
      contentType: url.endsWith(".png") ? "image/png" : "text/html",
      bytes: url.endsWith(".png")
        ? png()
        : Buffer.from(
            url.includes("report.example")
              ? '<meta property="og:image" content="https://photos.example.com/actual.png"><meta property="og:site_name" content="Original Report"><meta property="og:image:alt" content="Article photo">'
              : '<a href="https://unrelated.example/news">Other news</a>',
          ),
    };
  })(revision);
  assert.equal(cover?.publisher, "Original Report");
  assert.equal(cover?.pageUrl, "https://report.example.com/story/actual");
  assert.equal(cover?.imageUrl, "https://photos.example.com/actual.png");
  assert.equal(cover?.width, 800);
  assert.match(cover!.data, /^data:image\/png;base64,/);
  assert.equal(visited.length, 3);
  assert.equal(
    visited.some((url) => url.includes("unrelated")),
    false,
  );
});

test("missing, failed, oversized, tiny or mislabeled media never creates a cover", async () => {
  const revision = editorialRevision();
  for (const [contentType, bytes] of [
    ["image/svg+xml", Buffer.from('<svg onload="alert(1)"></svg>')],
    ["image/jpeg", Buffer.from("<html>not an image</html>")],
    ["image/png", png(1, 1)],
    ["image/png", png(8000, 4500)],
    ["image/png", Buffer.concat([png(), Buffer.alloc(620_000)])],
  ] as const) {
    assert.equal(
      await coverReader({}, async (url) => ({
        url,
        observedAt: revision.createdAt,
        contentType: url.endsWith(".png") ? contentType : "text/html",
        bytes: url.endsWith(".png")
          ? bytes
          : Buffer.from(
              '<meta property="og:image" content="https://photos.example.com/article.png">',
            ),
      }))(revision),
      undefined,
    );
  }
  assert.equal(
    await coverReader({}, async () => {
      throw new Error("unavailable");
    })(revision),
    undefined,
  );
  assert.equal(
    rasterSize(
      Buffer.from([255, 216, 255, 192, 0, 1, 0, 0, 0, 0, 0]),
      "image/jpeg",
    ),
    undefined,
  );
});
