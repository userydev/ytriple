import type { MemberView } from "./taskView.js";

/**
 * Three-bay layout, driven by team size rather than by fixed slots.
 *
 * The centre bay is always the orchestrator's shared chat. Contributors are
 * spread across the two side bays; once a bay holds more than one member it
 * splits into columns. A one-member team leaves the right bay out entirely,
 * which is why this returns the bays rather than a fixed left/right pair.
 */
export interface SideBay {
  id: "left" | "right";
  members: MemberView[];
  /** True when the bay holds more than one member and must split internally. */
  split: boolean;
}

export interface ThreeBayLayout {
  bays: SideBay[];
  totalMembers: number;
}

export function layoutMembers(members: readonly MemberView[]): ThreeBayLayout {
  if (members.length === 0) {
    return { bays: [], totalMembers: 0 };
  }
  if (members.length === 1) {
    return {
      bays: [{ id: "left", members: [...members], split: false }],
      totalMembers: 1,
    };
  }

  const leftCount = Math.ceil(members.length / 2);
  const left = members.slice(0, leftCount);
  const right = members.slice(leftCount);

  return {
    bays: [
      { id: "left", members: left, split: left.length > 1 },
      { id: "right", members: right, split: right.length > 1 },
    ],
    totalMembers: members.length,
  };
}
