export const editorialPresentationMigration = {
  version: 12,
  name: "editorial-presentation",
  sql: `
    CREATE TABLE editorial_presentation (
      tenant_id uuid NOT NULL,
      revision_id uuid NOT NULL,
      body jsonb,
      model text NOT NULL,
      attempted_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id,revision_id),
      FOREIGN KEY (tenant_id,revision_id) REFERENCES editorial_revision(tenant_id,id)
    );
  `,
} as const;
