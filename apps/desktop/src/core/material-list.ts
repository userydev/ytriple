import type { Material } from "./types";

function publicIdentity(material: Material) {
  if (!material.upstream || !material.url) return `material\0${material.id}`;
  return `public\0${material.upstream.id.length}:${material.upstream.id}\0${material.url}`;
}

function metadataScore(material: Material) {
  const upstream = material.upstream as
    | (Material["upstream"] & {
        provenance?: unknown[];
        topics?: unknown[];
        contentHash?: string;
        publisher?: string | null;
      })
    | undefined;
  if (!upstream) return 0;
  return (
    (upstream.provenance?.length ?? 0) * 4 +
    (upstream.topics?.length ?? 0) * 2 +
    Number(Boolean(upstream.contentHash)) +
    Number(Boolean(upstream.publisher))
  );
}

/** Returns display representatives without changing or cloning stored materials. */
export function visibleRadarMaterials(materials: readonly Material[]) {
  const visible = new Map<string, Material>();
  for (const material of materials) {
    const key = publicIdentity(material);
    const previous = visible.get(key);
    if (
      !previous ||
      material.version > previous.version ||
      (material.version === previous.version &&
        metadataScore(material) >= metadataScore(previous))
    )
      visible.set(key, material);
  }
  return Array.from(visible.values()).reverse();
}
