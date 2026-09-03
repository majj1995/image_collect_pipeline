import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { assertSafeRemoteUrl, fetchImageWithPolicy, pinnedNodeTransport, RemotePolicyError } from "../../src/server/services/safe-url.js";
import { publicOnlyResolver, redirectingFetch, streamResponse } from "../helpers/assets.js";

describe("remote image URL policy", () => {
  it.each([
    "http://127.0.0.1/image.jpg",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/image.png",
    "http://[::ffff:127.0.0.1]/image.png",
    "file:///etc/passwd",
    "https://user:pass@public.example/image.png"
  ])("blocks unsafe URL %s", async (url) => {
    await expect(assertSafeRemoteUrl(url, publicOnlyResolver)).rejects.toMatchObject({ code: "UNSAFE_REMOTE_URL" });
  });

  it("rejects hosts where any resolved address is private", async () => {
    await expect(assertSafeRemoteUrl("https://public.example/image.png", async () => [
      { address: "93.184.216.34", family: 4 as const }, { address: "10.0.0.2", family: 4 as const }
    ])).rejects.toMatchObject({ code: "UNSAFE_REMOTE_URL" });
  });

  it("revalidates a redirect target", async () => {
    await expect(fetchImageWithPolicy("https://public.example/image", {
      fetch: redirectingFetch("http://10.0.0.2/private.jpg"), resolver: publicOnlyResolver
    })).rejects.toMatchObject({ code: "UNSAFE_REDIRECT" });
  });

  it("follows a relative redirect only after revalidation", async () => {
    const calls: string[] = [];
    const response = await fetchImageWithPolicy("https://public.example/a/image", {
      resolver: publicOnlyResolver,
      fetch: async (input) => {
        calls.push(String(input));
        return calls.length === 1 ? new Response(null, { status: 302, headers: { location: "../image.png" } }) : new Response(new Uint8Array([1, 2, 3]));
      }
    });
    expect(calls).toEqual(["https://public.example/a/image", "https://public.example/image.png"]);
    expect([...response.bytes]).toEqual([1, 2, 3]);
  });

  it("sends the configured User-Agent on every fetch redirect hop", async () => {
    const userAgents: Array<string | null> = [];
    await fetchImageWithPolicy("https://public.example/a/image", {
      resolver: publicOnlyResolver,
      userAgent: "IdentifiableDownloader/1.0 (local research tool)",
      fetch: async (_input, init) => {
        userAgents.push(new Headers(init?.headers).get("user-agent"));
        return userAgents.length === 1
          ? new Response(null, { status: 302, headers: { location: "../image.png" } })
          : new Response(new Uint8Array([1, 2, 3]));
      }
    });

    expect(userAgents).toEqual([
      "IdentifiableDownloader/1.0 (local research tool)",
      "IdentifiableDownloader/1.0 (local research tool)"
    ]);
  });

  it("rejects declared and streamed downloads above 25 MB", async () => {
    await expect(fetchImageWithPolicy("https://public.example/image", {
      resolver: publicOnlyResolver, fetch: async () => new Response(new Uint8Array([1]), { headers: { "content-length": "25000001" } })
    })).rejects.toMatchObject({ code: "DOWNLOAD_TOO_LARGE" });
    await expect(fetchImageWithPolicy("https://public.example/image", {
      resolver: publicOnlyResolver, fetch: async () => streamResponse([new Uint8Array(12_500_000), new Uint8Array(12_500_001)])
    })).rejects.toMatchObject({ code: "DOWNLOAD_TOO_LARGE" });
  });

  it("pins the transport connection to the validated DNS address", async () => {
    let connection: { address: string; hostHeader: string; servername: string } | undefined;
    await fetchImageWithPolicy("https://public.example/image.png", {
      resolver: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async (request) => {
        connection = { address: request.address.address, hostHeader: request.hostHeader, servername: request.servername! };
        return new Response(new Uint8Array([1]));
      }
    });
    expect(connection).toEqual({ address: "93.184.216.34", hostHeader: "public.example", servername: "public.example" });
  });

  it("forwards the configured User-Agent to the pinned transport", async () => {
    let userAgent: string | undefined;
    await fetchImageWithPolicy("https://public.example/image.png", {
      resolver: publicOnlyResolver,
      userAgent: "IdentifiableDownloader/1.0 (local research tool)",
      transport: async (request) => {
        userAgent = request.userAgent;
        return new Response(new Uint8Array([1]));
      }
    });
    expect(userAgent).toBe("IdentifiableDownloader/1.0 (local research tool)");
  });

  it("sends the configured User-Agent through the production pinned transport", async () => {
    let receivedUserAgent: string | undefined;
    const server = createServer((request, response) => {
      receivedUserAgent = request.headers["user-agent"];
      response.end("image");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const response = await pinnedNodeTransport({
        url: new URL(`http://public.example:${port}/image.png`),
        address: { address: "127.0.0.1", family: 4 },
        hostHeader: `public.example:${port}`,
        servername: "public.example",
        signal: new AbortController().signal,
        userAgent: "IdentifiableDownloader/1.0 (local research tool)"
      });
      await response.arrayBuffer();
      expect(receivedUserAgent).toBe("IdentifiableDownloader/1.0 (local research tool)");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("does not wait beyond the shared deadline when resolution ignores abort", async () => {
    await expect(fetchImageWithPolicy("https://public.example/image.png", {
      timeoutMs: 5,
      resolver: async () => new Promise(() => {})
    })).rejects.toMatchObject({ code: "DOWNLOAD_FAILED", failureCode: "NETWORK" });
  });

  it.each([
    ["rejects", async () => { throw new Error("resolver internal detail must stay private"); }],
    ["returns no answers", async () => []]
  ] as const)("classifies DNS resolution that %s as a safe network failure", async (_case, resolver) => {
    let failure: unknown;
    try {
      await fetchImageWithPolicy("https://unresolved.example/image.png", { resolver });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(RemotePolicyError);
    expect(failure).toMatchObject({
      code: "DOWNLOAD_FAILED",
      failureCode: "NETWORK",
      message: "Remote image cannot be downloaded safely."
    });
    expect(String(failure)).not.toContain("resolver internal detail");
    expect(JSON.stringify(failure)).not.toContain("resolver internal detail");
  });

  it.each([
    [401, "FORBIDDEN"],
    [403, "FORBIDDEN"],
    [429, "RATE_LIMITED"],
    [502, "NETWORK"],
    [503, "NETWORK"],
    [504, "NETWORK"],
    [500, "GENERIC"]
  ] as const)("classifies HTTP %i download failures as %s without exposing upstream details", async (status, failureCode) => {
    const url = "https://public.example/image.png?private-token=do-not-persist";
    let failure: unknown;
    try {
      await fetchImageWithPolicy(url, {
        resolver: publicOnlyResolver,
        fetch: async () => new Response("upstream response body must not escape", { status })
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RemotePolicyError);
    expect(failure).toMatchObject({ code: "DOWNLOAD_FAILED", failureCode });
    const serialized = JSON.stringify(failure);
    expect(serialized).not.toContain("private-token");
    expect(serialized).not.toContain("upstream response body");
  });

  it.each([
    ["delta-seconds", "7", Date.UTC(2026, 8, 2, 4, 0, 0), 7_000],
    ["HTTP-date", "Wed, 02 Sep 2026 04:00:07 GMT", Date.UTC(2026, 8, 2, 4, 0, 0), 7_000],
    ["past HTTP-date", "Wed, 02 Sep 2026 03:59:59 GMT", Date.UTC(2026, 8, 2, 4, 0, 0), 0],
    ["excessive delta-seconds", "999999999", Date.UTC(2026, 8, 2, 4, 0, 0), 15 * 60_000],
    ["excessive HTTP-date", "Wed, 02 Sep 2026 06:00:00 GMT", Date.UTC(2026, 8, 2, 4, 0, 0), 15 * 60_000],
    ["negative delta-seconds", "-1", Date.UTC(2026, 8, 2, 4, 0, 0), null],
    ["fractional delta-seconds", "1.5", Date.UTC(2026, 8, 2, 4, 0, 0), null],
    ["invalid value", "not-a-delay", Date.UTC(2026, 8, 2, 4, 0, 0), null]
  ] as const)("parses and bounds 429 Retry-After %s", async (_case, retryAfter, now, expectedRetryAfterMs) => {
    let failure: unknown;
    try {
      await fetchImageWithPolicy("https://public.example/image.png", {
        resolver: publicOnlyResolver,
        now: () => now,
        fetch: async () => new Response("rate limited", { status: 429, headers: { "retry-after": retryAfter } })
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RemotePolicyError);
    expect(failure).toMatchObject({ code: "DOWNLOAD_FAILED", failureCode: "RATE_LIMITED", retryAfterMs: expectedRetryAfterMs });
  });

  it("ignores Retry-After on non-429 download failures", async () => {
    await expect(fetchImageWithPolicy("https://public.example/image.png", {
      resolver: publicOnlyResolver,
      fetch: async () => new Response("unavailable", { status: 503, headers: { "retry-after": "30" } })
    })).rejects.toMatchObject({ failureCode: "NETWORK", retryAfterMs: null });
  });

  it("excludes provider pacing waits from the shared network deadline", async () => {
    vi.useFakeTimers();
    try {
      let releasePacing!: () => void;
      let fetches = 0;
      const outcome = fetchImageWithPolicy("https://public.example/image.png", {
        resolver: publicOnlyResolver,
        timeoutMs: 100,
        beforeRequest: async () => new Promise<void>((resolve) => { releasePacing = resolve; }),
        fetch: async () => { fetches += 1; return new Response(new Uint8Array([1, 2, 3])); }
      }).then((value) => ({ value }), (error: unknown) => ({ error }));

      await vi.advanceTimersByTimeAsync(0);
      expect(releasePacing).toEqual(expect.any(Function));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetches).toBe(0);
      releasePacing();
      await vi.advanceTimersByTimeAsync(0);

      const result = await outcome;
      expect(result).toHaveProperty("value");
      expect(fetches).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies transport rejections as network download failures", async () => {
    await expect(fetchImageWithPolicy("https://public.example/image.png", {
      resolver: publicOnlyResolver,
      fetch: async () => { throw new Error("untrusted upstream transport detail"); }
    })).rejects.toMatchObject({ code: "DOWNLOAD_FAILED", failureCode: "NETWORK" });
  });

  it("cancels every response body that is not consumed as the final image", async () => {
    const cancelled: string[] = [];
    const tracked = (name: string) => new Response(new ReadableStream<Uint8Array>({ cancel: () => { cancelled.push(name); } }));
    let call = 0;
    await fetchImageWithPolicy("https://public.example/image", {
      resolver: publicOnlyResolver,
      fetch: async () => {
        call += 1;
        return call === 1 ? new Response(tracked("redirect").body, { status: 302, headers: { location: "/final" } }) : new Response(new Uint8Array([1]));
      }
    });
    await expect(fetchImageWithPolicy("https://public.example/error", { resolver: publicOnlyResolver, fetch: async () => new Response(tracked("error").body, { status: 500 }) })).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
    await expect(fetchImageWithPolicy("https://public.example/large", { resolver: publicOnlyResolver, fetch: async () => new Response(tracked("large").body, { headers: { "content-length": "25000001" } }) })).rejects.toMatchObject({ code: "DOWNLOAD_TOO_LARGE" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled.sort()).toEqual(["error", "large", "redirect"]);
  });
});
