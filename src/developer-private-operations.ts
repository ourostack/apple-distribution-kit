import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { assertDeveloperPlatform, checkDeveloperPrivateParents, DeveloperError, readDeveloperPrivateInput, writeDeveloperPrivateStore } from "./developer-session.js";
import { developerRecord as record } from "./developer-transport.js";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
export function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
}
export function directory(teamId: string, namespace = "developer-operations"): string {
  assertDeveloperPlatform();
  const base = join(homedir(), ".apple-distribution-kit");
  for (const dir of [base, join(base, namespace), join(base, namespace, teamId)]) {
    checkDeveloperPrivateParents(join(dir, "placeholder"), true);
  }
  return join(base, namespace, teamId);
}
export function saveOperation<T extends { operationId: string }>(dir: string, contents: T, replace: boolean): T & { integrity: string } {
  const value = { ...contents, integrity: digest(contents) };
  writeDeveloperPrivateStore(join(dir, `${contents.operationId}.json`), canonical(value), replace);
  return value;
}
export function allOperations<T extends { operationId: string; resource: string; planHash: string }>(
  dir: string, read: (file: string) => T
): T[] {
  const entries = readdirSync(dir);
  const files = entries.filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
  if (files.length > 10_000) throw new DeveloperError("invalid_operation");
  const ops = files.map(file => read(join(dir, file)));
  const indexes = entries.filter(name => /^[a-f0-9]{64}\.index\.json$/.test(name));
  if (indexes.length > 10_000) throw new DeveloperError("invalid_operation");
  for (const name of indexes) {
    const index = readDeveloperPrivateInput(join(dir, name));
    if (!record(index) || index.version !== 1 || !uuid(index.operationId) || !validHash(index.planHash) ||
      typeof index.resource !== "string" || !index.resource || index.resource.length > 300 ||
      /[\x00-\x1f\x7f]/.test(index.resource)) throw new DeveloperError("invalid_operation");
    const op = ops.find(o => o.operationId === index.operationId);
    if (!op || op.resource !== index.resource || op.planHash !== index.planHash ||
      name !== `${digest(index.resource)}.index.json` ||
      canonical(index) !== canonical({ version: 1, resource: op.resource, operationId: op.operationId, planHash: op.planHash })) {
      throw new DeveloperError("invalid_operation");
    }
  }
  return ops;
}
export async function safeBoundary<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (error instanceof DeveloperError) throw error;
    throw new DeveloperError("unsafe_session_store");
  }
}
