import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { AppleDistributionManifest, DistributionChannel } from "./manifest.js";
import type { ReconcileBlocker } from "./reconcile.js";

export interface StoreRequest {
  method: "POST" | "PATCH";
  path: string;
  body: Record<string, unknown>;
}

export interface StoreRequestInput {
  appId: string;
  versionId: string;
  buildId: string;
  manifest: AppleDistributionManifest;
  channelId: string;
}

export interface StorePlanAction {
  type: "ensure-app-store-version" | "associate-processed-build" | "create-review-submission-record";
  version?: string;
  platform?: "MAC_OS";
}

export interface StoreSubmissionPlan {
  ok: true;
  actions: StorePlanAction[];
  blockers: ReconcileBlocker[];
}

export function buildStoreRequests(input: StoreRequestInput): StoreRequest[] {
  const channel = requireStoreChannel(input.manifest, input.channelId);
  const store = channel.store!;
  return [
    {
      method: "POST",
      path: "/v1/appStoreVersions",
      body: {
        data: {
          type: "appStoreVersions",
          attributes: { platform: "MAC_OS", versionString: store.version },
          relationships: { app: { data: { type: "apps", id: input.appId } } }
        }
      }
    },
    {
      method: "PATCH",
      path: `/v1/appStoreVersions/${input.versionId}`,
      body: {
        data: {
          type: "appStoreVersions",
          id: input.versionId,
          relationships: { build: { data: { type: "builds", id: input.buildId } } }
        }
      }
    },
    {
      method: "POST",
      path: "/v1/reviewSubmissions",
      body: {
        data: {
          type: "reviewSubmissions",
          relationships: { app: { data: { type: "apps", id: input.appId } } }
        }
      }
    }
  ];
}

export function planStoreSubmission(input: {
  manifest: AppleDistributionManifest;
  channelId: string;
  assetRoot?: string;
}): StoreSubmissionPlan {
  const channel = requireStoreChannel(input.manifest, input.channelId);
  const store = channel.store!;
  const blockers: ReconcileBlocker[] = [];
  const screenshots = store.screenshots ?? [];
  const appPreviews = store.appPreviews ?? [];
  const declaredAssets = [...screenshots, ...appPreviews];
  const missingAssets = declaredAssets.filter((asset) => !isRemoteStoreProof(asset) && !localAssetExists(asset, input.assetRoot));

  if (declaredAssets.length === 0) {
    blockers.push({
      code: "screenshots-assets-required",
      message: "Screenshots/app previews must exist locally or be proven present remotely before review submission.",
      evidence: { channelId: input.channelId }
    });
  }
  if (missingAssets.length > 0) {
    blockers.push({
      code: "store-assets-not-found",
      message: "Declared screenshots/app previews must exist locally or be represented by an explicit remote proof URI.",
      evidence: { channelId: input.channelId, missingAssets }
    });
  }
  if (!store.privacy) {
    blockers.push({
      code: "privacy-required",
      message: "Privacy metadata is required before review submission.",
      evidence: { channelId: input.channelId }
    });
  }
  if (!store.exportCompliance) {
    blockers.push({
      code: "export-compliance-required",
      message: "Export compliance metadata is required before review submission.",
      evidence: { channelId: input.channelId }
    });
  }

  const readyForReviewPrep = blockers.length === 0;
  if (readyForReviewPrep) {
    blockers.push({
      code: "localization-automation-required",
      message: "Localization metadata/update support must run before final App Review submission.",
      evidence: { channelId: input.channelId, locale: input.manifest.app.primaryLocale ?? "en-US" }
    });
    blockers.push({
      code: "review-submission-items-required",
      message: "Review submission items and final submit action must run after a processed build is selected.",
      evidence: { channelId: input.channelId }
    });
  }

  return {
    ok: true,
    actions:
      readyForReviewPrep
        ? [
            { type: "ensure-app-store-version", version: store.version, platform: "MAC_OS" },
            { type: "associate-processed-build" },
            { type: "create-review-submission-record" }
          ]
        : [],
    blockers
  };
}

function requireStoreChannel(manifest: AppleDistributionManifest, channelId: string): DistributionChannel {
  const channel = manifest.channels.find((candidate) => candidate.id === channelId);
  if (!channel || channel.distribution !== "app-store" || !channel.store) {
    throw new Error(`App Store channel not found or incomplete: ${channelId}`);
  }
  return channel;
}

function isRemoteStoreProof(asset: string): boolean {
  try {
    const url = new URL(asset);
    return ["asc:", "appstoreconnect:", "app-store-connect:"].includes(url.protocol) && url.hostname !== "";
  } catch {
    return false;
  }
}

function localAssetExists(asset: string, assetRoot?: string): boolean {
  const path = isAbsolute(asset) ? asset : join(assetRoot ?? process.cwd(), asset);
  return existsSync(path) && statSync(path).isFile();
}
