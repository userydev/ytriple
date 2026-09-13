export const jobLeaseTokenMigration = {
  version: 2,
  name: "fence worker job leases",
  sql: String.raw`
ALTER TABLE fetch_run
  ADD COLUMN IF NOT EXISTS lease_token uuid;
`,
} as const;
