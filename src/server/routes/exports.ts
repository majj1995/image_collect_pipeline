import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import { JobsRepository } from "../repositories/jobs.js";
import { ExportService } from "../services/export-service.js";

export function registerExportRoutes(app: FastifyInstance, jobs: JobsRepository, exports: ExportService): void {
  app.get<{ Params: { jobId: string } }>("/api/jobs/:jobId/exports/preflight", async (request, reply) => {
    if (!jobs.get(request.params.jobId)) return reply.code(404).send({ error: "Job not found." });
    return exports.preflight(request.params.jobId).preflight;
  });
  app.post<{ Params: { jobId: string } }>("/api/jobs/:jobId/exports", async (request, reply) => {
    const result = exports.create(request.params.jobId);
    if (result.code === "JOB_NOT_FOUND") return reply.code(404).send({ error: "Job not found." });
    if (result.code === "NO_SELECTED_ITEMS") return reply.code(409).send({ error: result.code, preflight: result.preflight });
    if (result.code === "PREFLIGHT_BLOCKED") return reply.code(409).send({ error: result.code, preflight: result.preflight });
    return reply.code(202).send({ id: result.record!.id, status: result.record!.status, preflight: result.preflight });
  });
  app.get<{ Params: { exportId: string } }>("/api/exports/:exportId", async (request, reply) => {
    const record = exports.get(request.params.exportId);
    if (!record) return reply.code(404).send({ error: "Export not found." });
    return { id: record.id, jobId: record.jobId, status: record.status, preflight: record.preflight, errorCode: record.errorCode, zipSha256: record.status === "ready" ? record.zipSha256 : null };
  });
  app.get<{ Params: { exportId: string } }>("/api/exports/:exportId/download", async (request, reply) => {
    const download = await exports.download(request.params.exportId);
    if (!download) return reply.code(404).send({ error: "Export download not ready." });
    return reply.header("content-type", "application/zip").header("content-disposition", `attachment; filename=\"${download.name}\"`).send(createReadStream(download.path));
  });
}
