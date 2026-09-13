export const publicationTimeMigration = {
  version: 10,
  name: "source publication time",
  sql: `ALTER TABLE item_revision ADD COLUMN published_at timestamptz;`,
} as const;
