import type { Command } from "../core/commands";
import type { Snapshot } from "../core/types";
declare global {
  interface Window {
    ytriple: {
      command: (input: Command) => Promise<unknown>;
      subscribe: (callback: (snapshot: Snapshot) => void) => () => void;
    };
  }
}
export async function command<T = void>(input: Command) {
  try {
    return (await window.ytriple.command(input)) as T;
  } catch (error) {
    if (error instanceof Error)
      throw new Error(
        error.message.replace(
          /^Error invoking remote method '[^']+': (?:Error: )?/,
          "",
        ),
      );
    throw error;
  }
}
