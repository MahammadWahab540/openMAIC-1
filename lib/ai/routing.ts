import { type LanguageModelV3 } from '@ai-sdk/provider';
import { getModel, parseModelString } from './providers';
import { classifyTask, TaskCategory, TASK_ROUTING_MAP } from './router';

/**
 * A simple fallback wrapper for LanguageModelV3.
 * Tries models in sequence until one succeeds.
 */
function createFallbackModel(models: LanguageModelV3[]): LanguageModelV3 {
  if (models.length === 0) throw new Error('No models provided for fallback');
  if (models.length === 1) return models[0];

  const firstModel = models[0];

  return {
    specificationVersion: 'v3', // Updated to v3 for AI SDK 6.x
    provider: firstModel.provider,
    modelId: `fallback(${models.map(m => m.modelId).join(',')})`,
    defaultObjectGenerationMode: firstModel.defaultObjectGenerationMode,
    doGenerate: async (params) => {
      let lastError;
      for (const model of models) {
        try {
          return await model.doGenerate(params);
        } catch (error) {
          lastError = error;
          console.error(`[AIRouting] Fallback: ${model.modelId} failed:`, error);
        }
      }
      throw lastError;
    },
    doStream: async (params) => {
      let lastError;
      for (const model of models) {
        try {
          return await model.doStream(params);
        } catch (error) {
          lastError = error;
          console.error(`[AIRouting] Fallback: ${model.modelId} failed:`, error);
        }
      }
      throw lastError;
    },
  } as LanguageModelV3;
}

/**
 * Returns a smart model based on the task description.
 * It classifies the task and selects the best model(s) for the job.
 */
export async function getSmartModel(task: string, geminiKey?: string): Promise<LanguageModelV3> {
  const category = await classifyTask(task, geminiKey || '');
  const candidates = TASK_ROUTING_MAP[category];

  console.log(`[AIRouting] Task classified as "${category}". Candidates: ${candidates.join(', ')}`);

  const models = candidates
    .map((m) => {
      try {
        const { providerId, modelId } = parseModelString(m);
        return getModel({ providerId, modelId }).model;
      } catch (e) {
        console.error(`[AIRouting] Failed to resolve model ${m}:`, e);
        return null;
      }
    })
    .filter((m): m is LanguageModelV3 => m !== null);

  if (models.length === 0) {
    throw new Error(`No valid models found for task category: ${category}`);
  }

  return createFallbackModel(models);
}
