import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCli,
  buildExportOptions,
  c99ExtIdentifier,
  createSigningCertificate,
  defaultProfileInstallDirs,
  deleteSigningKeychain,
  ensureProvisioningProfiles,
  importSigningIdentity,
  isApiCreatedDevelopmentCertificate,
  normalizeSerial,
  parseIdentities,
  parseKeychainList,
  readPlistJson,
  renderSigningXcconfig,
  revokeApiDevelopmentCertificates,
  selectIdentity,
  SigningError,
  writePlist,
  type AppStoreConnectClient,
  type AppStoreConnectRequest,
  type RetryOptions,
  type RawCommandResult
} from "../src/index.js";

const fixturePem = readFileSync(new URL("./signing-fixture-cert.pem", import.meta.url), "utf8");
const fixtureSha1 = "0206966BD9C839443B7B2618B4299BE07E922BC7";
const fixtureSerial = "ABCDEF0123";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "adk-signing-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const ok = (stdout = ""): RawCommandResult => ({ exitCode: 0, stdout, stderr: "" });

function fakeExec(handler: (argv: string[]) => RawCommandResult | void = () => undefined) {
  const calls: string[][] = [];
  const exec = async (argv: string[]) => {
    calls.push(argv);
    return handler(argv) ?? ok();
  };
  return { calls, exec };
}

type Route = (request: AppStoreConnectRequest) => unknown;

function fakeClient(routes: Record<string, Route | unknown>) {
  const requests: AppStoreConnectRequest[] = [];
  const handle = async (request: AppStoreConnectRequest) => {
    requests.push(request);
    const key = `${request.method} ${request.path}`;
    if (!(key in routes)) {
      throw new Error(`unexpected ${key}`);
    }
    const route = routes[key];
    return typeof route === "function" ? (route as Route)(request) : route;
  };
  const client: AppStoreConnectClient = {
    get: (path, query = {}) => handle({ method: "GET", path, query }),
    request: handle
  };
  return { client, requests };
}

function identityStdout(sha1 = fixtureSha1) {
  return `  1) ${sha1} "Apple Distribution: Fixture (TEAM123456)"\n     1 valid identities found\n`;
}

const distributionCertificate = {
  id: "CERT1",
  attributes: {
    certificateType: "DISTRIBUTION",
    name: "Apple Distribution: Fixture",
    serialNumber: "00abcdef0123",
    expirationDate: "2027-10-09T00:00:00.000+00:00"
  }
};

describe("signing paths and parsing", () => {
  it("defaults profile install dirs under the home directory", () => {
    expect(defaultProfileInstallDirs("/Users/ci")).toEqual([
      "/Users/ci/Library/MobileDevice/Provisioning Profiles",
      "/Users/ci/Library/Developer/Xcode/UserData/Provisioning Profiles"
    ]);
    expect(defaultProfileInstallDirs()[0]).toBe(join(homedir(), "Library", "MobileDevice", "Provisioning Profiles"));
  });

  it("parses keychain search lists", () => {
    expect(parseKeychainList('    "/a/login.keychain-db"\n    "/b/x.keychain-db"\n\n')).toEqual(["/a/login.keychain-db", "/b/x.keychain-db"]);
  });

  it("joins find-identity output with certificate PEMs", () => {
    expect(parseIdentities(identityStdout(), fixturePem)).toEqual([
      {
        sha1: fixtureSha1,
        name: "Apple Distribution: Fixture (TEAM123456)",
        serialNumber: fixtureSerial,
        notAfter: "2126-09-15T04:22:33.000Z"
      }
    ]);
    expect(parseIdentities(identityStdout("F".repeat(40)), fixturePem)).toEqual([]);
    expect(parseIdentities(identityStdout(), "")).toEqual([]);
  });

  it("normalizes certificate serials", () => {
    expect(normalizeSerial("00:ab:CD:01")).toBe("ABCD01");
    expect(normalizeSerial("000")).toBe("0");
  });

  it("selects one identity", () => {
    const identity = { sha1: fixtureSha1, name: "n", serialNumber: "1", notAfter: "t" };
    const state = { keychainPath: "/k", identities: [identity] };
    expect(selectIdentity(state)).toBe(identity);
    expect(selectIdentity(state, fixtureSha1.toLowerCase())).toBe(identity);
    expect(() => selectIdentity(state, "AA")).toThrow("No imported identity has SHA-1 AA.");
    expect(() => selectIdentity({ keychainPath: "/k", identities: [identity, identity] })).toThrow(
      "Expected one imported identity, found 2; pass --identity-sha1."
    );
  });

  it("matches Xcode c99extidentifier", () => {
    expect(c99ExtIdentifier("app.spoonjoy.cook-timer-widget")).toBe("app_spoonjoy_cook_timer_widget");
    expect(c99ExtIdentifier("9app")).toBe("_9app");
  });
});

describe("createSigningCertificate", () => {
  it("creates a certificate, packs a p12 and truncates every intermediate file", async () => {
    const outDir = join(await makeTempDir(), "cert");
    const { calls, exec } = fakeExec((argv) => {
      if (argv[1] === "req") {
        writeFileSync(argv[argv.length - 1]!, "-----BEGIN CERTIFICATE REQUEST-----\nCSR\n-----END CERTIFICATE REQUEST-----\n");
      }
      if (argv[1] === "pkcs12") {
        writeFileSync(argv[8]!, Buffer.from("p12-bytes"));
      }
    });
    const { client, requests } = fakeClient({
      "POST /v1/certificates": { data: { ...distributionCertificate, attributes: { ...distributionCertificate.attributes, certificateContent: Buffer.from("der").toString("base64") } } }
    });
    const created = await createSigningCertificate({ client, exec, outDir, random: (size) => Buffer.alloc(size, 1) });

    expect(created).toEqual({
      id: "CERT1",
      certificateType: "DISTRIBUTION",
      name: "Apple Distribution: Fixture",
      serialNumber: fixtureSerial,
      expirationDate: "2027-10-09T00:00:00.000+00:00",
      p12Base64Path: join(outDir, "certificate.p12.base64"),
      passwordPath: join(outDir, "certificate.password")
    });
    expect(calls.map((argv) => argv.slice(0, 2))).toEqual([
      ["openssl", "genrsa"],
      ["openssl", "req"],
      ["openssl", "x509"],
      ["openssl", "pkcs12"]
    ]);
    expect(calls[1]).toContain("/CN=apple-distribution-kit CI");
    expect(calls[3]).toContain(`file:${join(outDir, "certificate.password")}`);
    expect(requests[0]!.body).toEqual({
      data: {
        type: "certificates",
        attributes: { certificateType: "DISTRIBUTION", csrContent: expect.stringContaining("CERTIFICATE REQUEST") }
      }
    });
    expect(await readFile(created.p12Base64Path, "utf8")).toBe(Buffer.from("p12-bytes").toString("base64"));
    expect(await readFile(created.passwordPath, "utf8")).toBe(Buffer.alloc(24, 1).toString("base64url"));
    expect(((await stat(created.passwordPath)).mode & 0o777).toString(8)).toBe("600");
    for (const name of ["private-key.pem", "request.csr", "certificate.der", "certificate.pem", "certificate.p12"]) {
      expect(await readFile(join(outDir, name), "utf8")).toBe("");
    }
  });

  it("honors custom openssl, type and common name, and truncates on failure", async () => {
    const outDir = join(await makeTempDir(), "cert");
    const { calls, exec } = fakeExec((argv) => {
      if (argv[1] === "genrsa") {
        writeFileSync(argv[3]!, "PRIVATE");
      }
      if (argv[1] === "req") {
        return { exitCode: 1, stdout: "", stderr: "bad subject\nmore" };
      }
    });
    const { client } = fakeClient({});
    await expect(
      createSigningCertificate({ client, exec, outDir, openssl: "/usr/bin/openssl", certificateType: "IOS_DISTRIBUTION", commonName: "X" })
    ).rejects.toThrow("/usr/bin/openssl req exited 1: bad subject");
    expect(calls[1]).toContain("/CN=X");
    expect(await readFile(join(outDir, "private-key.pem"), "utf8")).toBe("");
    expect((await readFile(join(outDir, "certificate.password"), "utf8")).length).toBeGreaterThan(20);
  });

  it("rejects a response without certificate content", async () => {
    const outDir = join(await makeTempDir(), "cert");
    const { exec } = fakeExec();
    const { client } = fakeClient({ "POST /v1/certificates": { data: { id: "X", attributes: {} } } });
    await expect(createSigningCertificate({ client, exec, outDir })).rejects.toThrow("App Store Connect response is missing certificateContent.");
  });
});

describe("importSigningIdentity", () => {
  it("creates an unlocked keychain, imports the p12, and prepends it to the search list", async () => {
    const dir = await makeTempDir();
    const keychainPath = join(dir, "kc", "ci.keychain-db");
    let importedBytes = "";
    const { calls, exec } = fakeExec((argv) => {
      if (argv[1] === "import") {
        importedBytes = readFileSync(argv[2]!, "utf8");
      }
      if (argv[1] === "list-keychains" && argv.length === 4) {
        return ok(`    "${keychainPath}"\n    "/Users/ci/login.keychain-db"\n`);
      }
      if (argv[1] === "find-identity") {
        return ok(identityStdout());
      }
      if (argv[1] === "find-certificate") {
        return ok(fixturePem);
      }
    });
    const state = await importSigningIdentity({
      exec,
      p12Base64: Buffer.from("p12").toString("base64").replace(/(.{2})/, "$1\n"),
      p12Password: "pw",
      keychainPath,
      random: (size) => Buffer.alloc(size, 2)
    });

    expect(importedBytes).toBe("p12");
    expect(readFileSync(`${keychainPath}.import.p12`, "utf8")).toBe("");
    expect(state).toEqual({
      keychainPath,
      identities: [expect.objectContaining({ sha1: fixtureSha1, serialNumber: fixtureSerial })]
    });
    const keychainPassword = Buffer.alloc(24, 2).toString("base64url");
    expect(calls).toEqual([
      ["security", "create-keychain", "-p", keychainPassword, keychainPath],
      ["security", "set-keychain-settings", "-lut", "21600", keychainPath],
      ["security", "unlock-keychain", "-p", keychainPassword, keychainPath],
      ["security", "import", `${keychainPath}.import.p12`, "-k", keychainPath, "-P", "pw", "-f", "pkcs12", "-T", "/usr/bin/codesign", "-T", "/usr/bin/security", "-T", "/usr/bin/productbuild"],
      ["security", "set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", keychainPassword, keychainPath],
      ["security", "list-keychains", "-d", "user"],
      ["security", "list-keychains", "-d", "user", "-s", keychainPath, "/Users/ci/login.keychain-db"],
      ["security", "find-identity", "-v", "-p", "codesigning", keychainPath],
      ["security", "find-certificate", "-a", "-p", keychainPath]
    ]);
  });

  it("never names passwords when a security command fails, and truncates the p12", async () => {
    const dir = await makeTempDir();
    const keychainPath = join(dir, "ci.keychain-db");
    const { exec } = fakeExec((argv) => (argv[1] === "import" ? { exitCode: 1, stdout: "", stderr: "" } : undefined));
    const error = await importSigningIdentity({ exec, p12Base64: "cDEy", p12Password: "secret-pw", keychainPath }).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(SigningError);
    expect((error as Error).message).toBe("security import exited 1");
    expect((error as Error).message).not.toContain("secret-pw");
    expect(readFileSync(`${keychainPath}.import.p12`, "utf8")).toBe("");
  });

  it("uses stdout as failure detail when stderr is empty", async () => {
    const dir = await makeTempDir();
    const { exec } = fakeExec((argv) => (argv[1] === "create-keychain" ? { exitCode: 48, stdout: "exists", stderr: "" } : undefined));
    await expect(importSigningIdentity({ exec, p12Base64: "cDEy", p12Password: "pw", keychainPath: join(dir, "k") })).rejects.toThrow(
      "security create-keychain exited 48: exists"
    );
  });

  it("rejects empty secrets and p12s without an identity", async () => {
    const dir = await makeTempDir();
    const { exec } = fakeExec();
    await expect(importSigningIdentity({ exec, p12Base64: "", p12Password: "pw", keychainPath: join(dir, "k") })).rejects.toThrow(
      "The signing certificate secret is empty or not base64."
    );
    await expect(importSigningIdentity({ exec, p12Base64: "cDEy", p12Password: "pw", keychainPath: join(dir, "k") })).rejects.toThrow(
      "The imported p12 did not produce a valid code signing identity."
    );
  });

  it("deletes the keychain", async () => {
    const { calls, exec } = fakeExec();
    await deleteSigningKeychain({ exec, keychainPath: "/tmp/k" });
    expect(calls).toEqual([["security", "delete-keychain", "/tmp/k"]]);
  });
});

function profile(id: string, name: string, state: string, expirationDate: string, content: string | null = "cHJvZmlsZQ==") {
  return {
    id,
    attributes: { name, profileState: state, expirationDate, uuid: `uuid-${id}`, ...(content ? { profileContent: content } : {}) }
  };
}

describe("ensureProvisioningProfiles", () => {
  const now = new Date("2026-10-09T00:00:00Z");
  const bundles = { data: [{ id: "B0", attributes: { identifier: "app.example.other" } }, { id: "B1", attributes: { identifier: "app.example" } }] };

  it("reuses an active profile with GET requests only and installs it", async () => {
    const dir = await makeTempDir();
    const name = "ADK CI app.example CERT1";
    const { client, requests } = fakeClient({
      "GET /v1/certificates": { data: [{ id: "OTHER", attributes: {} }], links: { next: "https://api.example/v1/certificates?cursor=2" } },
      "GET https://api.example/v1/certificates?cursor=2": { data: [distributionCertificate] },
      "GET /v1/bundleIds": bundles,
      "GET /v1/profiles": {
        data: [
          profile("P0", `${name} copy`, "ACTIVE", "2027-10-09T00:00:00Z"),
          profile("P1", name, "ACTIVE", "2027-10-09T00:00:00Z"),
          profile("P2", name, "ACTIVE", "2027-10-09T00:00:00Z")
        ]
      }
    });
    const result = await ensureProvisioningProfiles({
      client,
      certificateSerial: fixtureSerial,
      bundleIdentifiers: ["app.example"],
      installDirs: [join(dir, "a"), join(dir, "b")],
      now
    });

    expect(requests.every((request) => request.method === "GET")).toBe(true);
    expect(requests[3]!.query).toEqual({ "filter[name]": name, "filter[profileType]": "IOS_APP_STORE", limit: "200" });
    expect(result).toEqual({
      certificate: expect.objectContaining({ id: "CERT1", serialNumber: fixtureSerial }),
      deletedProfileIds: [],
      profiles: [
        {
          bundleIdentifier: "app.example",
          name,
          uuid: "uuid-P1",
          id: "P1",
          profileType: "IOS_APP_STORE",
          expirationDate: "2027-10-09T00:00:00Z",
          created: false,
          paths: [join(dir, "a", "uuid-P1.mobileprovision"), join(dir, "b", "uuid-P1.mobileprovision")]
        }
      ]
    });
    expect(readFileSync(join(dir, "b", "uuid-P1.mobileprovision"), "utf8")).toBe("profile");
  });

  it("deletes stale kit profiles and creates a fresh one", async () => {
    const dir = await makeTempDir();
    const name = "Kit app.example CERT1";
    const { client, requests } = fakeClient({
      "GET /v1/certificates": { data: [distributionCertificate] },
      "GET /v1/bundleIds": bundles,
      "GET /v1/profiles": {
        data: [
          profile("OLD1", name, "INVALID", "2027-10-09T00:00:00Z"),
          profile("OLD2", name, "ACTIVE", "2026-10-10T00:00:00Z"),
          profile("OLD3", name, "ACTIVE", "2027-10-09T00:00:00Z", null)
        ]
      },
      "DELETE /v1/profiles/OLD1": null,
      "DELETE /v1/profiles/OLD2": null,
      "DELETE /v1/profiles/OLD3": null,
      "POST /v1/profiles": { data: profile("NEW", name, "ACTIVE", "2027-10-09T00:00:00Z") }
    });
    const result = await ensureProvisioningProfiles({
      client,
      certificateSerial: fixtureSerial,
      bundleIdentifiers: ["app.example"],
      installDirs: [dir],
      profileType: "IOS_APP_STORE",
      namePrefix: "Kit",
      minimumValidityDays: 7,
      now
    });

    expect(result.deletedProfileIds).toEqual(["OLD1", "OLD2", "OLD3"]);
    expect(result.profiles[0]).toEqual(expect.objectContaining({ id: "NEW", created: true }));
    expect(requests.at(-1)!.body).toEqual({
      data: {
        type: "profiles",
        attributes: { name, profileType: "IOS_APP_STORE" },
        relationships: {
          bundleId: { data: { type: "bundleIds", id: "B1" } },
          certificates: { data: [{ type: "certificates", id: "CERT1" }] }
        }
      }
    });
  });

  it("explains a revoked certificate, a missing bundle ID and malformed responses", async () => {
    const base = { certificateSerial: fixtureSerial, bundleIdentifiers: ["app.example"], installDirs: [] as string[] };
    await expect(
      ensureProvisioningProfiles({ ...base, client: fakeClient({ "GET /v1/certificates": { data: [] } }).client })
    ).rejects.toThrow(/No App Store Connect certificate has serial ABCDEF0123/);
    await expect(
      ensureProvisioningProfiles({
        ...base,
        client: fakeClient({ "GET /v1/certificates": { data: [distributionCertificate] }, "GET /v1/bundleIds": { data: [] } }).client
      })
    ).rejects.toThrow("No App Store Connect bundle ID is registered for app.example.");
    await expect(
      ensureProvisioningProfiles({ ...base, client: fakeClient({ "GET /v1/certificates": { data: {} } }).client })
    ).rejects.toThrow("App Store Connect GET /v1/certificates did not return a data array.");
    await expect(ensureProvisioningProfiles({ ...base, client: fakeClient({ "GET /v1/certificates": [] }).client })).rejects.toThrow(
      "Expected a JSON object."
    );
  });

  it("uses the current time by default", async () => {
    const { client } = fakeClient({
      "GET /v1/certificates": { data: [distributionCertificate] },
      "GET /v1/bundleIds": bundles,
      "GET /v1/profiles": { data: [profile("P1", "ADK CI app.example CERT1", "ACTIVE", "2999-01-01T00:00:00Z")] }
    });
    const result = await ensureProvisioningProfiles({ client, certificateSerial: fixtureSerial, bundleIdentifiers: ["app.example"], installDirs: [] });
    expect(result.profiles[0]!.paths).toEqual([]);
  });
});

describe("signing settings", () => {
  const identity = { sha1: fixtureSha1, name: "n", serialNumber: "1", notAfter: "t" };
  const profiles = [
    { bundleIdentifier: "app.example", name: "ADK CI app.example C" },
    { bundleIdentifier: "app.example.widget-ext", name: "ADK CI app.example.widget-ext C" }
  ];

  it("renders a per-target manual signing xcconfig", () => {
    expect(renderSigningXcconfig({ teamId: "TEAM", identity, keychainPath: "/k/ci.keychain-db", profiles })).toBe(
      [
        "// Generated by apple-distribution-kit signing profiles. Do not commit.",
        "CODE_SIGN_STYLE = Manual",
        "DEVELOPMENT_TEAM = TEAM",
        `CODE_SIGN_IDENTITY = ${fixtureSha1}`,
        'OTHER_CODE_SIGN_FLAGS = $(inherited) --keychain "/k/ci.keychain-db"',
        "ADK_PROFILE_app_example = ADK CI app.example C",
        "ADK_PROFILE_app_example_widget_ext = ADK CI app.example.widget-ext C",
        "PROVISIONING_PROFILE_SPECIFIER = $(ADK_PROFILE_$(PRODUCT_BUNDLE_IDENTIFIER:c99extidentifier))",
        ""
      ].join("\n")
    );
  });

  it("builds manual export options over a base plist", () => {
    expect(buildExportOptions({ base: { method: "app-store-connect", signingStyle: "automatic", uploadSymbols: true }, teamId: "TEAM", identity, profiles })).toEqual({
      method: "app-store-connect",
      uploadSymbols: true,
      signingStyle: "manual",
      teamID: "TEAM",
      signingCertificate: fixtureSha1,
      provisioningProfiles: { "app.example": "ADK CI app.example C", "app.example.widget-ext": "ADK CI app.example.widget-ext C" }
    });
  });

  it("reads and writes plists through plutil", async () => {
    const dir = await makeTempDir();
    const { calls, exec } = fakeExec((argv) => (argv[2] === "json" ? ok('{"method":"app-store-connect"}') : undefined));
    expect(await readPlistJson(exec, "/base.plist")).toEqual({ method: "app-store-connect" });
    await writePlist(exec, join(dir, "out", "ExportOptions.plist"), { a: 1 });
    expect(JSON.parse(await readFile(join(dir, "out", "ExportOptions.plist"), "utf8"))).toEqual({ a: 1 });
    expect(calls).toEqual([
      ["plutil", "-convert", "json", "-o", "-", "/base.plist"],
      ["plutil", "-convert", "xml1", join(dir, "out", "ExportOptions.plist")]
    ]);
  });
});

describe("revokeApiDevelopmentCertificates", () => {
  const apiCreated = { id: "DEV1", attributes: { certificateType: "DEVELOPMENT", name: "Apple Development: Created via API", displayName: "Created via API", expirationDate: "2027-01-01" } };
  const person = { id: "DEV2", attributes: { certificateType: "DEVELOPMENT", name: "Apple Development: Ari", expirationDate: "2027-01-01" } };
  const apiDistribution = { id: "DIS1", attributes: { certificateType: "DISTRIBUTION", name: "Created via API", expirationDate: "2027-01-01" } };
  const unnamed = { id: "X", attributes: { certificateType: "DEVELOPMENT" } };

  it("revokes only development certificates created via API", async () => {
    const { client, requests } = fakeClient({
      "GET /v1/certificates": { data: [apiCreated, person, apiDistribution, unnamed] },
      "DELETE /v1/certificates/DEV1": null
    });
    const result = await revokeApiDevelopmentCertificates({ client });
    expect(result.revoked.map((certificate) => certificate.id)).toEqual(["DEV1"]);
    expect(result.kept.map((certificate) => certificate.id)).toEqual(["DEV2", "DIS1", "X"]);
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual(["GET /v1/certificates", "DELETE /v1/certificates/DEV1"]);
    expect(result.lines[0]).toBe("Found 4 certificate(s); 1 created via API and eligible for revocation.");
    expect(result.lines).toContain('revoked: id=DEV1 type=DEVELOPMENT name="Created via API" serial= expires=2027-01-01');
    expect(result.lines.at(-1)).toBe("Revoked 1 certificate(s).");
  });

  it("dry-runs without deleting", async () => {
    const { client, requests } = fakeClient({ "GET /v1/certificates": { data: [apiCreated] } });
    const result = await revokeApiDevelopmentCertificates({ client, dryRun: true });
    expect(requests).toHaveLength(1);
    expect(result.lines.slice(1)).toEqual(['would revoke: id=DEV1 type=DEVELOPMENT name="Created via API" serial= expires=2027-01-01', "Revoked 0 certificate(s) (dry run)."]);
  });

  it("says so when there is nothing to revoke", async () => {
    const { client } = fakeClient({ "GET /v1/certificates": { data: [person] } });
    const result = await revokeApiDevelopmentCertificates({ client });
    expect(result.lines.at(-1)).toBe('Nothing to revoke: no "Created via API" development certificates exist.');
    expect(isApiCreatedDevelopmentCertificate(result.kept[0]!)).toBe(false);
  });
});

describe("signing CLI", () => {
  function cli(options: { client?: AppStoreConnectClient; exec?: (argv: string[]) => Promise<RawCommandResult>; env?: Record<string, string>; homeDir?: string; sleep?: (ms: number) => Promise<void>; onClient?: (configPath: string, retry: RetryOptions) => void }) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const run = createCli(
      { stdout: (chunk) => stdout.push(chunk), stderr: (chunk) => stderr.push(chunk) },
      {
        signing: {
          exec: options.exec ?? fakeExec().exec,
          env: options.env ?? {},
          ...(options.homeDir ? { homeDir: options.homeDir } : {}),
          ...(options.sleep ? { sleep: options.sleep } : {}),
          createClient: async (configPath, retry) => {
            options.onClient?.(configPath, retry);
            return options.client ?? fakeClient({}).client;
          }
        }
      }
    );
    return { run, stdout, stderr };
  }

  const certificateExec = () =>
    fakeExec((argv) => {
      if (argv[1] === "pkcs12") {
        writeFileSync(argv[8]!, Buffer.from("p12"));
      }
    }).exec;
  const createdClient = () =>
    fakeClient({
      "POST /v1/certificates": { data: { ...distributionCertificate, attributes: { ...distributionCertificate.attributes, certificateContent: "ZGVy" } } }
    }).client;

  it("creates a certificate without printing secrets", async () => {
    const dir = await makeTempDir();
    const text = cli({ client: createdClient(), exec: certificateExec() });
    expect(await text.run(["signing", "create-certificate", "--out-dir", join(dir, "a"), "--openssl", "/usr/bin/openssl", "--certificate-type", "DISTRIBUTION", "--common-name", "CI"])).toBe(0);
    expect(text.stdout.join("")).toContain("Created certificate id=CERT1 type=DISTRIBUTION");
    expect(text.stdout.join("")).toContain("as APPLE_DISTRIBUTION_CERTIFICATE_P12_BASE64 and");
    const password = readFileSync(join(dir, "a", "certificate.password"), "utf8");
    expect(text.stdout.join("")).not.toContain(password);

    const json = cli({ client: createdClient(), exec: certificateExec() });
    expect(await json.run(["signing", "create-certificate", "--out-dir", join(dir, "b"), "--json"])).toBe(0);
    expect(JSON.parse(json.stdout.join("")).certificate.id).toBe("CERT1");
  });

  it("imports from named environment variables and writes state", async () => {
    const dir = await makeTempDir();
    const exec = fakeExec((argv) => {
      if (argv[1] === "find-identity") {
        return ok(identityStdout());
      }
      if (argv[1] === "find-certificate") {
        return ok(fixturePem);
      }
    }).exec;
    const env = { APPLE_DISTRIBUTION_CERTIFICATE_P12_BASE64: "cDEy", APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD: "pw", CUSTOM: "cDEy", CUSTOM_PW: "pw" };
    const text = cli({ exec, env });
    expect(await text.run(["signing", "import", "--keychain", join(dir, "k"), "--state", join(dir, "s", "state.json")])).toBe(0);
    expect(text.stdout.join("")).toContain("Imported 1 signing identity(ies)");
    expect(text.stdout.join("")).toContain(`sha1=${fixtureSha1} serial=${fixtureSerial}`);
    expect(JSON.parse(readFileSync(join(dir, "s", "state.json"), "utf8")).identities[0].sha1).toBe(fixtureSha1);

    const json = cli({ exec, env });
    expect(await json.run(["signing", "import", "--keychain", join(dir, "k2"), "--state", join(dir, "s2.json"), "--p12-base64-env", "CUSTOM", "--password-env", "CUSTOM_PW", "--json"])).toBe(0);
    expect(JSON.parse(json.stdout.join("")).state.keychainPath).toBe(join(dir, "k2"));

    const missing = cli({ env: { APPLE_DISTRIBUTION_CERTIFICATE_P12_BASE64: "x" } });
    expect(await missing.run(["signing", "import", "--keychain", "k", "--state", "s"])).toBe(64);
    expect(missing.stderr.join("")).toBe("Missing signing secret environment variable(s): APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD\n");
  });

  it("installs profiles and writes signing settings", async () => {
    const dir = await makeTempDir();
    const statePath = join(dir, "state.json");
    writeFileSync(statePath, JSON.stringify({ keychainPath: "/k", identities: [{ sha1: fixtureSha1, name: "n", serialNumber: fixtureSerial, notAfter: "t" }] }));
    const routes = {
      "GET /v1/certificates": { data: [distributionCertificate] },
      "GET /v1/bundleIds": { data: [{ id: "B1", attributes: { identifier: "app.example" } }] },
      "GET /v1/profiles": { data: [profile("OLD", "ADK CI app.example CERT1", "INVALID", "2027-01-01T00:00:00Z")] },
      "DELETE /v1/profiles/OLD": null,
      "POST /v1/profiles": { data: profile("NEW", "ADK CI app.example CERT1", "ACTIVE", "2027-10-09T00:00:00Z") }
    };
    const exec = fakeExec((argv) => (argv[2] === "json" ? ok('{"method":"app-store-connect","uploadSymbols":true}') : undefined));
    const text = cli({ client: fakeClient(routes).client, exec: exec.exec, homeDir: dir });
    const args = ["signing", "profiles", "--state", statePath, "--team-id", "TEAM", "--bundle-id", "app.example", "--xcconfig", join(dir, "x", "signing.xcconfig"), "--export-options", join(dir, "x", "ExportOptions.plist")];
    expect(await text.run([...args, "--export-options-base", "/base.plist"])).toBe(0);
    expect(text.stdout.join("")).toContain('profile created: "ADK CI app.example CERT1" bundle=app.example uuid=uuid-NEW');
    expect(text.stdout.join("")).toContain("deleted stale kit profile: OLD");
    expect(text.stdout.join("")).toContain("xcodebuild needs no -allowProvisioningUpdates");
    expect(readFileSync(join(dir, "x", "signing.xcconfig"), "utf8")).toContain("ADK_PROFILE_app_example = ADK CI app.example CERT1");
    expect(JSON.parse(readFileSync(join(dir, "x", "ExportOptions.plist"), "utf8"))).toEqual(expect.objectContaining({ uploadSymbols: true, signingStyle: "manual" }));
    expect(readFileSync(join(dir, "Library", "MobileDevice", "Provisioning Profiles", "uuid-NEW.mobileprovision"), "utf8")).toBe("profile");

    const json = cli({ client: fakeClient(routes).client, exec: exec.exec });
    expect(
      await json.run([...args, "--install-dir", join(dir, "p"), "--profile-type", "IOS_APP_STORE", "--name-prefix", "ADK CI", "--identity-sha1", fixtureSha1, "--json"])
    ).toBe(0);
    expect(JSON.parse(json.stdout.join(""))).toEqual(expect.objectContaining({ ok: true, deletedProfileIds: ["OLD"] }));
    expect(JSON.parse(readFileSync(join(dir, "x", "ExportOptions.plist"), "utf8")).method).toBe("app-store-connect");

    const reused = cli({
      client: fakeClient({ ...routes, "GET /v1/profiles": { data: [profile("CUR", "ADK CI app.example CERT1", "ACTIVE", "2999-01-01T00:00:00Z")] } }).client,
      exec: exec.exec,
      homeDir: dir,
      sleep: async () => undefined
    });
    expect(await reused.run(args)).toBe(0);
    expect(reused.stdout.join("")).toContain('profile reused: "ADK CI app.example CERT1"');

    const noBundle = cli({});
    expect(await noBundle.run(["signing", "profiles", "--state", statePath, "--team-id", "T", "--xcconfig", "x", "--export-options", "e"])).toBe(64);
    expect(noBundle.stderr.join("")).toBe("signing profiles requires at least one --bundle-id\n");
  });

  it("deletes the keychain", async () => {
    const { calls, exec } = fakeExec();
    const text = cli({ exec });
    expect(await text.run(["signing", "delete-keychain", "--keychain", "/tmp/k"])).toBe(0);
    expect(text.stdout.join("")).toBe("Deleted keychain /tmp/k\n");
    const json = cli({ exec });
    expect(await json.run(["signing", "delete-keychain", "--keychain", "/tmp/k", "--json"])).toBe(0);
    expect(JSON.parse(json.stdout.join(""))).toEqual({ ok: true, keychainPath: "/tmp/k" });
    expect(calls).toHaveLength(2);
  });

  it("runs the revoke safety net with retries and a clear empty result", async () => {
    const seen: Array<{ configPath: string; retry: RetryOptions }> = [];
    const text = cli({
      client: fakeClient({ "GET /v1/certificates": { data: [] } }).client,
      env: { APPLE_DISTRIBUTION_KIT_CONFIG: "/env/config.json" },
      onClient: (configPath, retry) => seen.push({ configPath, retry })
    });
    expect(await text.run(["signing", "revoke-api-certificates", "--dry-run"])).toBe(0);
    expect(text.stdout.join("")).toBe('Found 0 certificate(s); 0 created via API and eligible for revocation.\nNothing to revoke: no "Created via API" development certificates exist.\n');
    expect(seen[0]!.configPath).toBe("/env/config.json");
    expect(seen[0]!.retry.attempts).toBe(4);
    seen[0]!.retry.onRetry!({ method: "GET", path: "/v1/certificates", attempt: 1, delayMs: 2000, reason: "fetch failed: The network connection was lost." });
    expect(text.stderr.join("")).toBe("App Store Connect GET /v1/certificates failed (fetch failed: The network connection was lost.); retry 1/3 in 2000ms\n");

    const json = cli({ client: fakeClient({ "GET /v1/certificates": { data: [] } }).client, onClient: (configPath, retry) => seen.push({ configPath, retry }) });
    expect(await json.run(["signing", "revoke-api-certificates", "--json", "--retries", "2", "--config", "/c.json"])).toBe(0);
    expect(JSON.parse(json.stdout.join("")).found).toBe(0);
    expect(seen[1]).toEqual(expect.objectContaining({ configPath: "/c.json", retry: expect.objectContaining({ attempts: 2 }) }));
  });

  it("downgrades revoke failures in best-effort mode only", async () => {
    const failing = { get: async () => Promise.reject(new Error("HTTP 500")), request: async () => null } as AppStoreConnectClient;
    const best = cli({ client: failing });
    expect(await best.run(["signing", "revoke-api-certificates", "--best-effort"])).toBe(0);
    expect(best.stderr.join("")).toBe("signing revoke-api-certificates warning: HTTP 500\n");
    const strict = cli({ client: failing });
    expect(await strict.run(["signing", "revoke-api-certificates", "--json"])).toBe(69);
    expect(JSON.parse(strict.stdout.join(""))).toEqual({ ok: false, error: { code: "signing_failed", message: "HTTP 500" } });
  });

  it("rejects bad input", async () => {
    const unknown = cli({});
    expect(await unknown.run(["signing", "nope", "--json"])).toBe(64);
    expect(JSON.parse(unknown.stdout.join("")).error.code).toBe("unknown_command");
    const missing = cli({});
    expect(await missing.run(["signing", "delete-keychain", "--json"])).toBe(64);
    expect(JSON.parse(missing.stdout.join("")).error).toEqual({ code: "missing_option", message: "signing delete-keychain requires --keychain" });
    for (const retries of ["0", "11", "x"]) {
      const bad = cli({});
      expect(await bad.run(["signing", "revoke-api-certificates", "--retries", retries])).toBe(64);
      expect(bad.stderr.join("")).toBe(`--retries must be an integer from 1 to 10, got: ${retries}\n`);
    }
  });

  it("uses the real App Store Connect client and command runner by default", async () => {
    const dir = await makeTempDir();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const run = createCli({ stdout: (chunk) => stdout.push(chunk), stderr: (chunk) => stderr.push(chunk) });
    expect(await run(["signing", "revoke-api-certificates", "--config", join(dir, "missing.json")])).toBe(69);
    expect(stderr.join("")).toContain("missing.json");
    const withExecutor = createCli(
      { stdout: (chunk) => stdout.push(chunk), stderr: (chunk) => stderr.push(chunk) },
      { executeXcodeCommand: async () => ({ exitCode: 1, stdout: "", stderr: "no keychain" }) }
    );
    expect(await withExecutor(["signing", "delete-keychain", "--keychain", "/tmp/none"])).toBe(69);
    expect(stderr.join("")).toContain("security delete-keychain exited 1: no keychain");
  });
});
