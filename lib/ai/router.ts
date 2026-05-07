import { streamText, generateText } from 'ai';
import { getModel } from './providers';
import { ProviderId } from '../lib/types/provider';

export type TaskCategory = 'simple' | 'medium' | 'complex' | 'creative';

export interface ModelRoutingEntry {
  model: string; // provider:model format
  cost: 'low' | 'medium' | 'high';
}

/**
 * Task-to-Model mapping for the smart router.
 * Models are listed in priority order for each category.
 */
export const TASK_ROUTING_MAP: Record<TaskCategory, string[]> = {
  simple: [
    'google:gemini-1.5-flash',
    'openai:gpt-4o-mini',
    'mistral:mistral-small-latest',
  ],
  medium: [
    'google:gemini-1.5-flash',
    'openai:gpt-4o-mini',
    'mistral:mistral-medium-latest',
  ],
  complex: [
    'openai:gpt-4o',
    'google:gemini-1.5-pro',
    'mistral:mistral-large-latest',
  ],
  creative: [
    'grok:grok-beta',
    'mistral:mistral-large-latest',
    'openai:gpt-4o',
  ],
};

/**
 * Heuristic-based classification for quick fallback.
 */
function heuristicClassify(prompt: string): TaskCategory {
  const p = prompt.toLowerCase();
  if (p.includes('code') || p.includes('function') || p.includes('bug') || p.includes('complex') || p.includes('algorithm')) return 'complex';
  if (p.includes('write a story') || p.includes('poem') || p.includes('creative') || p.includes('imagine')) return 'creative';
  if (p.length < 50) return 'simple';
  return 'medium';
}

/**
 * Classifies a prompt into a task category.
 */
export async function classifyTask(prompt: string, apiKey?: string): Promise<TaskCategory> {
  if (!apiKey) {
    return heuristicClassify(prompt);
  }

  try {
    // Use a fast, cheap model for classification
    const { model } = getModel({
      providerId: 'google',
      modelId: 'gemini-1.5-flash',
      apiKey,
    });

    const { text } = await generateText({
      model,
      system: 'Classify the following user prompt into one of these categories: simple, medium, complex, creative. \n' +
              '- simple: short greetings, simple facts, casual talk.\n' +
              '- medium: summarization, explaining concepts, general tasks.\n' +
              '- complex: coding, advanced math, logical puzzles, deep analysis.\n' +
              '- creative: writing stories, poetry, brainstorming ideas.\n' +
              'Respond with ONLY the category name.',
      prompt,
    });

    const category = text.trim().toLowerCase() as TaskCategory;
    if (['simple', 'medium', 'complex', 'creative'].includes(category)) {
      return category;
    }
    return heuristicClassify(prompt); 
  } catch (error) {
    console.error('[AIRouter] Task classification failed, using heuristic:', error);
    return heuristicClassify(prompt);
  }
}

/**
 * Gets the best models for a given prompt based on task analysis.
 */
export async function getSmartRoutingList(prompt: string, apiKey: string): Promise<string[]> {
  const category = await classifyTask(prompt, apiKey);
  console.log(`[AIRouter] Task classified as: ${category}`);
  return TASK_ROUTING_MAP[category];
}
