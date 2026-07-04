import type { AppStoreConnectClient } from "./asc.js";
import { createAppStoreConnectClient, loadAscAuth } from "./asc.js";
import type { AppleDistributionManifest, DistributionChannel, TestFlightGroup } from "./manifest.js";
import type { ReconcileBlocker } from "./reconcile.js";
import { redactSecrets } from "./redaction.js";

export interface TestFlightRequest {
  method: "POST" | "PATCH";
  path: string;
  body: Record<string, unknown>;
}

export interface TestFlightRequestInput {
  appId: string;
  buildId: string;
  buildBetaDetailId?: string;
  betaAppReviewDetailId?: string;
  groupIdsByName?: Record<string, string>;
  manifest: AppleDistributionManifest;
  channelId: string;
}

export interface TestFlightPlanAction {
  type:
    | "upload-testflight-build"
    | "wait-for-processed-build"
    | "set-build-export-compliance"
    | "ensure-beta-app-localization"
    | "configure-beta-groups"
    | "attach-build-to-beta-groups"
    | "set-beta-build-test-info"
    | "configure-beta-review-detail"
    | "submit-external-beta-review"
    | "notify-beta-testers";
  channelId: string;
  platform: "IOS";
  groupCount?: number;
  externalGroupCount?: number;
  locale?: string;
}

export interface TestFlightSubmissionPlan {
  ok: true;
  actions: TestFlightPlanAction[];
  blockers: ReconcileBlocker[];
}

export interface TestFlightPublishResult {
  ok: true;
  results: unknown[];
}

export async function publishTestFlightRequests(input: {
  configPath: string;
  requests: TestFlightRequest[];
  fetch?: typeof fetch;
  now?: Date;
}): Promise<TestFlightPublishResult> {
  const auth = await loadAscAuth(input.configPath);
  const client = createAppStoreConnectClient({
    auth,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.now ? { now: input.now } : {})
  });
  return executeTestFlightRequests({ client, requests: input.requests });
}

export async function executeTestFlightRequests(input: {
  client: AppStoreConnectClient;
  requests: TestFlightRequest[];
}): Promise<TestFlightPublishResult> {
  const results = [];
  for (const request of input.requests) {
    results.push(
      await input.client.request({
        method: request.method,
        path: request.path,
        body: request.body
      })
    );
  }
  return { ok: true, results: redactSecrets(results) };
}

export function planTestFlightSubmission(input: {
  manifest: AppleDistributionManifest;
  channelId: string;
}): TestFlightSubmissionPlan {
  const channel = requireTestFlightChannel(input.manifest, input.channelId);
  const testflight = channel.testflight!;
  const blockers: ReconcileBlocker[] = [];
  const groups = testflight.groups ?? [];
  const externalGroups = groups.filter((group) => group.type === "external");
  const locale = input.manifest.app.primaryLocale ?? "en-US";
  const privacyPolicyUrl = testflight.betaApp?.privacyPolicyUrl ?? channel.store?.privacy?.policyUrl;

  if (groups.length === 0) {
    blockers.push({
      code: "testflight-groups-required",
      message: "Declare at least one TestFlight beta group before publishing.",
      evidence: { channelId: input.channelId }
    });
  }
  if (!testflight.build?.whatsNew) {
    blockers.push({
      code: "testflight-whats-new-required",
      message: "TestFlight builds need tester-facing what-to-test notes.",
      evidence: { channelId: input.channelId, locale }
    });
  }
  if (!privacyPolicyUrl) {
    blockers.push({
      code: "testflight-privacy-policy-required",
      message: "TestFlight beta app metadata needs a privacy policy URL.",
      evidence: { channelId: input.channelId }
    });
  }
  if (!channel.store?.exportCompliance) {
    blockers.push({
      code: "export-compliance-required",
      message: "Export compliance metadata is required before TestFlight distribution.",
      evidence: { channelId: input.channelId }
    });
  }
  if (!input.manifest.team.providerPublicId) {
    blockers.push({
      code: "provider-public-id-required",
      message: "Add providerPublicId to the manifest so upload commands can disambiguate the Apple provider.",
      evidence: { teamId: input.manifest.team.teamId }
    });
  }
  if (externalGroups.length > 0) {
    const review = testflight.betaReview;
    const missingFields = ["contactFirstName", "contactLastName", "contactPhone", "contactEmail"].filter(
      (field) => !nonEmptyString(review?.[field as keyof typeof review])
    );
    if (missingFields.length > 0) {
      blockers.push({
        code: "beta-review-contact-required",
        message: "External TestFlight groups require beta review contact details.",
        evidence: { channelId: input.channelId, missingFields }
      });
    }
    if (review?.demoAccountRequired === true && (!review.demoAccountName || !review.demoAccountPassword)) {
      blockers.push({
        code: "beta-review-demo-account-required",
        message: "Beta review demo credentials are required when demoAccountRequired is true.",
        evidence: { channelId: input.channelId }
      });
    }
  }

  const ready = blockers.length === 0;
  return {
    ok: true,
    actions: ready
      ? [
          { type: "upload-testflight-build", channelId: input.channelId, platform: "IOS" },
          { type: "wait-for-processed-build", channelId: input.channelId, platform: "IOS" },
          { type: "set-build-export-compliance", channelId: input.channelId, platform: "IOS" },
          { type: "ensure-beta-app-localization", channelId: input.channelId, platform: "IOS", locale },
          { type: "configure-beta-groups", channelId: input.channelId, platform: "IOS", groupCount: groups.length },
          { type: "attach-build-to-beta-groups", channelId: input.channelId, platform: "IOS", groupCount: groups.length },
          { type: "set-beta-build-test-info", channelId: input.channelId, platform: "IOS", locale },
          ...(externalGroups.length > 0
            ? [
                {
                  type: "configure-beta-review-detail" as const,
                  channelId: input.channelId,
                  platform: "IOS" as const,
                  externalGroupCount: externalGroups.length
                },
                {
                  type: "submit-external-beta-review" as const,
                  channelId: input.channelId,
                  platform: "IOS" as const,
                  externalGroupCount: externalGroups.length
                }
              ]
            : []),
          ...(testflight.build?.notifyTesters
            ? [{ type: "notify-beta-testers" as const, channelId: input.channelId, platform: "IOS" as const }]
            : [])
        ]
      : [],
    blockers
  };
}

export function buildTestFlightRequests(input: TestFlightRequestInput): TestFlightRequest[] {
  const channel = requireTestFlightChannel(input.manifest, input.channelId);
  const testflight = channel.testflight!;
  const locale = input.manifest.app.primaryLocale ?? "en-US";
  const privacyPolicyUrl = testflight.betaApp?.privacyPolicyUrl ?? channel.store?.privacy?.policyUrl;
  const externalGroups = testflight.groups.filter((group) => group.type === "external");
  const requests: TestFlightRequest[] = [];
  const exportCompliance = channel.store?.exportCompliance;

  if (exportCompliance) {
    requests.push({
      method: "PATCH",
      path: `/v1/builds/${encodeURIComponent(input.buildId)}`,
      body: {
        data: {
          type: "builds",
          id: input.buildId,
          attributes: {
            usesNonExemptEncryption: exportCompliance.usesEncryption && !exportCompliance.exempt
          }
        }
      }
    });
  }

  if (testflight.betaApp || privacyPolicyUrl) {
    requests.push({
      method: "POST",
      path: "/v1/betaAppLocalizations",
      body: {
        data: {
          type: "betaAppLocalizations",
          attributes: compact({
            locale,
            description: testflight.betaApp?.description,
            feedbackEmail: testflight.betaApp?.feedbackEmail,
            marketingUrl: testflight.betaApp?.marketingUrl,
            privacyPolicyUrl
          }),
          relationships: { app: { data: { type: "apps", id: input.appId } } }
        }
      }
    });
  }

  for (const group of testflight.groups) {
    const groupId = input.groupIdsByName?.[group.name];
    if (groupId) {
      requests.push({
        method: "POST",
        path: `/v1/betaGroups/${encodeURIComponent(groupId)}/relationships/builds`,
        body: { data: [{ type: "builds", id: input.buildId }] }
      });
    } else {
      requests.push(createBetaGroupRequest({ group, appId: input.appId, buildId: input.buildId }));
    }
  }

  if (testflight.build?.whatsNew) {
    requests.push({
      method: "POST",
      path: "/v1/betaBuildLocalizations",
      body: {
        data: {
          type: "betaBuildLocalizations",
          attributes: { locale, whatsNew: testflight.build.whatsNew },
          relationships: { build: { data: { type: "builds", id: input.buildId } } }
        }
      }
    });
  }

  if (testflight.build?.autoNotifyEnabled !== undefined) {
    if (!input.buildBetaDetailId) {
      throw new Error("buildBetaDetailId is required when testflight.build.autoNotifyEnabled is set");
    }
    requests.push({
      method: "PATCH",
      path: `/v1/buildBetaDetails/${encodeURIComponent(input.buildBetaDetailId)}`,
      body: {
        data: {
          type: "buildBetaDetails",
          id: input.buildBetaDetailId,
          attributes: { autoNotifyEnabled: testflight.build.autoNotifyEnabled }
        }
      }
    });
  }

  if (externalGroups.length > 0 && testflight.betaReview) {
    if (!input.betaAppReviewDetailId) {
      throw new Error("betaAppReviewDetailId is required for external TestFlight beta review details");
    }
    requests.push({
      method: "PATCH",
      path: `/v1/betaAppReviewDetails/${encodeURIComponent(input.betaAppReviewDetailId)}`,
      body: {
        data: {
          type: "betaAppReviewDetails",
          id: input.betaAppReviewDetailId,
          attributes: compact({
            contactFirstName: testflight.betaReview.contactFirstName,
            contactLastName: testflight.betaReview.contactLastName,
            contactPhone: testflight.betaReview.contactPhone,
            contactEmail: testflight.betaReview.contactEmail,
            demoAccountName: testflight.betaReview.demoAccountName,
            demoAccountPassword: testflight.betaReview.demoAccountPassword,
            demoAccountRequired: testflight.betaReview.demoAccountRequired,
            notes: testflight.betaReview.notes
          })
        }
      }
    });
    requests.push({
      method: "POST",
      path: "/v1/betaAppReviewSubmissions",
      body: {
        data: {
          type: "betaAppReviewSubmissions",
          relationships: { build: { data: { type: "builds", id: input.buildId } } }
        }
      }
    });
  }

  if (testflight.build?.notifyTesters) {
    requests.push({
      method: "POST",
      path: "/v1/buildBetaNotifications",
      body: {
        data: {
          type: "buildBetaNotifications",
          relationships: { build: { data: { type: "builds", id: input.buildId } } }
        }
      }
    });
  }

  return requests;
}

function createBetaGroupRequest(input: { group: TestFlightGroup; appId: string; buildId: string }): TestFlightRequest {
  return {
    method: "POST",
    path: "/v1/betaGroups",
    body: {
      data: {
        type: "betaGroups",
        attributes: compact({
          name: input.group.name,
          isInternalGroup: input.group.type === undefined ? undefined : input.group.type === "internal",
          hasAccessToAllBuilds: input.group.hasAccessToAllBuilds,
          publicLinkEnabled: input.group.publicLinkEnabled,
          publicLinkLimitEnabled: input.group.publicLinkLimitEnabled,
          publicLinkLimit: input.group.publicLinkLimit,
          feedbackEnabled: input.group.feedbackEnabled
        }),
        relationships: {
          app: { data: { type: "apps", id: input.appId } },
          builds: { data: [{ type: "builds", id: input.buildId }] }
        }
      }
    }
  };
}

function requireTestFlightChannel(manifest: AppleDistributionManifest, channelId: string): DistributionChannel {
  const channel = manifest.channels.find((candidate) => candidate.id === channelId);
  if (!channel || channel.distribution !== "testflight" || !channel.testflight) {
    throw new Error(`TestFlight channel not found or incomplete: ${channelId}`);
  }
  return channel;
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}
