/**
 * The four declarative degradation chains from the provider contract, plus
 * streaming. A degradation is never silent: adapters return it on every
 * `generate`, and the runtime bubbles each one into the event stream so the
 * user can see that, say, this research ran on an external search port rather
 * than native grounding.
 */
export type DegradationKind =
  | "structured_output"
  | "native_web_search"
  | "web_search_unavailable"
  | "tool_calling"
  | "context_overflow"
  | "streaming";

export interface Degradation {
  kind: DegradationKind;
  /** Declared capability the run wanted. */
  from: string;
  /** What it actually got. */
  to: string;
  detail: string;
}

export function describeDegradation(degradation: Degradation): string {
  return `${degradation.kind}: ${degradation.from} -> ${degradation.to} (${degradation.detail})`;
}
