import { describe, expect, it } from "vitest";
import { containsUnsafePublicMetadata, MAX_PUBLIC_TEXT_LENGTH, sanitizePublicHttpUrl, sanitizePublicSource, sanitizePublicText } from "../../src/shared/public-url.js";

describe("public HTTP URL sanitizer", () => {
  it("preserves benign query identity while removing exact credentials, signed parameters, and fragments", () => {
    expect(sanitizePublicHttpUrl("https://shop.example/item?productId=42&width=1200&token=secret&X-Amz-Signature=signed#private"))
      .toBe("https://shop.example/item?productId=42&width=1200");
    expect(sanitizePublicHttpUrl("https://shop.example/item?monkey=keep&keyboard=keep&api_key=secret&X-Goog-Credential=signed"))
      .toBe("https://shop.example/item?monkey=keep&keyboard=keep");
    expect(sanitizePublicHttpUrl("https://shop.example/item?AccessKeyId=AKIA-SECRET&x=1"))
      .toBe("https://shop.example/item?x=1");
  });

  it("normalizes credential key separators and strips exact provider credentials without removing transforms", () => {
    const source = new URL("https://shop.example/item");
    source.searchParams.set("productId", "42");
    source.searchParams.set("width", "1200");
    source.searchParams.set("monkey", "keep");
    source.searchParams.set("keyboard", "keep");
    source.searchParams.set("client_secret", "one");
    source.searchParams.set("CLIENT-TOKEN", "two");
    source.searchParams.set("oauth.token", "three");
    source.searchParams.set("oauth_signature", "four");
    source.searchParams.set("session-token", "five");
    source.searchParams.set("AWSAccessKeyId", "six");
    source.searchParams.set("GoogleAccessId", "seven");
    source.searchParams.set("X-Amz-Credential", "eight");
    source.searchParams.set("x_goog_signature", "nine");
    source.searchParams.set("oauth_nonce", "ten");
    source.searchParams.set("x-oss-signature", "eleven");
    source.searchParams.set("OSSAccessKeyId", "twelve");
    source.searchParams.set("x-oss-credential", "thirteen");
    source.searchParams.set("x-oss-security-token", "fourteen");
    source.searchParams.set("x-oss-date", "fifteen");
    source.searchParams.set("q-ak", "sixteen");
    source.searchParams.set("q-signature", "seventeen");
    source.searchParams.set("q-sign-time", "eighteen");
    source.searchParams.set("q-key-time", "nineteen");
    source.searchParams.set("q-header-list", "twenty");
    source.searchParams.set("q-url-param-list", "twenty-one");
    source.searchParams.set("Q.Sign_Algorithm", "twenty-one-a");
    source.searchParams.set("x-cos-security-token", "twenty-two");
    source.searchParams.set("x-bce-security-token", "twenty-three");
    source.searchParams.set("x-bce-signature", "twenty-four");
    source.searchParams.set("x-bce-process", "image/resize,w_1200");
    source.searchParams.set("x-oss-process", "image/resize,w_1200");
    source.searchParams.set("X_OSS.Additional-Headers", "host;x-oss-meta-owner");
    source.searchParams.set("ci-process", "imageMogr2/thumbnail/1200x");
    source.hash = "private";

    expect(sanitizePublicHttpUrl(source.toString()))
      .toBe("https://shop.example/item?productId=42&width=1200&monkey=keep&keyboard=keep&x-bce-process=image%2Fresize%2Cw_1200&x-oss-process=image%2Fresize%2Cw_1200&ci-process=imageMogr2%2Fthumbnail%2F1200x");
  });

  it("rejects userinfo and non-HTTP protocols instead of silently retargeting them", () => {
    expect(sanitizePublicHttpUrl("https://alice:pw@shop.example/item?productId=42")).toBeNull();
    expect(sanitizePublicHttpUrl("file:///Users/alice/private.jpg")).toBeNull();
  });

  it("redacts secret-like free text and bounds provider-controlled values", () => {
    expect(sanitizePublicText("Brave token=provider-secret; campaign=summer"))
      .toBe("Brave [REDACTED]; campaign=summer");
    expect(sanitizePublicText(`api_key=source-secret; ${"x".repeat(500)}`)).not.toContain("source-secret");
    expect(sanitizePublicText("Brave\u0000\nImages token=provider-secret; verified"))
      .toBe("Brave Images [REDACTED]; verified");
    expect(sanitizePublicText("cached at /Users/alice/private.jpg")).not.toContain("/Users/alice");
    expect(sanitizePublicText("mirror https://alice:pw@example.test/image.jpg")).not.toContain("alice:pw");
    expect(Array.from(sanitizePublicText("x".repeat(500)) ?? "")).toHaveLength(MAX_PUBLIC_TEXT_LENGTH);
  });

  it("uses the same normalized credential-key family for free text and rejects NFKC-obfuscated URLs", () => {
    expect(sanitizePublicText("AWSAccessKeyId=aws-secret; campaign=summer")).toBe("[REDACTED]; campaign=summer");
    expect(sanitizePublicText("GoogleAccessId=google-secret; verified")).toBe("[REDACTED]; verified");
    expect(sanitizePublicText("OSSAccessKeyId=oss-secret; licensed")).toBe("[REDACTED]; licensed");
    expect(sanitizePublicText("AccessKeyId=generic-access-secret; campaign=summer")).toBe("[REDACTED]; campaign=summer");
    expect(sanitizePublicText("Access Key ID: spaced-access-secret; verified")).toBe("[REDACTED]; verified");
    expect(sanitizePublicText("AccessKeySecret=generic-key-secret; licensed")).toBe("[REDACTED]; licensed");
    expect(sanitizePublicText("SecretAccessKey=reverse-key-secret; approved")).toBe("[REDACTED]; approved");
    expect(sanitizePublicSource("ｈｔｔｐｓ：／／alice：pw＠example.test/private")).toBeNull();
  });

  it("redacts absolute local paths without changing public URLs or ordinary slash text", () => {
    expect(sanitizePublicText("cache /private/var/folders/app-db.sqlite; retained")).toBe("cache [REDACTED]; retained");
    expect(sanitizePublicText("mirror /home/alice/datasets/image.jpg; retained")).toBe("mirror [REDACTED]; retained");
    expect(sanitizePublicText(String.raw`cache C:\Users\alice\private.db; retained`)).toBe("cache [REDACTED]; retained");
    expect(sanitizePublicText("campaign https://cdn.example/assets/ad.jpg; ratio 16/9")).toBe("campaign https://cdn.example/assets/ad.jpg; ratio 16/9");
  });

  it("detects credentials and JSON-escaped absolute paths at the ZIP metadata gate", () => {
    expect(containsUnsafePublicMetadata(JSON.stringify({ label: "Access Key ID: raw-label-secret" }))).toBe(true);
    expect(containsUnsafePublicMetadata(JSON.stringify({ label: "/home/alice/private-label.json" }))).toBe(true);
    expect(containsUnsafePublicMetadata(JSON.stringify({ label: String.raw`C:\Users\alice\private-label.json` }))).toBe(true);
    expect(containsUnsafePublicMetadata(JSON.stringify({ source: "https://cdn.example/assets/ad.jpg", ratio: "16/9" }))).toBe(false);
  });

  it("preserves benign Chinese fullwidth punctuation while folding security-significant characters", () => {
    const summary = "提供方请求过于频繁，可稍后继续重试（已尝试 3 次）。";
    expect(sanitizePublicText(summary)).toBe(summary);
  });
});
