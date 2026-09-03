import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createJobRequestSchema, startSearchInputSchema } from "../../shared/contracts.js";
import { parseLabelPaths } from "../../shared/taxonomy.js";
import { JobsRepository } from "../repositories/jobs.js";
import { SearchRepository } from "../repositories/search.js";
import { SearchService } from "../services/search-service.js";

const jobPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  status: z.enum(["draft", "collecting", "reviewing", "ready", "failed"]).optional()
}).refine((patch) => patch.name !== undefined || patch.status !== undefined, { message: "Provide at least one job field to update." });

const jobCopySchema = z.object({ name: z.string().trim().min(1).max(120).optional() });

export function registerJobRoutes(app: FastifyInstance, jobs: JobsRepository, searches?: SearchRepository, searchService?: SearchService): void {
  app.get("/api/jobs", async () => ({ items: jobs.list() }));

  app.post("/api/jobs", async (request, reply) => {
    const input = createJobRequestSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ errors: input.error.issues });
    const taxonomy = parseLabelPaths(input.data.labelPaths);
    if (taxonomy.errors.length > 0) return reply.code(400).send({ errors: taxonomy.errors });
    return reply.code(201).send(jobs.create(input.data, taxonomy));
  });

  app.post<{ Params: { jobId: string } }>("/api/jobs/:jobId/copy", async (request, reply) => {
    const input = jobCopySchema.safeParse(request.body ?? {});
    if (!input.success) return reply.code(400).send({ errors: input.error.issues });
    const copied = jobs.copy(request.params.jobId, input.data.name);
    if (!copied) return reply.code(404).send({ error: "Job not found." });
    return reply.code(201).send(copied);
  });

  app.get<{ Params: { jobId: string } }>("/api/jobs/:jobId", async (request, reply) => {
    const job = jobs.get(request.params.jobId);
    if (!job) return reply.code(404).send({ error: "Job not found." });
    return job;
  });

  app.patch<{ Params: { jobId: string } }>("/api/jobs/:jobId", async (request, reply) => {
    const patch = jobPatchSchema.safeParse(request.body);
    if (!patch.success) return reply.code(400).send({ errors: patch.error.issues });
    const job = jobs.update(request.params.jobId, patch.data);
    if (!job) return reply.code(404).send({ error: "Job not found." });
    return job;
  });

  app.delete<{ Params: { jobId: string } }>("/api/jobs/:jobId", async (request, reply) => {
    if (!jobs.delete(request.params.jobId)) return reply.code(404).send({ error: "Job not found." });
    return reply.code(204).send();
  });

  if (!searches || !searchService) return;

  app.post<{ Params: { jobId: string } }>("/api/jobs/:jobId/search", async (request, reply) => {
    const input = startSearchInputSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ errors: input.error.issues });
    const result = searchService.startJobSearch(request.params.jobId, input.data.providerIds, input.data.retryFailedProviderIds);
    if (result === "missing_job") return reply.code(404).send({ error: "Job not found." });
    if (result === "unknown_provider") return reply.code(400).send({ error: "Requested provider is not available." });
    if (result === "disabled_provider") return reply.code(400).send({ error: "Requested provider is disabled." });
    if (result === "active") return reply.code(409).send({ error: "A search is already active for this job." });
    if (result === "exhausted") return reply.send({ status: "exhausted" });
    return reply.code(202).send({ status: "collecting" });
  });

  app.get<{ Params: { jobId: string }; Querystring: { cursor?: string; limit?: string } }>("/api/jobs/:jobId/candidates", async (request, reply) => {
    if (!jobs.get(request.params.jobId)) return reply.code(404).send({ error: "Job not found." });
    const cursor = request.query.cursor === undefined ? undefined : Number(request.query.cursor);
    const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
    if ((cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return reply.code(400).send({ error: "Invalid pagination." });
    }
    return { ...searches.listCandidates(request.params.jobId, cursor, limit), labelProgress: searches.labelProgress(request.params.jobId), providerRuns: searches.listPublicRuns(request.params.jobId) };
  });

  app.post<{ Params: { jobId: string } }>("/api/jobs/:jobId/pause", async (request, reply) => {
    if (!jobs.get(request.params.jobId)) return reply.code(404).send({ error: "Job not found." });
    const paused = searches.pausePending(request.params.jobId);
    return { paused };
  });

  app.get<{ Params: { jobId: string }; Querystring: { cursor?: string } }>("/api/jobs/:jobId/events", async (request, reply) => {
    if (!jobs.get(request.params.jobId)) return reply.code(404).send({ error: "Job not found." });
    const cursor = request.query.cursor === undefined ? undefined : Number(request.query.cursor);
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) return reply.code(400).send({ error: "Invalid cursor." });
    const items = searches.listEvents(request.params.jobId, cursor);
    return { items, nextCursor: items.at(-1)?.cursor ?? cursor ?? null };
  });
}
