export type SourcePolicyAction =
  "source.create" | "source.refresh" | "source.read" | "content.read";

export type SourcePolicyInput = {
  tenantId: string;
  principalId: string;
  deviceId: string;
  action: SourcePolicyAction;
};

export interface SourcePolicy {
  allows(input: SourcePolicyInput): boolean | Promise<boolean>;
}

/** 4B self-host default. Hosted entitlements replace this through the same seam. */
export const allowAllSourcePolicy: SourcePolicy = {
  allows: () => true,
};
