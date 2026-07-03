import { join } from "node:path";

export interface ManifestPathOptions {
  explicitManifestPath?: string;
  cwd: string;
}

export function resolveManifestPath(options: ManifestPathOptions): string {
  if (options.explicitManifestPath && options.explicitManifestPath.trim() !== "") {
    return options.explicitManifestPath;
  }
  return join(options.cwd, "distribution", "apple-distribution.json");
}
