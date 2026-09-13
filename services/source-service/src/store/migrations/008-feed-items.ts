export const feedItemsMigration = {
  version: 8,
  name: "feed-items",
  sql: `ALTER TABLE fetch_run ADD COLUMN item_count integer CHECK (item_count >= 0 AND item_count <= 40);`,
};
