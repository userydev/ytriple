export const observationRevisionMigration = {
  version: 3,
  name: "record repeated content observations",
  sql: String.raw`
ALTER TABLE item_revision
  DROP CONSTRAINT IF EXISTS item_revision_tenant_id_item_id_content_hash_key;
`,
} as const;
