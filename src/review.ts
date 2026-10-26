import { createAppStoreConnectClient, loadAscAuth, type AppStoreConnectClient } from "./asc.js";
import { createRequiresHuman, type RequiresHuman } from "./plan.js";

/**
 * App Review: read where each App Store version stands, decide what a state change should announce, and read App
 * Review's messages. State comes from the public App Store Connect API. Message text lives in Resolution Center,
 * which the public API does not expose (404 with an API key) and the web API refuses without a signed-in Apple ID
 * session (401), so `readReviewMessages` takes a caller-supplied authenticated GET instead of credentials.
 */
export type ReviewPlatform = "IOS" | "MAC_OS";

export const REVIEW_PLATFORMS: readonly ReviewPlatform[] = ["IOS", "MAC_OS"];
export const REJECTED_STATES: readonly string[] = ["REJECTED", "METADATA_REJECTED", "INVALID_BINARY"];
export const RELEASING_STATES: readonly string[] = ["PENDING_APPLE_RELEASE", "PROCESSING_FOR_APP_STORE", "ACCEPTED"];
export const LIVE_STATES: readonly string[] = ["READY_FOR_SALE", "READY_FOR_DISTRIBUTION"];

export interface ReviewVersionStatus {
  platform: ReviewPlatform;
  version: string;
  state: string;
  releaseType?: string;
}

export interface ReviewSubmissionStatus {
  id: string;
  platform: ReviewPlatform;
  state: string;
  submittedDate?: string;
}

export interface ReviewStatus {
  appId: string;
  versions: ReviewVersionStatus[];
  submissions: ReviewSubmissionStatus[];
}

export type ReviewAnnouncementKind = "rejected" | "approved" | "releasing" | "live" | "in-review" | "waiting" | "changed";

export interface ReviewAnnouncement {
  kind: ReviewAnnouncementKind;
  message: string;
  /** True when the version is live, so a tracking issue or alert can close. */
  close: boolean;
}

export async function readReviewStatus(
  client: AppStoreConnectClient,
  input: { bundleId: string; platforms?: readonly ReviewPlatform[] }
): Promise<ReviewStatus> {
  const apps = dataOf(await client.get("/v1/apps", { "filter[bundleId]": input.bundleId }));
  const app = apps[0];
  if (!app) {
    throw new Error(`No App Store Connect app has bundle ID ${input.bundleId}`);
  }
  const appId = String(app.id);
  const versions: ReviewVersionStatus[] = [];
  const submissions: ReviewSubmissionStatus[] = [];
  for (const platform of input.platforms ?? REVIEW_PLATFORMS) {
    const rawVersions = dataOf(await client.get(`/v1/apps/${appId}/appStoreVersions`, { "filter[platform]": platform, limit: "200" }));
    for (const raw of rawVersions) {
      const attributes = attributesOf(raw);
      const releaseType = stringOf(attributes.releaseType);
      versions.push({
        platform,
        version: stringOf(attributes.versionString) ?? "",
        state: stringOf(attributes.appStoreState) ?? stringOf(attributes.appVersionState) ?? "UNKNOWN",
        ...(releaseType ? { releaseType } : {})
      });
    }
    const rawSubmissions = dataOf(await client.get("/v1/reviewSubmissions", { "filter[app]": appId, "filter[platform]": platform, limit: "20" }));
    for (const raw of rawSubmissions) {
      const attributes = attributesOf(raw);
      const submittedDate = stringOf(attributes.submittedDate);
      submissions.push({
        id: String(raw.id),
        platform,
        state: stringOf(attributes.state) ?? "UNKNOWN",
        ...(submittedDate ? { submittedDate } : {})
      });
    }
  }
  return { appId, versions, submissions };
}

/** Reads review status with the API key in a kit config file. */
export async function readReviewStatusFromConfig(input: {
  configPath: string;
  bundleId: string;
  platforms?: readonly ReviewPlatform[];
  fetch?: typeof fetch;
}): Promise<ReviewStatus> {
  const client = createAppStoreConnectClient({ auth: await loadAscAuth(input.configPath), ...(input.fetch ? { fetch: input.fetch } : {}) });
  return readReviewStatus(client, { bundleId: input.bundleId, ...(input.platforms ? { platforms: input.platforms } : {}) });
}

/** Pure decision: what to announce when a version moves from `previous` (undefined when never seen) to `current`. */
export function reviewTransition(previous: string | undefined, current: string, label: string): ReviewAnnouncement | null {
  if (previous === current) {
    return null;
  }
  if (REJECTED_STATES.includes(current)) {
    return { kind: "rejected", close: false, message: `${label} was rejected by App Review (${current}). Read the reason, fix it and resubmit.` };
  }
  if (current === "PENDING_DEVELOPER_RELEASE") {
    return { kind: "approved", close: false, message: `${label} passed App Review and waits for a manual release.` };
  }
  if (RELEASING_STATES.includes(current)) {
    return { kind: "releasing", close: false, message: `${label} passed App Review and Apple is releasing it (${current}).` };
  }
  if (LIVE_STATES.includes(current)) {
    return { kind: "live", close: true, message: `${label} is live on the App Store.` };
  }
  if (current === "IN_REVIEW") {
    return { kind: "in-review", close: false, message: `${label} is in review.` };
  }
  if (current === "WAITING_FOR_REVIEW") {
    const again = previous !== undefined && REJECTED_STATES.includes(previous) ? " again after a resubmission" : "";
    return { kind: "waiting", close: false, message: `${label} is waiting for review${again}.` };
  }
  return { kind: "changed", close: false, message: `${label} changed from ${previous ?? "unknown"} to ${current}.` };
}

/** App Review writes messages as HTML. Returns readable text with paragraph and list breaks kept. */
export function reviewHtmlToText(html: string): string {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'", apos: "'", nbsp: " " };
  return html
    .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/div>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, name: string) => entities[name]!)
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * An authenticated GET against https://appstoreconnect.apple.com made by the caller, typically `fetch` run inside a
 * signed-in App Store Connect browser page with `credentials: "include"`. The kit never receives the session itself.
 */
export type ReviewWebGet = (path: string) => Promise<{ status: number; body: unknown }>;

export interface ReviewMessage {
  threadId: string;
  createdDate?: string;
  text: string;
}

export type ReviewMessagesResult =
  | { ok: true; messages: ReviewMessage[]; rejections: unknown[] }
  | { ok: false; status: number; requiresHuman: RequiresHuman };

export async function readReviewMessages(
  get: ReviewWebGet,
  input: { appId: string; submissionId?: string }
): Promise<ReviewMessagesResult> {
  const threadsPath = input.submissionId
    ? `/iris/v1/resolutionCenterThreads?filter[reviewSubmission]=${encodeURIComponent(input.submissionId)}`
    : `/iris/v1/apps/${encodeURIComponent(input.appId)}/resolutionCenterThreads`;
  const threads = await get(threadsPath);
  if (threads.status !== 200) {
    return { ok: false, status: threads.status, requiresHuman: signInRequired(threads.status) };
  }
  const messages: ReviewMessage[] = [];
  const rejections: unknown[] = [];
  for (const thread of dataOf(threads.body)) {
    const threadId = String(thread.id);
    const page = await get(`/iris/v1/resolutionCenterThreads/${encodeURIComponent(threadId)}/resolutionCenterMessages?include=fromActor,rejections`);
    if (page.status !== 200) {
      return { ok: false, status: page.status, requiresHuman: signInRequired(page.status) };
    }
    for (const message of dataOf(page.body)) {
      const attributes = attributesOf(message);
      const createdDate = stringOf(attributes.createdDate);
      messages.push({ threadId, ...(createdDate ? { createdDate } : {}), text: reviewHtmlToText(stringOf(attributes.messageBody) ?? "") });
    }
    for (const included of includedOf(page.body)) {
      if (included.type === "reviewRejections") {
        rejections.push(included.attributes);
      }
    }
  }
  return { ok: true, messages, rejections };
}

function signInRequired(status: number): RequiresHuman {
  return createRequiresHuman({
    code: "app_store_connect_web_session_required",
    message: `App Store Connect answered HTTP ${status}. Reading App Review messages needs a signed-in Apple ID web session; ask the operator to sign in to App Store Connect in their browser, then retry.`,
    url: "https://appstoreconnect.apple.com/"
  });
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordsAt(body: unknown, key: string): JsonRecord[] {
  const value = isRecord(body) ? body[key] : undefined;
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function dataOf(body: unknown): JsonRecord[] {
  return recordsAt(body, "data");
}

function includedOf(body: unknown): JsonRecord[] {
  return recordsAt(body, "included");
}

function attributesOf(record: JsonRecord): JsonRecord {
  return isRecord(record.attributes) ? record.attributes : {};
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
