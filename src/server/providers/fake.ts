import type { ProviderId } from "../../shared/contracts.js";
import type { ImageSearchProvider, NormalizedHit } from "./types.js";

export function createFakeProvider(id: ProviderId, results: NormalizedHit[]): ImageSearchProvider {
  return {
    id, displayName: `${id} fake`, configured: true, maxResults: 100, supportsPagination: true, rightsPolicy: "open",
    credentialMode: "none", credentialVariables: [], sourceCategory: "general",
    freeTier: "本地测试夹具", docsUrl: "https://example.invalid/fake-provider", defaultSelected: false,
    async search() { return results; }
  };
}
