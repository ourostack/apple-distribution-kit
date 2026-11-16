// The X-ray's guard: exits 0 only when the App Store Connect base URL is the loopback mock, which proves it is a mock.
const base = process.env.APPLE_DISTRIBUTION_ASC_BASE_URL;
if (!base) {
  process.stderr.write("assert-mock: APPLE_DISTRIBUTION_ASC_BASE_URL is not set\n");
  process.exit(1);
}
const url = new URL(base);
if (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") {
  process.stderr.write(`assert-mock: ${url.hostname} is not loopback\n`);
  process.exit(1);
}
const response = await fetch(new URL("/__mock", url)).catch(() => null);
const body = response?.ok ? await response.json().catch(() => null) : null;
if (body?.mock !== true) {
  process.stderr.write("assert-mock: no mock answers at the base URL\n");
  process.exit(1);
}
process.stdout.write("assert-mock: the base URL is the loopback mock\n");
