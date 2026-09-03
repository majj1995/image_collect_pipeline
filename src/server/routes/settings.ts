import type { FastifyInstance } from "fastify";
import { localSettingsSchema } from "../../shared/contracts.js";
import type { SettingsRepository } from "../repositories/settings.js";

const FORBIDDEN_KEY = /secret|token|password|credential|apikey/i;

function hasForbiddenKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenKey);
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    return FORBIDDEN_KEY.test(normalized) || hasForbiddenKey(nested);
  });
}

export function registerSettingsRoutes(app: FastifyInstance, settings: SettingsRepository): void {
  app.get("/api/settings", async () => settings.get());

  app.put("/api/settings", async (request, reply) => {
    if (hasForbiddenKey(request.body)) return reply.code(400).send({ error: "FORBIDDEN_SETTING_KEY" });
    const parsed = localSettingsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_SETTINGS", issues: parsed.error.issues });
    return settings.put(parsed.data);
  });
}
