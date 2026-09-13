export const readingTopicsMigration = {
  version: 9,
  name: "server reading topics",
  sql: `CREATE TABLE reading_topic (
    tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    category text NOT NULL,
    input_hash text NOT NULL,
    body jsonb,
    attempted_at timestamptz NOT NULL DEFAULT now(),
    error text,
    PRIMARY KEY (tenant_id, category)
  );`,
} as const;
