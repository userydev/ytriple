export const jobErrorRetryabilityMigration = {
  version: 4,
  name: "persist job error retryability",
  sql: String.raw`
ALTER TABLE fetch_run
  ADD COLUMN IF NOT EXISTS error_retryable boolean;
`,
} as const;
