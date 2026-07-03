import type { AppleDistributionManifest } from "./manifest.js";
import { createRequiresHuman, type RequiresHuman } from "./plan.js";

export interface RemoteAppleState {
  bundleIds?: Array<{ identifier: string; platform: "MAC_OS" | "IOS" }>;
  certificates?: Array<{ certificateType: CertificateType }>;
  profiles?: Array<{ profileType: "MAC_APP_STORE" | "IOS_APP_STORE"; bundleId: string }>;
  apps?: Array<{ bundleId: string; id: string }>;
}

export type CertificateType = "MAC_APP_DISTRIBUTION" | "MAC_INSTALLER_DISTRIBUTION" | "DEVELOPER_ID_APPLICATION";

export type ReconcileAction =
  | { type: "create-bundle-id"; bundleId: string; platform: "MAC_OS" | "IOS" }
  | { type: "create-certificate"; certificateType: CertificateType }
  | { type: "create-profile"; profileType: "MAC_APP_STORE" | "IOS_APP_STORE"; bundleId: string }
  | { type: "delete-bundle-id"; identifier: string };

export interface ReconcileBlocker {
  code: string;
  message: string;
  evidence: Record<string, unknown>;
}

export interface ReconcileResult {
  ok: true;
  actions: ReconcileAction[];
  requiresHuman: RequiresHuman[];
  blockers: ReconcileBlocker[];
}

export interface ReconcileInput {
  manifest: AppleDistributionManifest;
  remoteState: RemoteAppleState;
  allowDestructiveAppleDelete?: boolean;
}

export function reconcileAppleState(input: ReconcileInput): ReconcileResult {
  const actions: ReconcileAction[] = [];
  const requiresHuman: RequiresHuman[] = [];
  const blockers: ReconcileBlocker[] = [];
  const desiredMacBundleIds = new Set<string>();

  for (const channel of input.manifest.channels) {
    if (channel.platform === "ios") {
      blockers.push({
        code: "ios-apply-not-supported",
        message: "iOS/TestFlight lanes are schema/dry-run only in this kit version.",
        evidence: { channelId: channel.id }
      });
      continue;
    }

    desiredMacBundleIds.add(channel.bundleId);
    if (!hasBundleId(input.remoteState, channel.bundleId, "MAC_OS")) {
      pushUnique(actions, { type: "create-bundle-id", bundleId: channel.bundleId, platform: "MAC_OS" });
    }

    if (channel.distribution === "app-store") {
      ensureCertificate(actions, input.remoteState, "MAC_APP_DISTRIBUTION");
      ensureCertificate(actions, input.remoteState, "MAC_INSTALLER_DISTRIBUTION");
      if (!hasProfile(input.remoteState, "MAC_APP_STORE", channel.bundleId)) {
        pushUnique(actions, { type: "create-profile", profileType: "MAC_APP_STORE", bundleId: channel.bundleId });
      }
      if (!hasApp(input.remoteState, channel.bundleId)) {
        requiresHuman.push(
          createRequiresHuman({
            code: "first-app-record-required",
            message: "Create the first app record in App Store Connect.",
            url: "https://appstoreconnect.apple.com/apps",
            evidence: { bundleId: channel.bundleId, sku: input.manifest.app.sku }
          })
        );
      }
    }

    if (channel.distribution === "developer-id") {
      ensureCertificate(actions, input.remoteState, "DEVELOPER_ID_APPLICATION");
    }
  }

  for (const remoteBundleId of input.remoteState.bundleIds ?? []) {
    if (remoteBundleId.platform === "MAC_OS" && !desiredMacBundleIds.has(remoteBundleId.identifier)) {
      if (input.allowDestructiveAppleDelete) {
        actions.push({ type: "delete-bundle-id", identifier: remoteBundleId.identifier });
      } else {
        blockers.push({
          code: "destructive-delete-requires-flag",
          message: "Remote Apple resources not present in the manifest require --allow-destructive-apple-delete.",
          evidence: { resourceType: "bundleId", identifier: remoteBundleId.identifier }
        });
      }
    }
  }

  return { ok: true, actions, requiresHuman, blockers };
}

function ensureCertificate(actions: ReconcileAction[], remoteState: RemoteAppleState, certificateType: CertificateType): void {
  if (!hasCertificate(remoteState, certificateType)) {
    pushUnique(actions, { type: "create-certificate", certificateType });
  }
}

function hasBundleId(remoteState: RemoteAppleState, identifier: string, platform: "MAC_OS" | "IOS"): boolean {
  return (remoteState.bundleIds ?? []).some((bundleId) => bundleId.identifier === identifier && bundleId.platform === platform);
}

function hasCertificate(remoteState: RemoteAppleState, certificateType: CertificateType): boolean {
  return (remoteState.certificates ?? []).some((certificate) => certificate.certificateType === certificateType);
}

function hasProfile(remoteState: RemoteAppleState, profileType: "MAC_APP_STORE" | "IOS_APP_STORE", bundleId: string): boolean {
  return (remoteState.profiles ?? []).some((profile) => profile.profileType === profileType && profile.bundleId === bundleId);
}

function hasApp(remoteState: RemoteAppleState, bundleId: string): boolean {
  return (remoteState.apps ?? []).some((app) => app.bundleId === bundleId);
}

function pushUnique(actions: ReconcileAction[], action: ReconcileAction): void {
  if (!actions.some((existing) => JSON.stringify(existing) === JSON.stringify(action))) {
    actions.push(action);
  }
}
