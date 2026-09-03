import { describe, expect, it } from "vitest";
import { BingAdsProvider } from "../../src/server/providers/bing-ads.js";
import { SnapAdsProvider } from "../../src/server/providers/snap-ads.js";
import { recordingFixtureFetch } from "../helpers/providers.js";

const request = { query: "portable speaker", count: 12, locale: "zh-CN", safeSearch: true };

describe("anonymous advertising-library providers", () => {
  it("queries Bing Ads with documented paging and expands image assets only", async () => {
    const calls: Request[] = [];
    const provider = new BingAdsProvider({ fetch: recordingFixtureFetch(calls, "bing-ads.json") });

    const hits = await provider.search({ ...request, page: 3 }, AbortSignal.timeout(1_000));

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://adlibrary.api.bingads.microsoft.com/api/v1/Ads");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ top: "12", skip: "24", searchText: "portable speaker" });
    expect(hits).toEqual([expect.objectContaining({
      provider: "bing_ads",
      imageUrl: "https://images.example.test/bing-speaker-ad.jpg",
      landingPageUrl: "https://shop.example.test/products/speaker",
      title: "Portable speaker summer sale",
      creator: "Acme Audio",
      source: "71468541217674"
    })]);
    expect(JSON.stringify(hits)).not.toContain("next-page-secret");
  });

  it("skips malformed Bing AssetJson and non-image assets without failing siblings", async () => {
    const provider = new BingAdsProvider({
      fetch: async () => Response.json({ value: [
        { AdId: "broken", AssetJson: "not-json" },
        { AdId: "video", AssetJson: JSON.stringify([{ AssetType: "Video", AssetUrl: "https://video.example.test/a.mp4" }]) },
        { AdId: "image", AssetJson: JSON.stringify([{ AssetType: "Image", AssetUrl: "https://images.example.test/a.jpg" }]) }
      ] })
    });

    await expect(provider.search(request, AbortSignal.timeout(1_000))).resolves.toEqual([
      expect.objectContaining({ source: "image", imageUrl: "https://images.example.test/a.jpg" })
    ]);
  });

  it("removes unsupported exclusion operators from Bing searchText without changing hyphenated terms", async () => {
    const calls: Request[] = [];
    const provider = new BingAdsProvider({ fetch: recordingFixtureFetch(calls, "bing-ads.json") });

    await provider.search({
      ...request,
      query: 'security camera wi-fi ecommerce advertisement -"real photo" -review -tutorial -installation'
    }, AbortSignal.timeout(1_000));

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("searchText")).toBe("security camera wi-fi ecommerce advertisement");
  });

  it("applies Bing exclusion terms to returned ad metadata after querying", async () => {
    const provider = new BingAdsProvider({ fetch: async () => Response.json({ value: [
      {
        AdId: "excluded",
        Title: "Security camera installation tutorial",
        AssetJson: JSON.stringify([{ AssetType: "Image", AssetUrl: "https://images.example.test/tutorial.jpg" }])
      },
      {
        AdId: "excluded-description",
        Title: "Security camera showcase",
        Description: "A real\nphoto campaign",
        AssetJson: JSON.stringify([{ AssetType: "Image", AssetUrl: "https://images.example.test/real-photo.jpg" }])
      },
      {
        AdId: "excluded-advertiser",
        Title: "Security camera offer",
        AdvertiserName: "Trusted Review Store",
        AssetJson: JSON.stringify([{ AssetType: "Image", AssetUrl: "https://images.example.test/review.jpg" }])
      },
      {
        AdId: "accepted",
        Title: "Security camera summer sale",
        Description: "Save on home monitoring",
        AdvertiserName: "Acme Security",
        AssetJson: JSON.stringify([{ AssetType: "Image", AssetUrl: "https://images.example.test/sale.jpg" }])
      }
    ] }) });

    await expect(provider.search({
      ...request,
      query: 'security camera -"real photo" -review -tutorial'
    }, AbortSignal.timeout(1_000))).resolves.toEqual([
      expect.objectContaining({ source: "accepted", imageUrl: "https://images.example.test/sale.jpg" })
    ]);
  });

  it("does not create an excluded phrase across separate Bing metadata fields", async () => {
    const provider = new BingAdsProvider({ fetch: async () => Response.json({ value: [{
      AdId: "cross-field-phrase",
      Title: "This campaign looks real",
      Description: "Photo campaign for a security camera",
      AssetJson: JSON.stringify([{ AssetType: "Image", AssetUrl: "https://images.example.test/cross-field.jpg" }])
    }] }) });

    await expect(provider.search({
      ...request,
      query: 'security camera -"real photo"'
    }, AbortSignal.timeout(1_000))).resolves.toEqual([
      expect.objectContaining({ source: "cross-field-phrase", imageUrl: "https://images.example.test/cross-field.jpg" })
    ]);
  });

  it("uses Snap's public brand-search body and normalizes the real top-snap image schema", async () => {
    const calls: Request[] = [];
    const provider = new SnapAdsProvider({ fetch: recordingFixtureFetch(calls, "snap-ads.json") });

    const hits = await provider.search(request, AbortSignal.timeout(1_000));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://adsapi.snapchat.com/v1/ads_library/ads/search?limit=12");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.get("authorization")).toBeNull();
    await expect(calls[0]!.json()).resolves.toEqual({ paying_advertiser_name: "portable speaker" });
    expect(hits).toEqual([expect.objectContaining({
      provider: "snap_ads",
      imageUrl: "https://cf-st.sc-cdn.net/d/snap-speaker-ad.380",
      transientImageUrl: "https://cf-st.sc-cdn.net/d/snap-speaker-ad.380?mo=signed-fixture&uc=15",
      thumbnailUrl: "https://cf-st.sc-cdn.net/d/snap-speaker-ad.380",
      landingPageUrl: "https://shop.example.test/products/speaker",
      title: "Portable speaker summer sale",
      creator: "Acme Audio",
      source: "snap-ad-42"
    })]);
  });

  it("asks Snap for only the requested number of previews on the first cursor page", async () => {
    const calls: Request[] = [];
    const provider = new SnapAdsProvider({ fetch: async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json({ request_status: "SUCCESS", paging: {}, ad_previews: [] });
    } });

    await provider.search({ ...request, count: 1 }, AbortSignal.timeout(1_000));

    expect(calls[0]!.url).toBe("https://adsapi.snapchat.com/v1/ads_library/ads/search?limit=1");
  });

  it("extracts static image snaps from a mixed composite creative", async () => {
    const provider = new SnapAdsProvider({ fetch: async () => Response.json({
      request_status: "SUCCESS",
      paging: {},
      ad_previews: [{
        sub_request_status: "SUCCESS",
        ad_preview: {
          id: "composite-42",
          headline: "Composite speaker campaign",
          paying_advertiser_name: "Acme Audio",
          web_view_properties: { url: "https://shop.example.test/fallback" },
          top_snap_media_type: "COMPOSITE",
          composite_preview: { ad_snaps: [
            { top_snap_media_type: "VIDEO", top_snap_media_download_link: "https://cdn.example.test/video.mp4" },
            {
              top_snap_media_type: "IMAGE",
              top_snap_media_download_link: "https://cdn.example.test/composite-image.jpg?mo=signed",
              web_view_preview: { url: "https://shop.example.test/composite-image" }
            }
          ] }
        }
      }]
    }) });

    await expect(provider.search({ ...request, count: 3 }, AbortSignal.timeout(1_000))).resolves.toEqual([
      expect.objectContaining({
        imageUrl: "https://cdn.example.test/composite-image.jpg",
        transientImageUrl: "https://cdn.example.test/composite-image.jpg?mo=signed",
        landingPageUrl: "https://shop.example.test/composite-image",
        title: "Composite speaker campaign",
        creator: "Acme Audio",
        source: "composite-42:2"
      })
    ]);
  });

  it("follows only a bounded trusted Snap next-link with the original POST body", async () => {
    const calls: Request[] = [];
    const provider = new SnapAdsProvider({ fetch: async (input, init) => {
      const call = new Request(input, init);
      calls.push(call.clone());
      if (calls.length === 1) return Response.json({
        request_status: "SUCCESS",
        paging: { next_link: "https://adsapi.snapchat.com/v1/ads_library/ads/search?cursor=opaque-next" },
        ad_previews: [{ ad_preview: { id: "video", top_snap_media_type: "VIDEO", top_snap_media_download_link: "https://cdn.example.test/video.mp4" } }]
      });
      return Response.json({
        request_status: "SUCCESS",
        paging: {},
        ad_previews: [{ ad_preview: { id: "image", headline: "Image ad", top_snap_media_type: "IMAGE", top_snap_media_download_link: "https://cdn.example.test/image.jpg" } }]
      });
    } });

    await expect(provider.search({ ...request, count: 1 }, AbortSignal.timeout(1_000))).resolves.toEqual([
      expect.objectContaining({ source: "image", imageUrl: "https://cdn.example.test/image.jpg" })
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe("https://adsapi.snapchat.com/v1/ads_library/ads/search?cursor=opaque-next&limit=1");
    expect(calls[1]!.method).toBe("POST");
    await expect(calls[1]!.json()).resolves.toEqual({ paying_advertiser_name: request.query });
  });

  it("does not follow a Snap next-link outside the documented API origin", async () => {
    let calls = 0;
    const provider = new SnapAdsProvider({ fetch: async () => {
      calls += 1;
      return Response.json({ request_status: "SUCCESS", paging: { next_link: "http://127.0.0.1/private" }, ad_previews: [] });
    } });

    await expect(provider.search(request, AbortSignal.timeout(1_000))).resolves.toEqual([]);
    expect(calls).toBe(1);
  });

  it("does not pretend page-number pagination can replay Snap's opaque cursor", async () => {
    let calls = 0;
    const provider = new SnapAdsProvider({ fetch: async () => { calls += 1; return Response.json({ ad_previews: [] }); } });

    await expect(provider.search({ ...request, page: 2 }, AbortSignal.timeout(1_000))).resolves.toEqual([]);
    expect(calls).toBe(0);
    expect(provider.supportsPagination).toBe(false);
  });
});
