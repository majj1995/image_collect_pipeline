export type QueryVariantName = "exact_ad" | "parent_disambiguated" | "style_required" | "alias_required" | "english_ad" | "term_only";

export interface QueryTarget {
  labelPath: string[];
  product: string;
  aliases: string[];
  styles: string[];
  requiredTerms: string[];
  excludedTerms: string[];
}

export interface SearchProfileTarget {
  terms: string[];
  styles: string[];
  requiredTerms: string[];
  excludedTerms: string[];
}

export interface QueryVariant {
  name: QueryVariantName;
  query: string;
  excludedTerms: string[];
}

function uniqueTerms(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function exclusion(term: string): string {
  const normalized = term.replace(/["\\]/gu, " ").replace(/\s+/gu, " ").trim();
  return /\s/u.test(normalized) ? `-"${normalized}"` : `-${normalized}`;
}

export function planSearchProfileQueries(profile: SearchProfileTarget): QueryVariant[] {
  const terms = uniqueTerms(profile.terms);
  const styles = uniqueTerms(profile.styles);
  const required = uniqueTerms(profile.requiredTerms);
  const exclusions = uniqueTerms(profile.excludedTerms);
  const suffix = [...required, ...exclusions.map(exclusion)];
  const withConstraints = (parts: string[]) => [...parts.filter(Boolean), ...suffix].join(" ");
  const primaryTerm = terms[0];
  if (!primaryTerm) return [];
  const primaryStyle = styles[0] ?? "";
  const variants: QueryVariant[] = [
    { name: "exact_ad", query: withConstraints([primaryTerm, primaryStyle]), excludedTerms: exclusions },
    ...terms.slice(1).map((term): QueryVariant => ({
      name: "alias_required", query: withConstraints([term, primaryStyle]), excludedTerms: exclusions
    })),
    ...styles.slice(1).map((style): QueryVariant => ({
      name: "style_required", query: withConstraints([primaryTerm, style]), excludedTerms: exclusions
    }))
  ];
  const seen = new Set<string>();
  return variants.filter((variant) => {
    if (seen.has(variant.query)) return false;
    seen.add(variant.query);
    return true;
  });
}

export function planSupplementalSearchProfileQueries(profile: SearchProfileTarget): QueryVariant[] {
  const allTerms = uniqueTerms(profile.terms);
  const allStyles = uniqueTerms(profile.styles);
  const terms = allTerms.slice(1);
  const styles = allStyles.slice(1);
  const required = uniqueTerms(profile.requiredTerms);
  const exclusions = uniqueTerms(profile.excludedTerms);
  const suffix = [...required, ...exclusions.map(exclusion)];
  const withConstraints = (parts: string[]) => [...parts.filter(Boolean), ...suffix].join(" ");
  const variants: QueryVariant[] = [];
  if (allTerms.length === 1 && allStyles.length === 1) {
    variants.push({ name: "term_only", query: withConstraints([allTerms[0]]), excludedTerms: exclusions });
  }
  variants.push(...terms.flatMap((term) => styles.map((style): QueryVariant => ({
    name: "alias_required",
    query: withConstraints([term, style]),
    excludedTerms: exclusions
  }))));
  const seen = new Set<string>();
  return variants.filter((variant) => {
    if (seen.has(variant.query)) return false;
    seen.add(variant.query);
    return true;
  });
}

export function planQueries(target: QueryTarget): QueryVariant[] {
  const parent = target.labelPath.at(-2);
  const aliases = uniqueTerms(target.aliases);
  const styles = uniqueTerms(target.styles);
  const exclusions = uniqueTerms(target.excludedTerms);
  const required = uniqueTerms(target.requiredTerms);
  const suffix = [...required, ...exclusions.map(exclusion)];
  const withConstraints = (parts: string[]) => [...parts.filter(Boolean), ...suffix].join(" ");
  const primaryAlias = aliases[0] ?? target.product;
  const primaryStyle = styles[0] ?? "电商广告";
  const variants: QueryVariant[] = [
    { name: "exact_ad", query: withConstraints([target.product, "电商海报"]), excludedTerms: exclusions },
    { name: "parent_disambiguated", query: withConstraints([parent ?? "", target.product, "电商广告"]), excludedTerms: exclusions },
    { name: "style_required", query: withConstraints([primaryAlias, primaryStyle, "商品展示"]), excludedTerms: exclusions },
    ...aliases.slice(1).map((alias): QueryVariant => ({
      name: "alias_required", query: withConstraints([alias, primaryStyle, "商品展示"]), excludedTerms: exclusions
    })),
    ...styles.slice(1).map((style): QueryVariant => ({
      name: "style_required", query: withConstraints([primaryAlias, style, "商品展示"]), excludedTerms: exclusions
    })),
    { name: "english_ad", query: withConstraints([target.product, "product ad"]), excludedTerms: exclusions }
  ];
  const seen = new Set<string>();
  return variants.filter((variant) => {
    if (seen.has(variant.query)) return false;
    seen.add(variant.query);
    return true;
  });
}
