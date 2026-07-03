import type { AppleDistributionManifest, DistributionChannel, DistributionKind } from "./manifest.js";

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
  type:
    | "validate-channel"
    | "build-channel"
    | "package-channel"
    | "validate-app-store-package"
    | "upload-app-store-package"
    | "prepare-app-review"
    | "sign-notarize-direct-download"
    | "publish-direct-download"
    | "upload-testflight-build";
  channelId: string;
  distribution: DistributionKind;
  command?: string;
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
    actions: input.manifest.channels.flatMap((channel) => planChannelActions(channel)),
    requiresHuman: []
  };
}

export function createRequiresHuman(input: RequiresHumanInput): RequiresHuman {
  return {
    type: "requiresHuman",
    ...input
  };
}

function planChannelActions(channel: DistributionChannel): PlanAction[] {
  const actions: PlanAction[] = [
    {
      type: "validate-channel",
      channelId: channel.id,
      distribution: channel.distribution
    },
    {
      type: "build-channel",
      channelId: channel.id,
      distribution: channel.distribution,
      command: channel.buildCommand
    },
    {
      type: "package-channel",
      channelId: channel.id,
      distribution: channel.distribution,
      command: channel.packageCommand
    }
  ];

  switch (channel.distribution) {
    case "app-store":
      actions.push(
        { type: "validate-app-store-package", channelId: channel.id, distribution: channel.distribution },
        { type: "upload-app-store-package", channelId: channel.id, distribution: channel.distribution },
        { type: "prepare-app-review", channelId: channel.id, distribution: channel.distribution }
      );
      break;
    case "developer-id":
      actions.push(
        { type: "sign-notarize-direct-download", channelId: channel.id, distribution: channel.distribution },
        { type: "publish-direct-download", channelId: channel.id, distribution: channel.distribution }
      );
      break;
    case "testflight":
      actions.push({ type: "upload-testflight-build", channelId: channel.id, distribution: channel.distribution });
      break;
  }

  return actions;
}
