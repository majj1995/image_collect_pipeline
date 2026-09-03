import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import ipaddr from "ipaddr.js";
import type { RetryableDownloadFailureCode } from "../../shared/contracts.js";

export interface ResolvedAddress { address: string; family: 4 | 6; }
export type RemoteResolver = (hostname: string) => Promise<ResolvedAddress[]>;
export type RemoteFetch = typeof fetch;
export interface PinnedTransportRequest { url: URL; address: ResolvedAddress; hostHeader: string; servername?: string; signal: AbortSignal; userAgent?: string; }
export type RemoteTransport = (request: PinnedTransportRequest) => Promise<Response>;

export class RemotePolicyError extends Error {
  public constructor(
    public readonly code: "UNSAFE_REMOTE_URL" | "UNSAFE_REDIRECT" | "DOWNLOAD_TOO_LARGE" | "DOWNLOAD_FAILED",
    message = "Remote image cannot be downloaded safely.",
    public readonly failureCode: RetryableDownloadFailureCode | null = null,
    public readonly retryAfterMs: number | null = null
  ) { super(message); }
}

const MAX_BYTES = 25_000_000;
const MAX_DOWNLOAD_RETRY_AFTER_MS = 15 * 60_000;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function downloadFailureCodeForStatus(status: number): RetryableDownloadFailureCode {
  if (status === 401 || status === 403) return "FORBIDDEN";
  if (status === 429) return "RATE_LIMITED";
  if (status === 502 || status === 503 || status === 504) return "NETWORK";
  return "GENERIC";
}

function downloadRetryAfterMilliseconds(value: string | null, now: number): number | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (/^\d+$/u.test(normalized)) {
    const seconds = Number(normalized);
    if (!Number.isFinite(seconds)) return MAX_DOWNLOAD_RETRY_AFTER_MS;
    return Math.min(MAX_DOWNLOAD_RETRY_AFTER_MS, Math.round(seconds * 1_000));
  }
  if (/^[+-]?\d+(?:\.\d+)?$/u.test(normalized)) return null;
  const retryAt = Date.parse(normalized);
  if (!Number.isFinite(retryAt)) return null;
  return Math.min(MAX_DOWNLOAD_RETRY_AFTER_MS, Math.max(0, retryAt - now));
}

export const systemResolver: RemoteResolver = async (hostname) => {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => ({ address: answer.address, family: answer.family as 4 | 6 }));
};

function isPublicAddress(value: string): boolean {
  if (!ipaddr.isValid(value)) return false;
  let address = ipaddr.parse(value);
  if (address.kind() === "ipv6" && (address as ipaddr.IPv6).isIPv4MappedAddress()) address = (address as ipaddr.IPv6).toIPv4Address();
  return address.range() === "unicast";
}

interface ResolvedRemoteUrl { url: URL; hostname: string; address: ResolvedAddress; }

async function resolveSafeRemoteUrl(value: string, resolver: RemoteResolver, errorCode: "UNSAFE_REMOTE_URL" | "UNSAFE_REDIRECT"): Promise<ResolvedRemoteUrl> {
  let url: URL;
  try { url = new URL(value); } catch { throw new RemotePolicyError(errorCode); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !url.hostname) throw new RemotePolicyError(errorCode);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (ipaddr.isValid(hostname)) {
    if (!isPublicAddress(hostname)) throw new RemotePolicyError(errorCode);
    return { url, hostname, address: { address: hostname, family: ipaddr.parse(hostname).kind() === "ipv4" ? 4 : 6 } };
  }
  let answers: ResolvedAddress[];
  try { answers = await resolver(hostname); }
  catch { throw new RemotePolicyError("DOWNLOAD_FAILED", undefined, "NETWORK"); }
  if (answers.length === 0) throw new RemotePolicyError("DOWNLOAD_FAILED", undefined, "NETWORK");
  if (answers.some((answer) => !isPublicAddress(answer.address))) throw new RemotePolicyError(errorCode);
  return { url, hostname, address: answers[0]! };
}

export async function assertSafeRemoteUrl(value: string, resolver: RemoteResolver = systemResolver, errorCode: "UNSAFE_REMOTE_URL" | "UNSAFE_REDIRECT" = "UNSAFE_REMOTE_URL"): Promise<URL> {
  return (await resolveSafeRemoteUrl(value, resolver, errorCode)).url;
}

export const pinnedNodeTransport: RemoteTransport = async ({ url, address, hostHeader, servername, signal, userAgent }) => new Promise<Response>((resolve, reject) => {
  const client = url.protocol === "https:" ? httpsRequest : httpRequest;
  const request = client({
    hostname: address.address, family: address.family, port: url.port || undefined, path: `${url.pathname}${url.search}`, method: "GET",
    headers: { host: hostHeader, ...(userAgent ? { "user-agent": userAgent } : {}) }, servername: url.protocol === "https:" && !ipaddr.isValid(servername ?? "") ? servername : undefined, signal
  }, (response) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (Array.isArray(value)) headers.set(name, value.join(", "));
      else if (value !== undefined) headers.set(name, String(value));
    }
    resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { status: response.statusCode ?? 502, headers }));
  });
  request.once("error", reject);
  request.end();
});

interface Deadline {
  signal: AbortSignal;
  race<T>(promise: Promise<T>): Promise<T>;
  outsideNetworkBudget<T>(operation: () => Promise<T>): Promise<T>;
  dispose(abortWork: boolean): void;
}

function createDeadline(timeoutMs: number, externalSignal?: AbortSignal): Deadline {
  const controller = new AbortController();
  const abortForExternalSignal = () => controller.abort();
  let remainingMs = Math.max(1, Math.floor(timeoutMs));
  let activeSince = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const startTimer = () => {
    if (controller.signal.aborted) return;
    activeSince = performance.now();
    timer = setTimeout(() => {
      remainingMs = 0;
      controller.abort();
    }, remainingMs);
  };
  const pauseTimer = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    remainingMs = Math.max(0, remainingMs - (performance.now() - activeSince));
    if (remainingMs === 0) controller.abort();
  };
  const resumeTimer = () => {
    if (!controller.signal.aborted && timer === undefined) startTimer();
  };
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener("abort", abortForExternalSignal, { once: true });
  startTimer();
  const race = <T>(promise: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    const finish = (settle: () => void) => { controller.signal.removeEventListener("abort", onAbort); settle(); };
    const onAbort = () => finish(() => reject(new RemotePolicyError("DOWNLOAD_FAILED", undefined, "NETWORK")));
    if (controller.signal.aborted) { onAbort(); return; }
    controller.signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
  });
  return {
    signal: controller.signal,
    race,
    async outsideNetworkBudget<T>(operation: () => Promise<T>): Promise<T> {
      pauseTimer();
      try {
        if (controller.signal.aborted) throw new RemotePolicyError("DOWNLOAD_FAILED", undefined, "NETWORK");
        return await race(operation());
      } finally {
        resumeTimer();
      }
    },
    dispose(abortWork) {
      if (abortWork) controller.abort();
      if (timer !== undefined) clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortForExternalSignal);
    }
  };
}

export interface FetchImagePolicyOptions {
  fetch?: RemoteFetch;
  transport?: RemoteTransport;
  resolver?: RemoteResolver;
  signal?: AbortSignal;
  /** Internal/test seam; production callers use the default 20 second deadline. */
  timeoutMs?: number;
  /** May tighten but never exceed the production 25 MB ceiling. */
  maxBytes?: number;
  /** Called immediately before every real fetch/transport start, including redirect hops. */
  beforeRequest?: (signal: AbortSignal) => Promise<void>;
  /** Optional provider-required identity, sent on every validated request and redirect hop. */
  userAgent?: string;
  /** Wall clock seam used only to interpret HTTP-date Retry-After values. */
  now?: () => number;
}

export async function fetchImageWithPolicy(value: string, options: FetchImagePolicyOptions = {}): Promise<{ bytes: Buffer; finalUrl: string; contentType: string | null }> {
  const resolver = options.resolver ?? systemResolver;
  const deadline = createDeadline(options.timeoutMs ?? 20_000, options.signal);
  const maxBytes = Math.min(MAX_BYTES, Math.max(1, Math.floor(options.maxBytes ?? MAX_BYTES)));
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let currentResponse: Response | undefined;
  let completed = false;
  const discard = (response: Response | undefined) => { if (response?.body) void response.body.cancel().catch(() => undefined); };
  try {
    let remote = await deadline.race(resolveSafeRemoteUrl(value, resolver, "UNSAFE_REMOTE_URL"));
    for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
      if (options.beforeRequest) await deadline.outsideNetworkBudget(() => options.beforeRequest!(deadline.signal));
      currentResponse = await deadline.race(options.transport
        ? options.transport({ url: remote.url, address: remote.address, hostHeader: remote.url.host, servername: remote.hostname, signal: deadline.signal, userAgent: options.userAgent })
        : options.fetch
          ? options.fetch(remote.url, { redirect: "manual", signal: deadline.signal, headers: options.userAgent ? { "user-agent": options.userAgent } : undefined })
          : pinnedNodeTransport({ url: remote.url, address: remote.address, hostHeader: remote.url.host, servername: remote.hostname, signal: deadline.signal, userAgent: options.userAgent }));
      if (REDIRECT_STATUS.has(currentResponse.status)) {
        if (redirectCount === 3) { discard(currentResponse); currentResponse = undefined; throw new RemotePolicyError("DOWNLOAD_FAILED", undefined, "GENERIC"); }
        const location = currentResponse.headers.get("location");
        if (!location) { discard(currentResponse); currentResponse = undefined; throw new RemotePolicyError("UNSAFE_REDIRECT"); }
        let target: string;
        try { target = new URL(location, remote.url).toString(); }
        catch { discard(currentResponse); currentResponse = undefined; throw new RemotePolicyError("UNSAFE_REDIRECT"); }
        discard(currentResponse);
        currentResponse = undefined;
        remote = await deadline.race(resolveSafeRemoteUrl(target, resolver, "UNSAFE_REDIRECT"));
        continue;
      }
      if (!currentResponse.ok || !currentResponse.body) {
        const failureCode = downloadFailureCodeForStatus(currentResponse.status);
        const retryAfterMs = currentResponse.status === 429
          ? downloadRetryAfterMilliseconds(currentResponse.headers.get("retry-after"), (options.now ?? Date.now)())
          : null;
        discard(currentResponse); currentResponse = undefined;
        throw new RemotePolicyError("DOWNLOAD_FAILED", undefined, failureCode, retryAfterMs);
      }
      const declaredLength = Number(currentResponse.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) { discard(currentResponse); currentResponse = undefined; throw new RemotePolicyError("DOWNLOAD_TOO_LARGE"); }
      reader = currentResponse.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const result = await deadline.race(reader.read());
        if (result.done) break;
        total += result.value.byteLength;
        if (total > maxBytes) throw new RemotePolicyError("DOWNLOAD_TOO_LARGE");
        chunks.push(result.value);
      }
      const contentType = currentResponse.headers.get("content-type");
      completed = true;
      currentResponse = undefined;
      return { bytes: Buffer.concat(chunks), finalUrl: remote.url.toString(), contentType };
    }
    throw new RemotePolicyError("DOWNLOAD_FAILED", undefined, "GENERIC");
  } catch (error) {
    if (error instanceof RemotePolicyError) throw error;
    throw new RemotePolicyError("DOWNLOAD_FAILED", undefined, "NETWORK");
  } finally {
    if (reader && !completed) void reader.cancel().catch(() => undefined);
    if (currentResponse && !completed) discard(currentResponse);
    deadline.dispose(!completed);
  }
}
