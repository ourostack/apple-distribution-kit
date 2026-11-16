import { afterEach, describe, expect, it, vi } from "vitest";
import { ASC_BASE_URL_ENV, ascBaseUrl } from "../src/asc.js";
import { createCli } from "../src/cli-core.js";

describe("ascBaseUrl", () => {
  it("is Apple's default when no mock is set", () => {
    expect(ascBaseUrl({})).toBeUndefined();
    expect(ascBaseUrl({ [ASC_BASE_URL_ENV]: "" })).toBeUndefined();
  });

  it("accepts a loopback address, over http or https", () => {
    expect(ascBaseUrl({ [ASC_BASE_URL_ENV]: "http://127.0.0.1:4010" })).toBe("http://127.0.0.1:4010");
    expect(ascBaseUrl({ [ASC_BASE_URL_ENV]: "https://[::1]:4443" })).toBe("https://[::1]:4443");
  });

  it("refuses any other host, even one that looks local", () => {
    for (const value of ["https://api.appstoreconnect.apple.com", "http://localhost:4010", "http://10.0.0.5", "http://example.com"]) {
      expect(() => ascBaseUrl({ [ASC_BASE_URL_ENV]: value })).toThrow(/only a loopback address/);
    }
  });

  it("refuses a scheme that is neither http nor https", () => {
    expect(() => ascBaseUrl({ [ASC_BASE_URL_ENV]: "ftp://127.0.0.1" })).toThrow(/must be http or https/);
  });
});

describe("asc commands with a remote base URL", () => {
  afterEach(() => {
    delete process.env[ASC_BASE_URL_ENV];
    vi.restoreAllMocks();
  });

  it("refuses before any request is sent", async () => {
    process.env[ASC_BASE_URL_ENV] = "https://example.com";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const stderr: string[] = [];
    const cli = createCli({ stdout: () => undefined, stderr: (chunk) => stderr.push(chunk) });
    const code = await cli(["asc", "get", "--path", "/v1/apps", "--config", "/nonexistent-adk-config.json"]);
    expect(code).toBe(5);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stderr.join("")).toMatch(/only a loopback address/);
  });
});
