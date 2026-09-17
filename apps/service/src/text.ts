// PostgreSQL JSONB cannot represent NUL or unpaired UTF-16 surrogates.
// Reject these before committing any part of a product command.
export function validText(value: unknown): boolean {
  if (typeof value === "string")
    return (
      !value.includes("\0") &&
      Buffer.from(value, "utf8").toString("utf8") === value
    );
  if (Array.isArray(value)) return value.every(validText);
  if (value && typeof value === "object")
    return Object.values(value).every(validText);
  return true;
}
