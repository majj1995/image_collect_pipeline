import type { FastifyInstance } from "fastify";
import { reviewInputSchema } from "../../shared/contracts.js";
import { JobsRepository } from "../repositories/jobs.js";
import { ReviewsRepository, ReviewValidationError } from "../repositories/reviews.js";
import type { SearchService } from "../services/search-service.js";

export function registerReviewRoutes(app: FastifyInstance, jobs: JobsRepository, reviews: ReviewsRepository, searchService?: Pick<SearchService, "resumeCandidateMaterialization">): void {
  app.post<{ Params: { jobId: string } }>("/api/jobs/:jobId/reviews", async (request, reply) => {
    const input = reviewInputSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ errors: input.error.issues });
    const job = jobs.get(request.params.jobId);
    if (!job) return reply.code(404).send({ error: "Job not found." });
    try {
      const items = reviews.apply(job.id, input.data, job.taskType);
      if (input.data.action === "restore") searchService?.resumeCandidateMaterialization(items.map((item) => item.candidateId));
      return { items };
    }
    catch (error) {
      if (error instanceof ReviewValidationError) return reply.code(error.code === "TAXONOMY_LABEL_CONFLICT" ? 409 : 400).send({ error: error.code });
      throw error;
    }
  });
}
