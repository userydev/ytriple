export const initialMigration = {
  version: 1,
  name: "initial source service",
  sql: String.raw`
CREATE TABLE IF NOT EXISTS service_instance (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS principal (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('self-host-owner')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bootstrap_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  principal_id uuid NOT NULL REFERENCES principal(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS device (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  principal_id uuid NOT NULL REFERENCES principal(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  scopes text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS device_tenant_idx ON device(tenant_id, id);

CREATE TABLE IF NOT EXISTS pairing_request (
  idempotency_key text PRIMARY KEY,
  request_hash char(64) NOT NULL,
  device_id uuid NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS connector (
  id text PRIMARY KEY,
  kind text NOT NULL,
  contract_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO connector(id, kind, contract_version)
VALUES ('public-url', 'public-url', '1.0')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS source (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  connector_id text NOT NULL REFERENCES connector(id),
  kind text NOT NULL CHECK (kind IN ('public-url')),
  normalized_url text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind, normalized_url),
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS idempotency_request (
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  operation text NOT NULL,
  request_hash char(64) NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS fetch_run (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  source_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  item_id uuid,
  revision_id uuid,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, source_id) REFERENCES source(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS fetch_run_claim_idx
  ON fetch_run(status, run_after, created_at);

CREATE TABLE IF NOT EXISTS source_checkpoint (
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  source_id uuid NOT NULL,
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source_id),
  FOREIGN KEY (tenant_id, source_id) REFERENCES source(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS source_item (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  source_id uuid NOT NULL,
  canonical_url text NOT NULL,
  title text NOT NULL,
  latest_revision_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, source_id) REFERENCES source(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, source_id),
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS item_revision (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  item_id uuid NOT NULL,
  observed_at timestamptz NOT NULL,
  content_hash char(64) NOT NULL,
  coverage text NOT NULL CHECK (coverage IN ('listing', 'metadata', 'fulltext', 'transcript', 'vision')),
  missing jsonb NOT NULL DEFAULT '[]'::jsonb,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, item_id) REFERENCES source_item(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, item_id, content_hash),
  UNIQUE (tenant_id, id)
);

ALTER TABLE source_item
  DROP CONSTRAINT IF EXISTS source_item_latest_revision_fk;
ALTER TABLE source_item
  ADD CONSTRAINT source_item_latest_revision_fk
  FOREIGN KEY (tenant_id, latest_revision_id)
  REFERENCES item_revision(tenant_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS delivery_change (
  sequence bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  change_type text NOT NULL CHECK (change_type IN ('item.created', 'item.revised')),
  source_id uuid NOT NULL,
  item_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  observed_at timestamptz NOT NULL,
  content_hash char(64) NOT NULL,
  coverage text NOT NULL,
  missing jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, source_id) REFERENCES source(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES source_item(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, revision_id) REFERENCES item_revision(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, revision_id, change_type)
);
CREATE INDEX IF NOT EXISTS delivery_change_tenant_sequence_idx
  ON delivery_change(tenant_id, sequence);
`,
} as const;
