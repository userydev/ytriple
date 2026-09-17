CREATE SCHEMA ytriple;
REVOKE ALL ON SCHEMA ytriple FROM PUBLIC;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ytriple_runtime') THEN
    CREATE ROLE ytriple_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;

CREATE TABLE ytriple.workspaces (
  id uuid PRIMARY KEY,
  owner_subject text NOT NULL CHECK (length(owner_subject) BETWEEN 1 AND 200),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  create_key uuid NOT NULL,
  create_hash text NOT NULL CHECK (create_hash ~ '^[a-f0-9]{64}$'),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  state_format integer NOT NULL DEFAULT 1 CHECK (state_format = 1),
  state jsonb NOT NULL CHECK (jsonb_typeof(state)='object' AND state ?& ARRAY['entities','submissions'] AND
    jsonb_typeof(state->'entities')='array' AND jsonb_typeof(state->'submissions')='array' AND
    octet_length(state::text) <= 67108864),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_subject,create_key),
  UNIQUE(id,owner_subject)
);
CREATE INDEX workspaces_owner_created ON ytriple.workspaces(owner_subject,created_at,id);

CREATE TABLE ytriple.command_receipts (
  workspace_id uuid NOT NULL,
  owner_subject text NOT NULL,
  key uuid NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  revision integer NOT NULL CHECK (revision > 0),
  response jsonb NOT NULL CHECK (octet_length(response::text) <= 1048576),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,key),
  FOREIGN KEY(workspace_id,owner_subject) REFERENCES ytriple.workspaces(id,owner_subject)
);
ALTER TABLE ytriple.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE ytriple.workspaces FORCE ROW LEVEL SECURITY;
ALTER TABLE ytriple.command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ytriple.command_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA ytriple FROM PUBLIC;
-- Hosting platforms may assign global default grants to newly created objects.
-- Revoke on the actual objects; per-schema default revokes cannot undo global grants.
DO $$ DECLARE client_role text; BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=client_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA ytriple FROM %I',client_role);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA ytriple FROM %I',client_role);
    END IF;
  END LOOP;
END $$;
GRANT USAGE ON SCHEMA ytriple TO ytriple_runtime;
GRANT SELECT,INSERT ON ytriple.workspaces TO ytriple_runtime;
GRANT UPDATE(name,revision,state,updated_at) ON ytriple.workspaces TO ytriple_runtime;
GRANT SELECT,INSERT ON ytriple.command_receipts TO ytriple_runtime;

CREATE POLICY workspace_read ON ytriple.workspaces FOR SELECT TO ytriple_runtime
  USING (owner_subject = nullif(current_setting('ytriple.subject',true),''));
CREATE POLICY workspace_create ON ytriple.workspaces FOR INSERT TO ytriple_runtime
  WITH CHECK (owner_subject = nullif(current_setting('ytriple.subject',true),''));
CREATE POLICY workspace_update ON ytriple.workspaces FOR UPDATE TO ytriple_runtime
  USING (owner_subject = nullif(current_setting('ytriple.subject',true),''))
  WITH CHECK (owner_subject = nullif(current_setting('ytriple.subject',true),''));
CREATE POLICY receipt_read ON ytriple.command_receipts FOR SELECT TO ytriple_runtime
  USING (owner_subject = nullif(current_setting('ytriple.subject',true),''));
CREATE POLICY receipt_create ON ytriple.command_receipts FOR INSERT TO ytriple_runtime
  WITH CHECK (owner_subject = nullif(current_setting('ytriple.subject',true),''));
