import { parseHTML } from "linkedom";
import {
  EditorialCoverSchema,
  type EditorialCover,
  type EditorialRevision,
} from "@ytriple/source-contract";
import {
  fetchPublicResource,
  type FetchPublicURLOptions,
} from "./connectors/public-url.js";

type ResourceReader = typeof fetchPublicResource;
export type CoverReader = (
  revision: EditorialRevision,
) => Promise<EditorialCover | undefined>;

/** Dimensions come from the downloaded raster, never from page-supplied metadata. */
export function rasterSize(
  bytes: Buffer,
  type: string,
): [number, number] | undefined {
  if (
    type === "image/png" &&
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (type === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216) {
    for (let offset = 2; offset + 8 < bytes.length;) {
      if (bytes[offset] !== 255) return;
      const marker = bytes[offset + 1]!;
      if (marker === 255) {
        offset++;
        continue;
      }
      if (marker === 0xda || marker === 0xd9) return;
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) return;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8)
        return [bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5)];
      offset += length + 2;
    }
  }
  if (
    type === "image/webp" &&
    bytes.length >= 30 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 16) === "WEBPVP8X"
  ) {
    // Animated covers add distraction and may greatly exceed their decoded size.
    if (bytes[20]! & 2) return;
    return [bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1];
  }
  return;
}

export function coverReader(
  options: FetchPublicURLOptions = {},
  read: ResourceReader = fetchPublicResource,
): CoverReader {
  return async (revision) => {
    const material = revision.evidence[0];
    if (!material) return;
    // The only additional page may be an explicitly cited article in the captured text.
    // Do not search for a generic topic photo or follow unrelated page links.
    const linked = [...material.excerpt.matchAll(/https:\/\/[^\s<>"\])）]+/gu)]
      .map(([url]) => url.replace(/[.,;，。；]+$/u, ""))
      .find((url) => {
        try {
          const candidate = new URL(url);
          return (
            candidate.hostname !== new URL(material.url).hostname &&
            candidate.pathname !== "/" &&
            !/12377\.cn|beian|privacy|terms/iu.test(url)
          );
        } catch {
          return false;
        }
      });
    for (const page of [
      ...new Set(
        [material.url, linked].filter((url): url is string => Boolean(url)),
      ),
    ]) {
      try {
        const document = await read(page, options);
        if (document.contentType !== "text/html") continue;
        const { document: html } = parseHTML(document.bytes.toString("utf8"));
        const meta = (property: string) =>
          html
            .querySelector(
              `meta[property="${property}"],meta[name="${property}"]`,
            )
            ?.getAttribute("content")
            ?.trim();
        const candidate = meta("og:image");
        if (
          !candidate ||
          /(?:logo|placeholder|default[-_]?social|favicon)/iu.test(candidate)
        )
          continue;
        const imageURL = new URL(candidate, document.url);
        if (imageURL.protocol !== "https:") continue;
        const image = await read(imageURL.href, options);
        if (image.bytes.length > 600 * 1024) continue;
        const size = rasterSize(image.bytes, image.contentType);
        if (
          !size ||
          size[0] / size[1] < 1 ||
          size[0] / size[1] > 2.4 ||
          size[0] * size[1] > 8_000_000
        )
          continue;
        const parsed = EditorialCoverSchema.safeParse({
          data: `data:${image.contentType};base64,${image.bytes.toString("base64")}`,
          pageUrl: document.url,
          imageUrl: image.url,
          publisher:
            meta("og:site_name")?.slice(0, 120) ||
            new URL(document.url).hostname,
          description: meta("og:image:alt")?.slice(0, 300) || "",
          width: size[0],
          height: size[1],
        });
        if (parsed.success) return parsed.data;
      } catch {
        /* Optional source media never prevents publication. */
      }
    }
    return;
  };
}
