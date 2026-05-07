import { after, type NextRequest } from 'next/server';
import { nanoid } from 'nanoid';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { type GenerateClassroomInput } from '@/lib/server/classroom-generation';
import { runClassroomGenerationJob } from '@/lib/server/classroom-job-runner';
import { createClassroomGenerationJob } from '@/lib/server/classroom-job-store';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';
import { createLogger } from '@/lib/logger';

const log = createLogger('GenerateClassroom API');

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  let requirementSnippet: string | undefined;
  try {
    const rawBody = (await req.json()) as any;

    // Handle both flat and Lumina-style nested structure
    const body: GenerateClassroomInput = {
      requirement: rawBody.generation_requirement?.requirement || rawBody.requirement || '',
      context: rawBody.generation_requirement?.context || rawBody.context,
      targetSceneCount: rawBody.generation_requirement?.targetSceneCount || rawBody.targetSceneCount,
      embedded: rawBody.metadata?.embedded || rawBody.embedded,
      pdfContent: rawBody.pdfContent,
      enableWebSearch: rawBody.generation_requirement?.enableWebSearch ?? rawBody.enableWebSearch,
      webSearchProviderId: rawBody.generation_requirement?.webSearchProviderId ?? rawBody.webSearchProviderId,
      webSearchApiKey: rawBody.generation_requirement?.webSearchApiKey ?? rawBody.webSearchApiKey,
      enableImageGeneration:
        rawBody.generation_requirement?.enableImageGeneration ?? rawBody.enableImageGeneration,
      enableVideoGeneration:
        rawBody.generation_requirement?.enableVideoGeneration ?? rawBody.enableVideoGeneration,
      enableTTS: rawBody.generation_requirement?.enableTTS ?? rawBody.enableTTS,
      agentMode: rawBody.generation_requirement?.agentMode ?? rawBody.agentMode,

      // Pass through new fields
      metadata: rawBody.metadata,
      learner_profile: rawBody.learner_profile,
      agents: rawBody.agents,
    };

    requirementSnippet = body.requirement?.substring(0, 60);

    if (!body.requirement) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: requirement');
    }

    const baseUrl = buildRequestOrigin(req);
    const jobId = nanoid(10);
    const job = await createClassroomGenerationJob(jobId, body);
    const pollUrl = `${baseUrl}/api/generate-classroom/${jobId}`;

    after(() => runClassroomGenerationJob(jobId, body, baseUrl));

    return apiSuccess(
      {
        jobId,
        status: job.status,
        step: job.step,
        message: job.message,
        pollUrl,
        pollIntervalMs: 5000,
      },
      202,
    );
  } catch (error) {
    log.error(
      `Classroom generation job creation failed [requirement="${requirementSnippet ?? 'unknown'}..."]:`,
      error,
    );
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Failed to create classroom generation job',
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}
