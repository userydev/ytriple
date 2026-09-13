export const editorialEditionMigration = {
  version: 13,
  name: "editorial-edition",
  sql: `CREATE TABLE editorial_edition (
    tenant_id uuid NOT NULL REFERENCES tenant(id),
    input_hash text NOT NULL,
    body jsonb,
    model text NOT NULL,
    attempted_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz,
    PRIMARY KEY (tenant_id,input_hash)
  );
  CREATE INDEX editorial_edition_latest ON editorial_edition(tenant_id,published_at DESC) WHERE body IS NOT NULL;`,
} as const;
