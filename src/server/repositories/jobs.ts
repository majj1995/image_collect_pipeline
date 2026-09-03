import { randomUUID } from "node:crypto";
import type { AppDatabase } from "../database.js";
import type { CreateJobInput, Job, LabelTarget } from "../../shared/contracts.js";
import type { ParsedTaxonomy, TaxonomyNode } from "../../shared/taxonomy.js";

type JobStatus = Job["status"];

interface JobRow {
  id: string;
  name: string;
  task_type: CreateJobInput["taskType"];
  export_mode: CreateJobInput["exportMode"];
  status: JobStatus;
  settings_json: string;
  created_at: string;
  updated_at: string;
}

interface LabelRow {
  label_id: string;
  path_json: string;
  product: string;
  config_json: string;
  selected_count: number;
}

export interface JobDetail extends Job {
  labels: LabelTarget[];
}

export interface UpdateJobInput {
  name?: string;
  status?: JobStatus;
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    name: row.name,
    taskType: row.task_type,
    exportMode: row.export_mode,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toLabelTarget(row: LabelRow): LabelTarget {
  const config = JSON.parse(row.config_json) as Omit<LabelTarget, "id" | "jobId" | "path" | "product" | "selectedCount">;
  return {
    id: row.label_id,
    jobId: "",
    path: JSON.parse(row.path_json) as string[],
    product: row.product,
    styles: config.styles,
    aliases: config.aliases,
    requiredTerms: config.requiredTerms,
    excludedTerms: config.excludedTerms,
    ...(config.searchProfiles ? { searchProfiles: config.searchProfiles } : {}),
    targetCount: config.targetCount,
    candidateCount: config.candidateCount,
    selectedCount: row.selected_count
  };
}

export class JobsRepository {
  public constructor(private readonly database: AppDatabase) {}

  public create(input: CreateJobInput, taxonomy: ParsedTaxonomy, name = input.name): JobDetail {
    const id = randomUUID();
    const now = new Date().toISOString();
    const settings = JSON.stringify(input);
    const insertJob = this.database.prepare(`
      INSERT INTO jobs (id, name, task_type, export_mode, status, settings_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)
    `);
    const insertNode = this.database.prepare(`
      INSERT INTO taxonomy_nodes (job_id, label_id, parent_id, display_name, path_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertTarget = this.database.prepare(`
      INSERT INTO label_targets (job_id, label_id, product, config_json)
      VALUES (?, ?, ?, ?)
    `);

    this.database.exec("BEGIN IMMEDIATE;");
    try {
      insertJob.run(id, name, input.taskType, input.exportMode, settings, now, now);
      for (const node of taxonomy.nodes) {
        insertNode.run(id, node.id, node.parentId, node.displayName, JSON.stringify(node.path));
      }
      for (const [index, leaf] of taxonomy.leaves.entries()) {
        const searchProfile = input.labelSearchProfiles?.[index];
        const config = {
          styles: input.styles,
          aliases: input.aliases,
          requiredTerms: input.requiredTerms,
          excludedTerms: input.excludedTerms,
          ...(searchProfile ? { searchProfiles: { zh: searchProfile.zh, en: searchProfile.en } } : {}),
          targetCount: input.targetCount,
          candidateCount: input.candidateCount
        };
        insertTarget.run(id, leaf.id, leaf.displayName, JSON.stringify(config));
      }
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }

    return this.get(id)!;
  }

  public list(): Job[] {
    const rows = this.database.prepare("SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC").all() as unknown as JobRow[];
    return rows.map(toJob);
  }

  public get(id: string): JobDetail | undefined {
    const row = this.database.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as unknown as JobRow | undefined;
    if (!row) return undefined;
    const labels = (this.database.prepare(`
      SELECT targets.label_id, nodes.path_json, targets.product, targets.config_json, targets.selected_count
      FROM label_targets AS targets
      JOIN taxonomy_nodes AS nodes ON nodes.job_id = targets.job_id AND nodes.label_id = targets.label_id
      WHERE targets.job_id = ?
      ORDER BY targets.rowid ASC
    `).all(id) as unknown as LabelRow[]).map((label) => ({ ...toLabelTarget(label), jobId: id }));
    return { ...toJob(row), labels };
  }

  public update(id: string, patch: UpdateJobInput): JobDetail | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const now = new Date().toISOString();
    this.database.prepare("UPDATE jobs SET name = ?, status = ?, updated_at = ? WHERE id = ?").run(
      patch.name ?? existing.name,
      patch.status ?? existing.status,
      now,
      id
    );
    return this.get(id);
  }

  public getSearchPolicy(id: string): { taskType: CreateJobInput["taskType"]; allowedRiskCategories: NonNullable<CreateJobInput["allowedRiskCategories"]> } | undefined {
    const row = this.database.prepare("SELECT task_type, settings_json FROM jobs WHERE id = ?").get(id) as { task_type: CreateJobInput["taskType"]; settings_json: string } | undefined;
    if (!row) return undefined;
    const settings = JSON.parse(row.settings_json) as CreateJobInput;
    return { taskType: row.task_type, allowedRiskCategories: settings.allowedRiskCategories ?? [] };
  }

  public copy(id: string, name?: string): JobDetail | undefined {
    const row = this.database.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as unknown as JobRow | undefined;
    if (!row) return undefined;
    const settings = JSON.parse(row.settings_json) as CreateJobInput;
    const sourceNodes = this.database.prepare(`
      SELECT label_id, parent_id, display_name, path_json FROM taxonomy_nodes WHERE job_id = ? ORDER BY rowid ASC
    `).all(id) as unknown as Array<{ label_id: string; parent_id: string | null; display_name: string; path_json: string }>;
    const sourceLeaves = this.database.prepare(`
      SELECT label_id FROM label_targets WHERE job_id = ? ORDER BY rowid ASC
    `).all(id) as unknown as Array<{ label_id: string }>;
    const byId = new Map(sourceNodes.map((node) => [node.label_id, node]));
    const taxonomy: ParsedTaxonomy = {
      nodes: sourceNodes.map((node): TaxonomyNode => ({
        id: node.label_id,
        parentId: node.parent_id,
        displayName: node.display_name,
        path: JSON.parse(node.path_json) as string[]
      })),
      leaves: sourceLeaves.map((leaf) => {
        const node = byId.get(leaf.label_id)!;
        return { id: node.label_id, parentId: node.parent_id, displayName: node.display_name, path: JSON.parse(node.path_json) as string[] };
      }),
      errors: []
    };
    return this.create(settings, taxonomy, name ?? `${row.name} 副本`);
  }

  public delete(id: string): boolean {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database.prepare("DELETE FROM label_targets WHERE job_id = ?").run(id);
      const result = this.database.prepare("DELETE FROM jobs WHERE id = ?").run(id);
      this.database.exec("COMMIT;");
      return result.changes > 0;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }
}
