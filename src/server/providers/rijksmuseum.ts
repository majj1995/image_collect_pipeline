import type { ImageSearchProvider, NormalizedHit, ProviderSearchRequest } from "./types.js";
import { cappedCount, isRecord, requestJson, safeHttpUrl, stringValue } from "./common.js";

interface RijksmuseumOptions { fetch?: typeof globalThis.fetch; }

const ENTITY_ORIGINS = new Set(["https://id.rijksmuseum.nl", "https://data.rijksmuseum.nl"]);
const IMAGE_ORIGIN = "https://iiif.micr.io";
const IMAGE_ORIGINS = new Set([IMAGE_ORIGIN]);

function trustedUrl(value: unknown, origins: ReadonlySet<string>): string | null {
  const sanitized = safeHttpUrl(value);
  if (!sanitized) return null;
  const url = new URL(sanitized);
  return url.protocol === "https:" && origins.has(url.origin) ? url.toString() : null;
}

function linkedId(value: unknown): string | null {
  if (typeof value === "string") return trustedUrl(value, ENTITY_ORIGINS);
  if (!isRecord(value)) return null;
  return trustedUrl(value.id ?? value["@id"], ENTITY_ORIGINS);
}

function firstLinkedId(value: unknown): string | null {
  return Array.isArray(value) ? value.map(linkedId).find(Boolean) ?? null : linkedId(value);
}

function firstTrustedUrl(value: unknown, origins: ReadonlySet<string>): string | null {
  const values = Array.isArray(value) ? value : [value];
  for (const entry of values) {
    const raw = isRecord(entry) ? entry.id ?? entry["@id"] : entry;
    const trusted = trustedUrl(raw, origins);
    if (trusted) return trusted;
  }
  return null;
}

function rijksTitle(record: Record<string, unknown>): string | null {
  const identified = Array.isArray(record.identified_by) ? record.identified_by.filter(isRecord) : [];
  const named = identified.find((entry) => stringValue(entry.type)?.toLowerCase() === "name");
  return stringValue(named?.content) ?? identified.map((entry) => stringValue(entry.content)).find(Boolean) ?? null;
}

function rijksCreator(record: Record<string, unknown>): string | null {
  const creatorLabel = (value: unknown): string | null => {
    if (!isRecord(value)) return stringValue(value);
    const notationValues = Array.isArray(value.notation) ? value.notation : [value.notation];
    const notation = notationValues.map((entry) => isRecord(entry) ? stringValue(entry["@value"] ?? entry.value ?? entry.content) : stringValue(entry)).find(Boolean);
    return notation ?? stringValue(value._label ?? value.label ?? value.content);
  };
  const produced = isRecord(record.produced_by) ? record.produced_by : {};
  const parts = Array.isArray(produced.part) ? produced.part.filter(isRecord) : [];
  for (const part of parts) {
    const carried = Array.isArray(part.carried_out_by) ? part.carried_out_by : [part.carried_out_by];
    for (const creator of carried) {
      const label = creatorLabel(creator);
      if (label) return label;
    }
    const assignments = Array.isArray(part.assigned_by) ? part.assigned_by : [part.assigned_by];
    for (const assignment of assignments.filter(isRecord)) {
      const assigned = Array.isArray(assignment.assigned) ? assignment.assigned : [assignment.assigned];
      for (const creator of assigned) {
        const label = creatorLabel(creator);
        if (label) return label;
      }
    }
  }
  return null;
}

function framedEntityUrl(value: string): string | null {
  const trusted = trustedUrl(value, ENTITY_ORIGINS);
  if (!trusted) return null;
  const identity = new URL(trusted);
  const endpoint = new URL("https://data.rijksmuseum.nl/");
  endpoint.pathname = identity.pathname;
  if (endpoint.origin !== "https://data.rijksmuseum.nl") return null;
  endpoint.searchParams.set("_profile", "la-framed");
  return endpoint.toString();
}

function iiifUrls(value: unknown): { imageUrl: string; thumbnailUrl: string } | null {
  const trusted = firstTrustedUrl(value, IMAGE_ORIGINS);
  if (!trusted) return null;
  const url = new URL(trusted);
  if (url.search || url.hash) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  const identifier = segments[0];
  if (!identifier || identifier === "." || identifier === "..") return null;
  const base = `${IMAGE_ORIGIN}/${identifier}`;
  const imageUrl = segments[1] === "full" ? trusted : `${base}/full/max/0/default.jpg`;
  return { imageUrl, thumbnailUrl: `${base}/full/800,/0/default.jpg` };
}

export class RijksmuseumProvider implements ImageSearchProvider {
  public readonly id = "rijksmuseum" as const;
  public readonly displayName = "Rijksmuseum Data Services";
  public readonly rightsPolicy = "open" as const;
  public readonly credentialMode = "none" as const;
  public readonly credentialVariables = [] as const;
  public readonly sourceCategory = "culture" as const;
  public readonly freeTier = "免 Key，当前 Data Services 未公布固定额度";
  public readonly docsUrl = "https://data.rijksmuseum.nl/docs/search";
  public readonly defaultSelected = false;
  public readonly configured = false;
  public readonly maxResults = 10;
  public readonly supportsPagination = false;
  private readonly fetchImpl: typeof globalThis.fetch;

  public constructor(options: RijksmuseumOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  private async entity(url: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    const endpoint = framedEntityUrl(url);
    if (!endpoint) return {};
    return requestJson(this.id, this.fetchImpl, endpoint, {
      redirect: "error",
      signal,
      headers: { accept: "application/ld+json, application/json" }
    });
  }

  public async search(request: ProviderSearchRequest, signal: AbortSignal): Promise<NormalizedHit[]> {
    if ((request.page ?? 1) !== 1) return [];
    const count = cappedCount(request, this.maxResults);
    const makeEndpoint = (field: "title" | "description") => {
      const endpoint = new URL("https://data.rijksmuseum.nl/search/collection");
      endpoint.searchParams.set(field, request.query);
      endpoint.searchParams.set("imageAvailable", "true");
      return endpoint;
    };
    const roots: Array<Record<string, unknown>> = [];
    let firstRootFailure: unknown;
    for (const field of ["title", "description"] as const) {
      try {
        roots.push(await requestJson(this.id, this.fetchImpl, makeEndpoint(field), { signal, headers: { accept: "application/ld+json, application/json" } }));
      } catch (error) {
        if (signal.aborted) throw error;
        firstRootFailure ??= error;
      }
    }
    if (roots.length === 0 && firstRootFailure) throw firstRootFailure;
    const ids: string[] = [];
    for (const root of roots) {
      for (const value of Array.isArray(root.orderedItems) ? root.orderedItems : []) {
        const id = linkedId(value);
        if (id && !ids.includes(id)) ids.push(id);
        if (ids.length >= count) break;
      }
      if (ids.length >= count) break;
    }
    const hits: NormalizedHit[] = [];
    let completedChains = 0;
    let firstDetailFailure: unknown;
    for (const objectUrl of ids) {
      try {
        const object = await this.entity(objectUrl, signal);
        const visualUrl = firstLinkedId(object.shows);
        if (!visualUrl) { completedChains += 1; continue; }
        const visual = await this.entity(visualUrl, signal);
        const digitalUrl = firstLinkedId(visual.digitally_shown_by);
        if (!digitalUrl) { completedChains += 1; continue; }
        const digital = await this.entity(digitalUrl, signal);
        completedChains += 1;
        const image = iiifUrls(digital.access_point);
        if (!image) continue;
        hits.push({
          provider: this.id,
          rank: hits.length + 1,
          imageUrl: image.imageUrl,
          thumbnailUrl: image.thumbnailUrl,
          landingPageUrl: objectUrl,
          title: rijksTitle(object),
          creator: rijksCreator(object),
          licenseName: null,
          licenseUrl: null,
          width: null,
          height: null,
          sourceProvider: "Rijksmuseum",
          source: objectUrl,
          rightsStatus: "unknown"
        });
      } catch (error) {
        if (signal.aborted) throw error;
        firstDetailFailure ??= error;
      }
    }
    if (hits.length === 0 && completedChains === 0 && firstDetailFailure) throw firstDetailFailure;
    return hits;
  }
}
