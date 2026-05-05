/**
 * Type definitions for the browser-side Kokoro TTS worker.
 *
 * The worker runs `kokoro-js` (which itself uses @huggingface/transformers) in a
 * dedicated Worker so model inference does not block the main thread. WebGPU is
 * preferred when available; otherwise the worker falls back to WASM.
 */

export type KokoroDevice = 'webgpu' | 'wasm';

export interface KokoroVoiceInfo {
  id: string;
  name?: string;
  language?: string;
  gender?: string;
}

/** Messages sent FROM the main thread TO the worker. */
export type KokoroWorkerInput =
  | {
      type: 'init';
      modelId?: string;
    }
  | {
      type: 'generate';
      requestId: string;
      text: string;
      voice: string;
      speed: number;
      modelId?: string;
    }
  | {
      type: 'cancel';
      requestId: string;
    };

/** Messages sent FROM the worker TO the main thread. */
export type KokoroWorkerOutput =
  | { status: 'device'; device: KokoroDevice }
  | { status: 'loading'; progress?: number; message?: string }
  | { status: 'ready'; voices: KokoroVoiceInfo[]; device: KokoroDevice }
  | {
      status: 'stream';
      requestId: string;
      chunk: { text: string; audioBlob: Blob };
    }
  | {
      status: 'complete';
      requestId: string;
      audioBlob: Blob;
      format: 'wav';
    }
  | { status: 'error'; requestId?: string; error: string };
