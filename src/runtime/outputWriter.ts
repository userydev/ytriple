import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const DELIVERY_FILENAMES = [
  "01-final-prd.md",
  "02-assumptions-and-open-questions.md",
  "03-research-notes.md",
  "04-specialist-review.md",
] as const;

export interface DeliveryDocuments {
  finalPrd: string;
  assumptions: string;
  researchNotes: string;
  specialistReview: string;
}

export interface CreateDeliveryPackageInput {
  outputRoot: string;
  taskId: string;
  documents: DeliveryDocuments;
}

export async function createDeliveryPackage({
  outputRoot,
  taskId,
  documents,
}: CreateDeliveryPackageInput) {
  const packageRoot = resolve(outputRoot, "ytriple-outputs");
  const artifactsDir = join(packageRoot, taskId);
  await mkdir(packageRoot, { recursive: true });
  await mkdir(artifactsDir, { recursive: false });

  const entries = [
    [DELIVERY_FILENAMES[0], documents.finalPrd],
    [DELIVERY_FILENAMES[1], documents.assumptions],
    [DELIVERY_FILENAMES[2], documents.researchNotes],
    [DELIVERY_FILENAMES[3], documents.specialistReview],
  ] as const;

  const files = [];
  for (const [filename, content] of entries) {
    const path = join(artifactsDir, filename);
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
    files.push({ filename, path, created: true });
  }

  return { artifactsDir, files };
}
