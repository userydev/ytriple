export const immutableFollowDeliveriesMigration = {
  version: 7,
  name: "immutable per-follow deliveries",
  sql: String.raw`
-- Version 6 briefly used an ON DELETE SET NULL reference and included the
-- event kind in its uniqueness key. Preserve committed follow provenance and
-- make delivery of one revision to one follow idempotent regardless of kind.
ALTER TABLE delivery_change
  DROP CONSTRAINT IF EXISTS delivery_change_follow_fk;
DROP INDEX IF EXISTS delivery_change_follow_revision_kind_idx;
CREATE UNIQUE INDEX IF NOT EXISTS delivery_change_follow_revision_idx
  ON delivery_change(tenant_id, follow_id, revision_id)
  WHERE follow_id IS NOT NULL;
`,
} as const;
