import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "../../src/server/providers/types.js";
import { requestJson } from "../../src/server/providers/common.js";
import { executeWithProviderRetry, providerFailureSummary } from "../../src/server/services/retry-policy.js";

describe("provider retry policy", () => {
  it("captures an upstream Retry-After header without reading or exposing its response body", async () => {
    const request = requestJson("fake", async () => new Response("private upstream body", {
      status: 429,
      headers: { "retry-after": "7" }
    }), "https://provider.example/search", {});

    await expect(request).rejects.toMatchObject({
      name: "ProviderError", status: 429, retryable: true, retryAfterMs: 7_000
    });
  });

  it("uses bounded exponential backoff for transient provider failures", async () => {
    let attempts = 0;
    const sleep = vi.fn(async () => undefined);
    const result = await executeWithProviderRetry(async () => {
      attempts += 1;
      if (attempts < 3) throw new ProviderError("fake", 429, true);
      return "ok";
    }, { sleep, random: () => 0.5, maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 });

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([100, 200]);
  });

  it("refuses an unsafe automatic Retry-After wait instead of shortening it", async () => {
    const sleep = vi.fn(async () => undefined);
    const failure = new ProviderError("fake", 429, true, 120_000);
    let attempts = 0;

    await expect(executeWithProviderRetry(async () => {
      attempts += 1;
      throw failure;
    }, {
      sleep,
      random: () => 0.5,
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      maxRetryAfterMs: 60_000
    })).rejects.toBe(failure);

    expect(attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("treats an infinite Retry-After as unsafe instead of retrying immediately", async () => {
    const sleep = vi.fn(async () => undefined);
    const failure = new ProviderError("fake", 429, true, Number.POSITIVE_INFINITY);
    let attempts = 0;

    await expect(executeWithProviderRetry(async () => {
      attempts += 1;
      throw failure;
    }, {
      sleep,
      random: () => 0.5,
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      maxRetryAfterMs: 60_000
    })).rejects.toBe(failure);

    expect(attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    [new ProviderError("fake", 401, false), 1],
    [new ProviderError("fake", 403, false), 1],
    [new ProviderError("fake", 400, true), 3],
    [new Error("provider body claimed status=500 and token=secret"), 1],
    [new ProviderError("fake", 408, false), 1],
    [new ProviderError("fake", 500, false), 1],
    [new ProviderError("fake", 503, true), 3],
    [new ProviderError("fake", null, true), 3],
    [Object.assign(new Error("request aborted"), { name: "AbortError" }), 1],
    [Object.assign(new Error("request timed out"), { name: "TimeoutError" }), 3]
  ])("classifies retry eligibility from typed failures only", async (error, expectedAttempts) => {
    let attempts = 0;
    await expect(executeWithProviderRetry(async () => { attempts += 1; throw error; }, {
      sleep: async () => undefined,
      random: () => 0,
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 1
    })).rejects.toBe(error);
    expect(attempts).toBe(expectedAttempts);
  });

  it("returns fixed localized summaries without raw provider text or secrets", () => {
    const secretFailure = new Error("response body token=raw-provider-secret");
    expect(providerFailureSummary(secretFailure)).toEqual({
      retryable: false,
      message: "提供方请求失败，请检查该来源配置。"
    });
    expect(JSON.stringify(providerFailureSummary(secretFailure))).not.toContain("raw-provider-secret");
    expect(providerFailureSummary(new ProviderError("fake", 429, true))).toEqual({
      retryable: true,
      message: "提供方请求过于频繁，可稍后继续重试。"
    });
    expect(providerFailureSummary(new ProviderError("fake", 401, false))).toEqual({
      retryable: false,
      message: "提供方凭据无效或权限不足，请检查本地配置。"
    });
    expect(providerFailureSummary(new ProviderError("openverse", 401, false))).toEqual({
      retryable: false,
      message: "Openverse 匿名接口拒绝了请求；该来源无需 API Key，请检查请求参数。"
    });
    expect(providerFailureSummary(new ProviderError("bing_ads", 403, false))).toEqual({
      retryable: false,
      message: "Bing Ad Library 匿名接口拒绝了本次查询；该来源无需 API Key，请调整查询条件后重试。"
    });
    expect(providerFailureSummary(new ProviderError("bing_ads", 429, true))).toEqual({
      retryable: true,
      message: "提供方请求过于频繁，可稍后继续重试。"
    });
  });

  it("does not mislabel anonymous or optional free access rejection as an invalid credential", () => {
    expect(providerFailureSummary(new ProviderError("loc", 403, false), "none")).toEqual({
      retryable: false,
      message: "提供方匿名接口拒绝了本次请求；该来源无需 API Key，请调整查询条件后重试。"
    });
    expect(providerFailureSummary(new ProviderError("smithsonian", 403, false), "optional")).toEqual({
      retryable: false,
      message: "提供方拒绝了本次请求；请检查免费 API Key 或共享访问额度。"
    });
  });
});
