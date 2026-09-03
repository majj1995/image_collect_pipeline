const sensitiveQueryKeys = new Set([
  "accesskey", "accesskeyid", "accesskeysecret", "accesstoken", "apikey", "auth", "authorization", "awsaccesskeyid", "clientsecret",
  "clienttoken", "cookie", "credential", "expires", "googleaccessid", "idtoken", "jwt", "key",
  "keypairid", "oauthsignature", "oauthtoken", "ossaccesskeyid", "password", "policy", "qak",
  "qheaderlist", "qkeytime", "qsignalgorithm", "qsignature", "qsigntime", "qurlparamlist", "refreshtoken", "se",
  "secret", "secretaccesskey", "securitytoken", "session", "sessionid", "sessiontoken", "sig", "signature", "ske", "skoid", "sks",
  "skt", "sktid", "skv", "sp", "spr", "sr", "st", "sv", "token", "xbceaccesskeyid", "xbcedate",
  "xbcesecuritytoken", "xbcesignature", "xcossecuritytoken", "xossaccesskeyid", "xossadditionalheaders",
  "xosscredential", "xossdate", "xossexpires", "xosssecuritytoken", "xosssignature", "xosssignatureversion",
  "xosssignedheaders"
]);

const signedQueryPrefixes = ["xamz", "xgoog", "oauth"];
const textAssignment = /([\p{L}\p{N}_.-]+(?:[ \t]+[\p{L}\p{N}_.-]+){0,4})\s*[:=]\s*[^,;\n\r]+/giu;
const unsafeTextLocation = /(?:https?:\/\/[^\s,;]*@[^\s,;]*|file:[^\s,;]*)/giu;
const unsafePosixPath = /(^|[\s("'`=:：])\/(?![\/\s])[^\s,;]+/gmu;
const unsafeWindowsPath = /(^|[\s("'`=:：])(?:[a-z]:[\\/](?![\\/\s])[^\s,;]+|\\\\(?![\\/\s])[^\s,;]+)/gimu;

export const MAX_PUBLIC_TEXT_LENGTH = 300;

function normalizeQueryKey(key: string): string {
  return key.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeQueryKey(key);
  return sensitiveQueryKeys.has(normalized) || signedQueryPrefixes.some((prefix) => normalized.startsWith(prefix));
}

function foldSecurityCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0)!;
    const fullwidthAlphaNumeric = code >= 0xff10 && code <= 0xff19 || code >= 0xff21 && code <= 0xff3a || code >= 0xff41 && code <= 0xff5a;
    const securityPunctuation = code === 0xff0d || code === 0xff0e || code === 0xff0f || code === 0xff1a || code === 0xff1d || code === 0xff20 || code === 0xff3c || code === 0xff3f;
    return fullwidthAlphaNumeric || securityPunctuation ? String.fromCodePoint(code - 0xfee0) : character;
  }).join("");
}

function sensitiveTermIndex(keySource: string): number {
  const terms = keySource.trim().split(/\s+/u);
  for (let index = 0; index < terms.length; index += 1) {
    if (!normalizeQueryKey(terms[index]!).length) continue;
    if (isSensitiveKey(terms.slice(index).join(" "))) return index;
  }
  return -1;
}

function redactSensitiveAssignments(value: string): string {
  return value.replace(textAssignment, (assignment, keySource: string) => {
    const terms = keySource.trim().split(/\s+/u);
    const index = sensitiveTermIndex(keySource);
    if (index >= 0) {
      const publicPrefix = terms.slice(0, index).join(" ");
      return `${publicPrefix ? `${publicPrefix} ` : ""}[REDACTED]`;
    }
    return assignment;
  });
}

function redactUnsafeTextLocations(value: string): string {
  return value
    .replace(unsafeTextLocation, "[REDACTED]")
    .replace(unsafePosixPath, (_match, prefix: string) => `${prefix}[REDACTED]`)
    .replace(unsafeWindowsPath, (_match, prefix: string) => `${prefix}[REDACTED]`);
}

/** Detects unsanitized credential assignments and local locations in serialized public metadata. */
export function containsUnsafePublicMetadata(value: unknown): boolean {
  if (typeof value !== "string" || !value) return false;
  const normalized = foldSecurityCharacters(value).replace(/[\p{Cc}\p{Cf}]+/gu, " ");
  let hasSensitiveAssignment = false;
  normalized.replace(textAssignment, (assignment, keySource: string) => {
    if (sensitiveTermIndex(keySource) >= 0) hasSensitiveAssignment = true;
    return assignment;
  });
  return hasSensitiveAssignment || redactUnsafeTextLocations(normalized) !== normalized;
}

/** Produces a display/export-safe public URL without changing benign resource identity. */
export function sanitizePublicHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveKey(key)) url.searchParams.delete(key);
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** Redacts credential-like assignments and bounds provider-controlled display text. */
export function sanitizePublicText(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = foldSecurityCharacters(value).replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!normalized) return null;
  const redacted = redactSensitiveAssignments(redactUnsafeTextLocations(normalized));
  return Array.from(redacted).slice(0, MAX_PUBLIC_TEXT_LENGTH).join("");
}

/** Sanitizes a provenance source that may be either a public URL or provider-controlled text. */
export function sanitizePublicSource(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = foldSecurityCharacters(value).trim();
  if (normalized.includes("://")) return sanitizePublicHttpUrl(normalized);
  try { new URL(normalized); return sanitizePublicHttpUrl(normalized); }
  catch { return sanitizePublicText(normalized); }
}
