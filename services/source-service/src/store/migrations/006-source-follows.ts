export const sourceFollowsMigration = {
  version: 6,
  name: "persistent source follows and scheduling",
  sql: String.raw`
CREATE TABLE IF NOT EXISTS recommended_source (
  id text PRIMARY KEY,
  name text NOT NULL,
  category text NOT NULL,
  description text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('public-url')),
  normalized_url text NOT NULL UNIQUE,
  refresh_interval_minutes integer NOT NULL
    CHECK (refresh_interval_minutes BETWEEN 5 AND 10080),
  enabled_by_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- This is a factual, public, server-curated source rather than synthetic demo
-- content. Future catalog changes are applied through later migrations.
INSERT INTO recommended_source(
  id, name, category, description, kind, normalized_url,
  refresh_interval_minutes, enabled_by_default
) VALUES (
  'openai-agents-js-changelog',
  'OpenAI Agents JS 更新',
  '开发工具',
  'OpenAI Agents JS 官方仓库发布的 SDK 变更记录。',
  'public-url',
  'https://raw.githubusercontent.com/openai/openai-agents-js/main/packages/agents/CHANGELOG.md',
  360,
  true
)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS source_follow (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  source_id uuid NOT NULL,
  origin text NOT NULL CHECK (origin IN ('user', 'recommended')),
  recommended_source_id text REFERENCES recommended_source(id),
  name text NOT NULL,
  category text NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'paused')),
  refresh_interval_minutes integer NOT NULL
    CHECK (refresh_interval_minutes BETWEEN 5 AND 10080),
  next_refresh_at timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error_code text,
  last_error_message text,
  last_error_retryable boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, source_id)
    REFERENCES source(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, id),
  CHECK (
    (origin = 'recommended' AND recommended_source_id IS NOT NULL)
    OR (origin = 'user' AND recommended_source_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS source_follow_due_idx
  ON source_follow(next_refresh_at, id)
  WHERE state = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS source_follow_user_source_idx
  ON source_follow(tenant_id, source_id)
  WHERE origin = 'user';
CREATE UNIQUE INDEX IF NOT EXISTS source_follow_recommended_idx
  ON source_follow(tenant_id, recommended_source_id)
  WHERE origin = 'recommended';

-- A source can yield a collection of stable external items. The public URL
-- connector intentionally uses the single key 'page'; platform/feed
-- connectors can use their native immutable item IDs without changing this
-- cardinality again.
ALTER TABLE source_item
  ADD COLUMN IF NOT EXISTS external_item_key text;
UPDATE source_item
SET external_item_key = 'page'
WHERE external_item_key IS NULL;
ALTER TABLE source_item
  ALTER COLUMN external_item_key SET NOT NULL;
ALTER TABLE source_item
  DROP CONSTRAINT IF EXISTS source_item_tenant_id_source_id_key;
ALTER TABLE source_item
  ADD CONSTRAINT source_item_tenant_source_external_key
  UNIQUE (tenant_id, source_id, external_item_key);

ALTER TABLE fetch_run
  ADD COLUMN IF NOT EXISTS follow_id uuid,
  ADD COLUMN IF NOT EXISTS trigger_kind text NOT NULL DEFAULT 'explicit'
    CHECK (trigger_kind IN ('explicit', 'created', 'manual', 'scheduled'));

ALTER TABLE fetch_run
  DROP CONSTRAINT IF EXISTS fetch_run_follow_fk;
ALTER TABLE fetch_run
  ADD CONSTRAINT fetch_run_follow_fk
  FOREIGN KEY (follow_id)
  REFERENCES source_follow(id)
  ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS fetch_run_active_follow_idx
  ON fetch_run(follow_id)
  WHERE follow_id IS NOT NULL AND status IN ('queued', 'running');

ALTER TABLE delivery_change
  ADD COLUMN IF NOT EXISTS follow_id uuid;
ALTER TABLE delivery_change
  DROP CONSTRAINT IF EXISTS delivery_change_tenant_id_revision_id_change_type_key;
ALTER TABLE delivery_change
  DROP CONSTRAINT IF EXISTS delivery_change_follow_fk;
ALTER TABLE delivery_change
  ADD CONSTRAINT delivery_change_follow_fk
  FOREIGN KEY (follow_id)
  REFERENCES source_follow(id)
  ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS delivery_change_follow_revision_kind_idx
  ON delivery_change(tenant_id, follow_id, revision_id, change_type)
  WHERE follow_id IS NOT NULL;
`,
} as const;
