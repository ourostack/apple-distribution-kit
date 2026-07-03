const jwtPattern = /\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const privateKeyPattern = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const authKeyFilePattern = /AuthKey_[A-Z0-9]+\.p8/g;

export function redactSecrets<T>(value: T): T {
  if (typeof value === "string") {
    return redactString(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        const redacted = redactSecrets(entry);
        return [key, secretKey(key) && redacted === entry ? "[REDACTED_SECRET]" : redacted];
      })
    ) as T;
  }
  return value;
}

function redactString(value: string): string {
  return value
    .replace(privateKeyPattern, "[REDACTED_PRIVATE_KEY]")
    .replace(jwtPattern, "[REDACTED_JWT]")
    .replace(authKeyFilePattern, "[REDACTED_AUTH_KEY_FILE]");
}

function secretKey(key: string): boolean {
  return /password|secret|token/i.test(key);
}
