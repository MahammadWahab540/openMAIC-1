'use client';

/**
 * useKokoroTTS — React hook around the Kokoro Web TTS Worker.
 *
 * Responsibilities:
 *  - Lazily spawn a singleton Worker per browser tab.
 *  - Expose loading/ready status, detected device (webgpu/wasm) and voices.
 *  - Provide `generate()` to produce a WAV Blob and cache it in IndexedDB
 *    (`db.audioFiles`) keyed by hash of {text, voice, speed, modelId}.
 *  - Provide `speak()` for one-shot playback honoring volume/mute/playbackSpeed
 *    from useSettingsStore.
 *  - Provide `pause()` / `resume()` / `cancel()` and `preload()`.
 *
 * Browser-only. Do not import from server code.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { db } from '@/lib/utils/database';
import { useSettingsStore } from '@/lib/store/settings';
import { createLogger } from '@/lib/logger';
import type { KokoroDevice, KokoroVoiceInfo, KokoroWorkerInput, KokoroWorkerOutput } from '@/lib/audio/kokoro/types';
import { TTS_PROVIDERS } from '@/lib/audio/constants';

const log = createLogger('KokoroTTS');

const DEFAULT_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

export type KokoroStatus = 'idle' | 'loading' | 'ready' | 'generating' | 'error';

interface PendingRequest {
  resolve: (blob: Blob) => void;
  reject: (err: Error) => void;
}

// One singleton worker per tab. We lazily initialise it on first use.
let workerInstance: Worker | null = null;
let workerInitPromise: Promise<Worker> | null = null;

// Subscribers receive every worker output for cross-hook coordination.
type Listener = (msg: KokoroWorkerOutput) => void;
const listeners = new Set<Listener>();

function getWorker(): Promise<Worker> {
  if (workerInstance) return Promise.resolve(workerInstance);
  if (workerInitPromise) return workerInitPromise;
  workerInitPromise = (async () => {
    const w = new Worker(new URL('../audio/kokoro/kokoro-worker.ts', import.meta.url), {
      type: 'module',
    });
    w.addEventListener('message', (ev: MessageEvent<KokoroWorkerOutput>) => {
      for (const listener of listeners) {
        try {
          listener(ev.data);
        } catch (err) {
          log.warn('Kokoro listener threw:', err);
        }
      }
    });
    workerInstance = w;
    return w;
  })();
  return workerInitPromise;
}

function uniqueId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return (crypto as Crypto).randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Stable (non-crypto) hash for cache keys. djb2-xor variant. */
export function kokoroCacheKey(params: {
  text: string;
  voice: string;
  speed: number;
  modelId: string;
}): string {
  const input = JSON.stringify(params);
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = (h * 33) ^ input.charCodeAt(i);
  }
  // Force unsigned and pad
  return `kokoro_${(h >>> 0).toString(36)}_${input.length}`;
}

interface GenerateOptions {
  voice?: string;
  speed?: number;
  requestId?: string;
  modelId?: string;
  /** Optional cache key override. When provided, the resulting Blob is stored
   *  in db.audioFiles under this id (used by scene generation). */
  audioId?: string;
  /** When true, look up audio by cacheKey/audioId in IndexedDB before invoking the worker. */
  useCache?: boolean;
}

interface SpeakOptions {
  voice?: string;
  speed?: number;
}

export interface UseKokoroTTSResult {
  status: KokoroStatus;
  device: KokoroDevice | null;
  voices: KokoroVoiceInfo[];
  error: string | null;
  preload: () => Promise<void>;
  generate: (text: string, options?: GenerateOptions) => Promise<Blob>;
  speak: (text: string, options?: SpeakOptions) => Promise<void>;
  pause: () => void;
  resume: () => void;
  cancel: () => void;
}

/** Module-scope playback element shared across hook instances on a page. */
let activeAudio: HTMLAudioElement | null = null;
let activeRequestId: string | null = null;

export function useKokoroTTS(): UseKokoroTTSResult {
  const [status, setStatus] = useState<KokoroStatus>('idle');
  const [device, setDevice] = useState<KokoroDevice | null>(null);
  const [voices, setVoices] = useState<KokoroVoiceInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  const pendingRef = useRef<Map<string, PendingRequest>>(new Map());

  // Settings used at speak() time
  const ttsVolume = useSettingsStore((s) => s.ttsVolume);
  const ttsMuted = useSettingsStore((s) => s.ttsMuted);
  const playbackSpeed = useSettingsStore((s) => s.playbackSpeed);
  const settingsRefs = useRef({ ttsVolume, ttsMuted, playbackSpeed });
  useEffect(() => {
    settingsRefs.current = { ttsVolume, ttsMuted, playbackSpeed };
  }, [ttsVolume, ttsMuted, playbackSpeed]);

  useEffect(() => {
    const listener: Listener = (msg) => {
      switch (msg.status) {
        case 'device':
          setDevice(msg.device);
          break;
        case 'loading':
          setStatus((prev) => (prev === 'idle' ? 'loading' : prev));
          break;
        case 'ready':
          setVoices(msg.voices);
          setDevice(msg.device);
          setStatus('ready');
          setError(null);
          break;
        case 'complete': {
          const pending = pendingRef.current.get(msg.requestId);
          if (pending) {
            pending.resolve(msg.audioBlob);
            pendingRef.current.delete(msg.requestId);
          }
          break;
        }
        case 'error': {
          if (msg.requestId) {
            const pending = pendingRef.current.get(msg.requestId);
            if (pending) {
              pending.reject(new Error(msg.error));
              pendingRef.current.delete(msg.requestId);
            }
          } else {
            setError(msg.error);
            setStatus('error');
          }
          break;
        }
        default:
          break;
      }
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  // Sync live volume/mute/playbackRate to currently-playing audio
  useEffect(() => {
    if (activeAudio) {
      activeAudio.volume = ttsMuted ? 0 : ttsVolume;
      activeAudio.playbackRate = playbackSpeed;
    }
  }, [ttsVolume, ttsMuted, playbackSpeed]);

  const preload = useCallback(async () => {
    setStatus((prev) => (prev === 'ready' ? prev : 'loading'));
    try {
      const worker = await getWorker();
      const initMsg: KokoroWorkerInput = { type: 'init', modelId: DEFAULT_MODEL_ID };
      worker.postMessage(initMsg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setStatus('error');
      throw err;
    }
  }, []);

  const generate = useCallback(
    async (text: string, options: GenerateOptions = {}): Promise<Blob> => {
      const provider = TTS_PROVIDERS['kokoro-web-tts'];
      const voice = options.voice || provider.voices[0]?.id || 'af_heart';
      const speed = options.speed ?? provider.speedRange?.default ?? 1.0;
      const modelId = options.modelId || DEFAULT_MODEL_ID;

      const cacheKey = options.audioId || kokoroCacheKey({ text, voice, speed, modelId });

      if (options.useCache !== false) {
        try {
          const existing = await db.audioFiles.get(cacheKey);
          if (existing?.blob) return existing.blob;
        } catch (err) {
          log.warn('IndexedDB lookup failed; will regenerate', err);
        }
      }

      setStatus('generating');
      const worker = await getWorker();
      const requestId = options.requestId || uniqueId();

      const blob = await new Promise<Blob>((resolve, reject) => {
        pendingRef.current.set(requestId, { resolve, reject });
        const msg: KokoroWorkerInput = {
          type: 'generate',
          requestId,
          text,
          voice,
          speed,
          modelId,
        };
        worker.postMessage(msg);
      });

      try {
        await db.audioFiles.put({
          id: cacheKey,
          blob,
          format: 'wav',
          text,
          voice,
          createdAt: Date.now(),
        });
      } catch (err) {
        log.warn('Failed to cache audio in IndexedDB', err);
      }

      setStatus('ready');
      return blob;
    },
    [],
  );

  const cancel = useCallback(() => {
    if (activeAudio) {
      activeAudio.pause();
      try {
        if (activeAudio.src.startsWith('blob:')) URL.revokeObjectURL(activeAudio.src);
      } catch {
        // ignore
      }
      activeAudio = null;
    }
    if (activeRequestId && workerInstance) {
      const cancelMsg: KokoroWorkerInput = { type: 'cancel', requestId: activeRequestId };
      workerInstance.postMessage(cancelMsg);
      const pending = pendingRef.current.get(activeRequestId);
      pending?.reject(new Error('cancelled'));
      pendingRef.current.delete(activeRequestId);
      activeRequestId = null;
    }
  }, []);

  const speak = useCallback(
    async (text: string, options: SpeakOptions = {}): Promise<void> => {
      cancel();
      const requestId = uniqueId();
      activeRequestId = requestId;
      const blob = await generate(text, { ...options, requestId });
      if (activeRequestId !== requestId) return; // cancelled
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.volume = settingsRefs.current.ttsMuted ? 0 : settingsRefs.current.ttsVolume;
      audio.playbackRate = settingsRefs.current.playbackSpeed;
      activeAudio = audio;
      await new Promise<void>((resolve) => {
        const cleanup = () => {
          URL.revokeObjectURL(url);
          if (activeAudio === audio) activeAudio = null;
          if (activeRequestId === requestId) activeRequestId = null;
          resolve();
        };
        audio.addEventListener('ended', cleanup, { once: true });
        audio.addEventListener('error', cleanup, { once: true });
        void audio.play().catch((err) => {
          log.warn('Audio.play() failed', err);
          cleanup();
        });
      });
    },
    [cancel, generate],
  );

  const pause = useCallback(() => {
    if (activeAudio && !activeAudio.paused) activeAudio.pause();
  }, []);

  const resume = useCallback(() => {
    if (activeAudio?.paused) {
      void activeAudio.play().catch((err) => log.warn('resume failed', err));
    }
  }, []);

  return useMemo(
    () => ({ status, device, voices, error, preload, generate, speak, pause, resume, cancel }),
    [status, device, voices, error, preload, generate, speak, pause, resume, cancel],
  );
}

/**
 * Non-hook generator for server-less (worker-only) callsites such as scene
 * generators that aren't React components. Uses the same singleton worker.
 */
export async function generateKokoroAudio(
  text: string,
  options: { voice: string; speed?: number; modelId?: string; audioId?: string; useCache?: boolean } = {
    voice: 'af_heart',
  },
): Promise<Blob> {
  const speed = options.speed ?? 1.0;
  const modelId = options.modelId || DEFAULT_MODEL_ID;
  const audioId = options.audioId || kokoroCacheKey({ text, voice: options.voice, speed, modelId });

  if (options.useCache !== false) {
    try {
      const existing = await db.audioFiles.get(audioId);
      if (existing?.blob) return existing.blob;
    } catch {
      // continue
    }
  }

  const worker = await getWorker();
  const requestId = uniqueId();
  const blob = await new Promise<Blob>((resolve, reject) => {
    const onMessage = (ev: MessageEvent<KokoroWorkerOutput>) => {
      const msg = ev.data;
      if (msg.status === 'complete' && msg.requestId === requestId) {
        worker.removeEventListener('message', onMessage);
        resolve(msg.audioBlob);
      } else if (msg.status === 'error' && msg.requestId === requestId) {
        worker.removeEventListener('message', onMessage);
        reject(new Error(msg.error));
      }
    };
    worker.addEventListener('message', onMessage);
    const msg: KokoroWorkerInput = {
      type: 'generate',
      requestId,
      text,
      voice: options.voice,
      speed,
      modelId,
    };
    worker.postMessage(msg);
  });

  try {
    await db.audioFiles.put({
      id: audioId,
      blob,
      format: 'wav',
      text,
      voice: options.voice,
      createdAt: Date.now(),
    });
  } catch {
    // cache failures are non-fatal
  }

  return blob;
}
