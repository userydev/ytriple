export const editorialMigration = {
  version: 11,
  name: "editorial",
  sql: `
    CREATE TABLE editorial_issue (
      tenant_id uuid NOT NULL REFERENCES tenant(id),
      id uuid NOT NULL,
      issue_key text NOT NULL,
      focus text NOT NULL,
      latest_revision_id uuid,
      last_input_hash text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id,id),
      UNIQUE (tenant_id,issue_key)
    );
    CREATE TABLE editorial_revision (
      tenant_id uuid NOT NULL,
      id uuid NOT NULL,
      issue_id uuid NOT NULL,
      version integer NOT NULL CHECK (version > 0),
      body jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id,id),
      UNIQUE (tenant_id,issue_id,version),
      FOREIGN KEY (tenant_id,issue_id) REFERENCES editorial_issue(tenant_id,id)
    );
    CREATE TABLE editorial_correction (
      tenant_id uuid NOT NULL,
      id uuid NOT NULL,
      issue_id uuid NOT NULL,
      revision_id uuid NOT NULL,
      request_key text NOT NULL,
      text text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      response text,
      created_at timestamptz NOT NULL DEFAULT now(),
      reviewed_at timestamptz,
      PRIMARY KEY (tenant_id,id),
      UNIQUE (tenant_id,request_key),
      FOREIGN KEY (tenant_id,issue_id) REFERENCES editorial_issue(tenant_id,id),
      FOREIGN KEY (tenant_id,revision_id) REFERENCES editorial_revision(tenant_id,id)
    );
    CREATE TABLE editorial_run (
      tenant_id uuid NOT NULL REFERENCES tenant(id),
      focus text NOT NULL,
      input_hash text NOT NULL,
      completed_hash text,
      plan jsonb,
      attempted_at timestamptz NOT NULL DEFAULT now(),
      error text,
      PRIMARY KEY (tenant_id,focus)
    );
    CREATE INDEX editorial_issue_recent ON editorial_issue(tenant_id,updated_at DESC);
    CREATE INDEX editorial_correction_pending ON editorial_correction(tenant_id,issue_id) WHERE status='pending';
  `,
} as const;
