export const changeNotificationsMigration = {
  version: 5,
  name: "notify committed source changes",
  sql: String.raw`
CREATE OR REPLACE FUNCTION notify_ytriple_source_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify('ytriple_source_changes_v1', NEW.tenant_id::text);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS delivery_change_notify ON delivery_change;
CREATE TRIGGER delivery_change_notify
AFTER INSERT ON delivery_change
FOR EACH ROW
EXECUTE FUNCTION notify_ytriple_source_change();
`,
} as const;
