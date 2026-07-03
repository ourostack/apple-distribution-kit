import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AppStoreConnectConfig {
  issuerId: string;
  keyId: string;
  privateKeyPath: string;
}

export interface ConfigDiscoveryOptions {
  explicitConfigPath?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
}

export function discoverConfigPath(options: ConfigDiscoveryOptions = {}): string {
  if (options.explicitConfigPath && options.explicitConfigPath.trim() !== "") {
    return options.explicitConfigPath;
  }

  const envPath = options.env?.APPLE_DISTRIBUTION_KIT_CONFIG;
  if (envPath && envPath.trim() !== "") {
    return envPath;
  }

  const home = options.homeDir ?? homedir();
  return join(home, "Library", "Application Support", "AppleDistributionKit", "app-store-connect", "config.json");
}

export async function loadConfig(path: string): Promise<AppStoreConnectConfig> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isConfig(parsed)) {
    throw new Error("Invalid App Store Connect config: expected issuerId, keyId, and privateKeyPath strings");
  }
  return parsed;
}

function isConfig(value: unknown): value is AppStoreConnectConfig {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.issuerId === "string" &&
    candidate.issuerId.trim() !== "" &&
    typeof candidate.keyId === "string" &&
    candidate.keyId.trim() !== "" &&
    typeof candidate.privateKeyPath === "string" &&
    candidate.privateKeyPath.trim() !== ""
  );
}
