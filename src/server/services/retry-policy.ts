import { ProviderError } from "../providers/types.js";
import type { ProviderCredentialMode } from "../../shared/contracts.js";

export const MAX_SAFE_AUTOMATIC_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;

export type ProviderRetryAfterDisposition =
  | { kind: "none" }
  | { kind: "wait"; retryAfterMs: number }
  | { kind: "blocked"; retryAfterMs: number };

export interface RetryPolicyOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetryAfterMs: number;
  sleep: (delayMs: number) => Promise<void>;
  random: () => number;
}

export const defaultRetryPolicy: RetryPolicyOptions = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 60_000,
  maxRetryAfterMs: MAX_SAFE_AUTOMATIC_RETRY_AFTER_MS,
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  random: Math.random
};

export function providerRetryAfterDisposition(
  error: unknown,
  configuredMaximum = MAX_SAFE_AUTOMATIC_RETRY_AFTER_MS
): ProviderRetryAfterDisposition {
  if (!(error instanceof ProviderError) || error.retryAfterMs === null) return { kind: "none" };
  const rawRetryAfter = error.retryAfterMs;
  if (rawRetryAfter === Number.POSITIVE_INFINITY) return { kind: "blocked", retryAfterMs: rawRetryAfter };
  if (!Number.isFinite(rawRetryAfter) || rawRetryAfter <= 0) return { kind: "none" };
  const retryAfterMs = Math.ceil(rawRetryAfter);
  const requestedMaximum = Number.isFinite(configuredMaximum)
    ? Math.max(0, Math.floor(configuredMaximum))
    : MAX_SAFE_AUTOMATIC_RETRY_AFTER_MS;
  const safeMaximum = Math.min(requestedMaximum, MAX_SAFE_AUTOMATIC_RETRY_AFTER_MS);
  return retryAfterMs > safeMaximum
    ? { kind: "blocked", retryAfterMs }
    : { kind: "wait", retryAfterMs };
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

export function isRetryableProviderFailure(error: unknown): boolean {
  if (error instanceof ProviderError) return error.retryable;
  return isTimeout(error);
}

export function providerFailureSummary(error: unknown, credentialMode?: ProviderCredentialMode): { retryable: boolean; message: string } {
  const retryable = isRetryableProviderFailure(error);
  if (error instanceof ProviderError && error.provider === "openverse" && (error.status === 401 || error.status === 403)) {
    return { retryable: false, message: "Openverse 匿名接口拒绝了请求；该来源无需 API Key，请检查请求参数。" };
  }
  if (error instanceof ProviderError && error.provider === "bing_ads" && (error.status === 401 || error.status === 403)) {
    return { retryable: false, message: "Bing Ad Library 匿名接口拒绝了本次查询；该来源无需 API Key，请调整查询条件后重试。" };
  }
  if (error instanceof ProviderError && (error.status === 401 || error.status === 403)) {
    if (credentialMode === "none") {
      return { retryable: false, message: "提供方匿名接口拒绝了本次请求；该来源无需 API Key，请调整查询条件后重试。" };
    }
    if (credentialMode === "optional") {
      return { retryable: false, message: "提供方拒绝了本次请求；请检查免费 API Key 或共享访问额度。" };
    }
    return { retryable: false, message: "提供方凭据无效或权限不足，请检查本地配置。" };
  }
  if (error instanceof ProviderError && error.status === 429) {
    return { retryable: true, message: "提供方请求过于频繁，可稍后继续重试。" };
  }
  if (retryable) return { retryable: true, message: "提供方暂时不可用，可稍后继续重试。" };
  return { retryable: false, message: "提供方请求失败，请检查该来源配置。" };
}

export async function executeWithProviderRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: Partial<RetryPolicyOptions> = {}
): Promise<T> {
  const policy = { ...defaultRetryPolicy, ...options };
  const maxAttempts = Math.max(1, Math.floor(policy.maxAttempts));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try { return await operation(attempt); }
    catch (error) {
      if (attempt >= maxAttempts || !isRetryableProviderFailure(error)) throw error;
      const random = Math.min(1, Math.max(0, policy.random()));
      const backoff = Math.round(policy.baseDelayMs * (2 ** (attempt - 1)) * (0.5 + random));
      const retryAfter = providerRetryAfterDisposition(error, policy.maxRetryAfterMs);
      if (retryAfter.kind === "blocked") throw error;
      const boundedBackoff = Math.min(Math.max(0, policy.maxDelayMs), Math.max(0, backoff));
      const delay = Math.max(boundedBackoff, retryAfter.kind === "wait" ? retryAfter.retryAfterMs : 0);
      await policy.sleep(delay);
    }
  }
  throw new Error("Unreachable retry state.");
}
