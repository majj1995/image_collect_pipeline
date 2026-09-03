import type { ProviderSearchRequest } from "./types.js";
import { ProviderError } from "./types.js";
import { sanitizePublicHttpUrl } from "../../shared/public-url.js";

type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function safeHttpUrl(value: unknown): string | null {
  return sanitizePublicHttpUrl(value);
}

export function safeUrlHostname(value: unknown): string | null {
  const sanitized = safeHttpUrl(value);
  return sanitized ? new URL(sanitized).hostname : null;
}

function providerStatus(value: unknown): number | null {
  const numeric = numberValue(value);
  if (numeric === null || !Number.isInteger(numeric)) return null;
  if (numeric >= 100 && numeric <= 599) return numeric;
  if (numeric >= 10_000 && numeric <= 59_999) return Math.floor(numeric / 100);
  return null;
}

export function providerEnvelopeError(provider: string, code: unknown): ProviderError {
  const status = providerStatus(code);
  return new ProviderError(provider, status, status !== null && isRetryableProviderStatus(status));
}

export function isDataForSeoSuccess(code: unknown): boolean {
  const numeric = numberValue(code);
  return numeric !== null && Number.isInteger(numeric) && numeric >= 20_000 && numeric < 30_000;
}

export function isRetryableProviderStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export async function releaseFailedResponse(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    try { await response.arrayBuffer(); } catch { /* the connection is already unusable */ }
  }
}

function retryAfterMilliseconds(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return null;
  return Math.max(0, retryAt - Date.now());
}

export async function requestJson(
  provider: string,
  fetchImpl: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: RequestInit
): Promise<JsonRecord> {
  const rethrowAbortOrTimeout = (error: unknown): void => {
    const reason = init.signal?.aborted ? init.signal.reason : undefined;
    if (reason instanceof Error && (reason.name === "TimeoutError" || reason.name === "AbortError")) throw reason;
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw error;
  };
  let response: Response;
  try {
    response = await fetchImpl(input, init);
  } catch (error) {
    rethrowAbortOrTimeout(error);
    throw new ProviderError(provider, null, true);
  }
  if (!response.ok) {
    const retryAfterMs = retryAfterMilliseconds(response.headers.get("retry-after"));
    await releaseFailedResponse(response);
    throw new ProviderError(provider, response.status, isRetryableProviderStatus(response.status), retryAfterMs);
  }
  try {
    const body: unknown = await response.json();
    if (!isRecord(body)) throw new Error("invalid response");
    return body;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    rethrowAbortOrTimeout(error);
    throw new ProviderError(provider, error instanceof TypeError ? null : response.status, error instanceof TypeError);
  }
}

export interface LocaleOptions {
  language: string;
  country: string;
  locationName: string;
}

export function localeOptions(locale: string): LocaleOptions {
  const [rawLanguage = "en", rawCountry = "US"] = locale.split("-");
  const language = /^[a-z]{2,3}$/iu.test(rawLanguage) ? rawLanguage.toLowerCase() : "en";
  const country = /^[a-z]{2}$/iu.test(rawCountry) ? rawCountry.toUpperCase() : "US";
  let locationName: string | undefined;
  try { locationName = new Intl.DisplayNames(["en"], { type: "region" }).of(country); }
  catch { locationName = undefined; }
  return { language, country, locationName: locationName ?? country };
}

export function cappedCount(request: ProviderSearchRequest, maxResults: number): number {
  const count = Number.isFinite(request.count) ? Math.floor(request.count) : 1;
  const maximum = Number.isFinite(maxResults) ? Math.floor(maxResults) : 1;
  return Math.max(1, Math.min(count, maximum));
}
