import type { FastifyInstance } from "fastify";
import type { ProviderRegistry } from "../providers/registry.js";
import { providerCatalogMetadata } from "../providers/types.js";

export function registerProviderRoutes(app: FastifyInstance, providers: ProviderRegistry): void {
  app.get("/api/providers", async () => ({
    items: providers.list().map((provider) => {
      const metadata = providerCatalogMetadata(provider);
      return {
        id: provider.id, displayName: provider.displayName, configured: provider.configured,
        enabled: providers.isEnabled(provider), rightsPolicy: provider.rightsPolicy,
        maxResults: provider.maxResults, ...metadata,
        credentialVariables: [...metadata.credentialVariables]
      };
    })
  }));
}
