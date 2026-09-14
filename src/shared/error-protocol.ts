/**
 * Errors carrying this prefix are known to have happened before a run was
 * accepted. The prefix survives Error serialization across IPC and remote RPC.
 */
export const NOT_ACCEPTED_PREFIX = 'YTRIPLE_NOT_ACCEPTED:';
// Electron prefixes invoke errors before exposing them to the renderer. Match
// only our exact IPC envelope, never a marker mentioned in arbitrary prose.
const IPC_ERROR_PREFIX = "Error invoking remote method 'ytriple:request': Error: ";

function protocolMessage(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  return error.message.startsWith(IPC_ERROR_PREFIX)
    ? error.message.slice(IPC_ERROR_PREFIX.length)
    : error.message;
}

export function markNotAccepted(error: unknown): Error {
  if (isNotAcceptedError(error)) return error as Error;
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${NOT_ACCEPTED_PREFIX}${message}`);
}

export function isNotAcceptedError(error: unknown): boolean {
  return protocolMessage(error)?.startsWith(NOT_ACCEPTED_PREFIX) ?? false;
}

export function notAcceptedMessage(error: unknown): string | undefined {
  return isNotAcceptedError(error) ? protocolMessage(error)!.slice(NOT_ACCEPTED_PREFIX.length) : undefined;
}
