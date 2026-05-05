/**
 * Kokoro Web TTS Worker
 *
 * Runs kokoro-js in a dedicated Web Worker. WebGPU is preferred for speed;
 * falls back to WASM (q8 quantized) when WebGPU is not available.
 *
 * NOTE: Only client-side code (hooks/components) should reference this file.
 * Importing it from server code or route handlers will fail because
 * `kokoro-js` is browser-only.
 *
 * Inspired by https://github.com/xenova/kokoro-web (worker.js).
 */

/// <reference lib="webworker" />

import { KokoroTTS, TextSplitterStream } from 'kokoro-js';
import type { KokoroDevice, KokoroVoiceInfo, KokoroWorkerInput, KokoroWorkerOutput } from './types';

// In a Worker `self` is the global; the explicit cast lets TypeScript narrow
// it to the DedicatedWorkerGlobalScope shape without redeclaring `self` (which
// breaks the ESLint parser).
const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

const DEFAULT_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

let ttsPromise: Promise<KokoroTTS> | null = null;
let device: KokoroDevice | null = null;
const cancelledRequests = new Set<string>();

function post(message: KokoroWorkerOutput, transfer?: Transferable[]) {
  if (transfer && transfer.length > 0) {
    ctx.postMessage(message, transfer);
  } else {
    ctx.postMessage(message);
  }
}

async function detectDevice(): Promise<KokoroDevice> {
  // navigator.gpu is the WebGPU entry point. Some browsers expose the property
  // but reject requestAdapter; treat that as "no WebGPU".
  try {
    const nav = (ctx as unknown as { navigator?: { gpu?: { requestAdapter?: () => Promise<unknown> } } })
      .navigator;
    if (nav?.gpu?.requestAdapter) {
      const adapter = await nav.gpu.requestAdapter();
      if (adapter) return 'webgpu';
    }
  } catch {
    // fall through to wasm
  }
  return 'wasm';
}

async function loadModel(modelId: string): Promise<KokoroTTS> {
  if (ttsPromise) return ttsPromise;
  ttsPromise = (async () => {
    device = await detectDevice();
    post({ status: 'device', device });
    const tts = await KokoroTTS.from_pretrained(modelId, {
      dtype: device === 'wasm' ? 'q8' : 'fp32',
      device,
      progress_callback: (info: unknown) => {
        // Forward generic progress info; do not throw on unknown shapes.
        const p = info as { progress?: number; status?: string; file?: string } | undefined;
        if (p && (p.status === 'progress' || p.status === 'download' || p.status === 'initiate')) {
          post({
            status: 'loading',
            progress: typeof p.progress === 'number' ? p.progress : undefined,
            message: p.file,
          });
        }
      },
    });
    const voices: KokoroVoiceInfo[] = Object.entries(tts.voices ?? {}).map(([id, info]) => {
      const v = info as { name?: string; language?: string; gender?: string };
      return { id, name: v.name, language: v.language, gender: v.gender };
    });
    post({ status: 'ready', voices, device: device! });
    return tts;
  })();
  return ttsPromise.catch((err) => {
    ttsPromise = null;
    throw err;
  });
}

/** Concatenate one or more WAV Blobs into a single WAV Blob. */
async function mergeWavBlobs(blobs: Blob[]): Promise<Blob> {
  if (blobs.length === 1) return blobs[0];

  const buffers = await Promise.all(blobs.map((b) => b.arrayBuffer()));

  // Strip 44-byte WAV header from all but the first; keep first header intact
  // and patch sizes. This is correct for 16-bit PCM WAV (kokoro-js output).
  const HEADER = 44;
  const first = new Uint8Array(buffers[0]);
  const tailBytes: Uint8Array[] = [];
  let totalDataBytes = first.byteLength - HEADER;
  for (let i = 1; i < buffers.length; i++) {
    const u8 = new Uint8Array(buffers[i]);
    const tail = u8.slice(HEADER);
    tailBytes.push(tail);
    totalDataBytes += tail.byteLength;
  }

  const totalLength = HEADER + totalDataBytes;
  const out = new Uint8Array(totalLength);
  out.set(first, 0);
  let offset = first.byteLength;
  for (const tail of tailBytes) {
    out.set(tail, offset);
    offset += tail.byteLength;
  }

  // Patch RIFF chunk size (bytes 4..8): file size - 8
  const view = new DataView(out.buffer);
  view.setUint32(4, totalLength - 8, true);
  // Patch data chunk size (bytes 40..44): total data bytes
  view.setUint32(40, totalDataBytes, true);

  return new Blob([out], { type: 'audio/wav' });
}

async function handleGenerate(input: Extract<KokoroWorkerInput, { type: 'generate' }>) {
  const { requestId, text, voice, speed, modelId } = input;
  try {
    const tts = await loadModel(modelId || DEFAULT_MODEL_ID);
    if (cancelledRequests.has(requestId)) {
      cancelledRequests.delete(requestId);
      return;
    }

    // Use a TextSplitterStream so we can emit per-sentence audio chunks while
    // still merging into one final WAV at the end.
    const splitter = new TextSplitterStream();
    splitter.push(text);
    splitter.close();

    // kokoro-js types `voice` as a literal union of known voice IDs. Our
    // worker accepts arbitrary voice strings (including ones from the runtime
    // voice list), so cast through a permissive shape. We invoke via an arrow
    // wrapper so `this` stays bound to the KokoroTTS instance.
    type StreamFn = (
      input: TextSplitterStream,
      opts: { voice: string; speed: number },
    ) => AsyncIterable<{ text: string; audio: { toBlob(): Blob } }>;
    const stream = (tts.stream as unknown as StreamFn).call(tts, splitter, { voice, speed });

    const collected: Blob[] = [];
    for await (const chunk of stream) {
      if (cancelledRequests.has(requestId)) {
        cancelledRequests.delete(requestId);
        return;
      }
      const audioBlob = chunk.audio.toBlob();
      collected.push(audioBlob);
      post({
        status: 'stream',
        requestId,
        chunk: { text: chunk.text, audioBlob },
      });
    }

    if (cancelledRequests.has(requestId)) {
      cancelledRequests.delete(requestId);
      return;
    }

    const merged = collected.length > 0 ? await mergeWavBlobs(collected) : new Blob([], { type: 'audio/wav' });
    post({ status: 'complete', requestId, audioBlob: merged, format: 'wav' });
  } catch (error) {
    post({
      status: 'error',
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

self.addEventListener('message', (event: MessageEvent<KokoroWorkerInput>) => {
  const input = event.data;
  if (!input) return;
  switch (input.type) {
    case 'init':
      void loadModel(input.modelId || DEFAULT_MODEL_ID).catch((err) => {
        post({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      });
      break;
    case 'generate':
      void handleGenerate(input);
      break;
    case 'cancel':
      cancelledRequests.add(input.requestId);
      break;
    default:
      break;
  }
});