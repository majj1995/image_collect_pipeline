import { createHash } from "node:crypto";

export interface TaxonomyNode {
  id: string;
  parentId: string | null;
  displayName: string;
  path: string[];
}

export interface TaxonomyLeaf extends TaxonomyNode {}

export interface TaxonomyError {
  line: number;
  message: string;
}

export interface ParsedTaxonomy {
  nodes: TaxonomyNode[];
  leaves: TaxonomyLeaf[];
  errors: TaxonomyError[];
}

export function createLabelId(path: string[]): string {
  const digest = createHash("sha256").update(path.join("\u001f")).digest("hex").slice(0, 10).toUpperCase();
  return `L${digest}`;
}

export function normalizePath(input: string): string[] {
  return input
    .normalize("NFKC")
    .split(/\s*(?:>|\/|\t)\s*/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function parseLabelPaths(lines: string[]): ParsedTaxonomy {
  const nodes = new Map<string, TaxonomyNode>();
  const leaves: TaxonomyLeaf[] = [];
  const errors: TaxonomyError[] = [];
  const firstLineForPath = new Map<string, number>();

  for (const [index, input] of lines.entries()) {
    const line = index + 1;
    const rawParts = input.normalize("NFKC").split(/\s*(?:>|\/|\t)\s*/u).map((part) => part.trim());
    if (rawParts.some((part) => part.length === 0)) {
      errors.push({ line, message: "Path contains an empty hierarchy level." });
      continue;
    }

    const path = normalizePath(input);
    const key = path.join("\u001f");
    const firstLine = firstLineForPath.get(key);
    if (firstLine !== undefined) {
      errors.push({ line, message: `Duplicate normalized path; first defined on line ${firstLine}.` });
      continue;
    }
    firstLineForPath.set(key, line);

    for (let depth = 1; depth <= path.length; depth += 1) {
      const nodePath = path.slice(0, depth);
      const id = createLabelId(nodePath);
      if (!nodes.has(id)) {
        nodes.set(id, {
          id,
          parentId: depth === 1 ? null : createLabelId(nodePath.slice(0, -1)),
          displayName: nodePath.at(-1)!,
          path: nodePath
        });
      }
    }

    const leaf = nodes.get(createLabelId(path))!;
    leaves.push(leaf);
  }

  return { nodes: [...nodes.values()], leaves, errors };
}
