ALTER TABLE ytriple.workspaces
  ADD COLUMN execution_token uuid,
  ADD COLUMN execution_epoch bigint NOT NULL DEFAULT 0 CHECK (execution_epoch >= 0),
  ADD COLUMN execution_until timestamptz,
  ADD CONSTRAINT execution_lease_pair CHECK ((execution_token IS NULL) = (execution_until IS NULL));
GRANT UPDATE(execution_token,execution_epoch,execution_until) ON ytriple.workspaces TO ytriple_runtime;
