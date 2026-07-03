import type { AppleDistributionManifest, DistributionKind } from "./manifest.js";

export type PlanMode = "dry-run" | "apply";

export interface RequiresHumanInput {
  code: string;
  message: string;
  url?: string;
  evidence?: Record<string, unknown>;
}

export interface RequiresHuman extends RequiresHumanInput {
  type: "requiresHuman";
}

export interface PlanAction {
  type: "validate-channel";
  channelId: string;
  distribution: DistributionKind;
}

export interface DistributionPlan {
  ok: true;
  mode: PlanMode;
  app: {
    name: string;
    bundleId: string;
  };
  actions: PlanAction[];
  requiresHuman: RequiresHuman[];
}

export function createPlan(input: { manifest: AppleDistributionManifest; mode: PlanMode }): DistributionPlan {
  return {
    ok: true,
    mode: input.mode,
    app: {
      name: input.manifest.app.name,
      bundleId: input.manifest.app.bundleId
    },
    actions: input.manifest.channels.map((channel) => ({
      type: "validate-channel",
      channelId: channel.id,
      distribution: channel.distribution
    })),
    requiresHuman: []
  };
}

export function createRequiresHuman(input: RequiresHumanInput): RequiresHuman {
  return {
    type: "requiresHuman",
    ...input
  };
}
