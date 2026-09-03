import { defaultLocalSettings, localSettingsSchema, type LocalSettings } from "../../shared/contracts.js";
import type { AppDatabase } from "../database.js";

const SETTING_NAMES = ["defaultLocale", "defaultCountry", "safeSearch", "cache", "contractualRightsDeclarations"] as const;
type SettingName = typeof SETTING_NAMES[number];

function cloneDefaults(): LocalSettings {
  return structuredClone(defaultLocalSettings);
}

export class SettingsRepository {
  public constructor(private readonly database: AppDatabase) {}

  public get(): LocalSettings {
    const rows = this.database.prepare("SELECT name, value_json FROM local_settings ORDER BY name").all() as unknown as Array<{ name: string; value_json: string }>;
    if (rows.length === 0) return cloneDefaults();
    const value = cloneDefaults() as unknown as Record<string, unknown>;
    for (const row of rows) {
      if (!SETTING_NAMES.includes(row.name as SettingName)) continue;
      value[row.name] = JSON.parse(row.value_json) as unknown;
    }
    return localSettingsSchema.parse(value);
  }

  public put(input: LocalSettings): LocalSettings {
    const settings = localSettingsSchema.parse(input);
    const upsert = this.database.prepare(`
      INSERT INTO local_settings (name, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `);
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      for (const name of SETTING_NAMES) upsert.run(name, JSON.stringify(settings[name]), now);
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
    return this.get();
  }

  public mergeContractualDeclarations(declarations: Record<string, boolean>): void {
    if (Object.keys(declarations).length === 0) return;
    const current = this.get();
    this.put({ ...current, contractualRightsDeclarations: { ...current.contractualRightsDeclarations, ...declarations } });
  }
}
