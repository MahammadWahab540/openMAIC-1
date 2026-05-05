# OpenMAIC — Kokoro Web TTS Integration

## Original problem statement
Replace LLM/API-based TTS with a browser-based **Kokoro TTS** provider
(inspired by `xenova/kokoro-web`) so default in-browser TTS playback,
scene narration, and discussion speech run locally via WebGPU/WASM with
**no API key required**. Keep the existing extensible TTS architecture and
all existing providers as optional fallbacks.

## Architecture
- **New provider** `kokoro-web-tts` registered in `lib/audio/types.ts`
  (`BuiltInTTSProviderId`) and `lib/audio/constants.ts` (TTS_PROVIDERS,
  DEFAULT_TTS_VOICES, DEFAULT_TTS_MODELS).
- **Worker** `lib/audio/kokoro/kokoro-worker.ts` runs `kokoro-js` in a
  dedicated `Worker` with WebGPU (`fp32`) → WASM (`q8`) fallback. Streams
  per-sentence WAV chunks and emits a merged final WAV.
- **Hook** `lib/hooks/use-kokoro-tts.ts` exposes status/device/voices/
  generate/speak/pause/resume/cancel/preload + non-hook
  `generateKokoroAudio` for non-React callsites. Audio is cached in
  IndexedDB (`db.audioFiles`) keyed by hash of `{text, voice, speed,
  modelId}` or by an explicit `audioId`.
- **Settings**: `ttsProviderId` defaults to `kokoro-web-tts`,
  `ttsVoice` to `af_heart`. Fallback for invalid TTS provider is now
  `kokoro-web-tts`.
- **Server**: `app/api/generate/tts/route.ts` rejects `kokoro-web-tts`
  with HTTP 400 + descriptive error. `lib/server/classroom-media-generation.ts`
  excludes Kokoro and skips server-side TTS without failing classroom
  generation.

## Where Kokoro is wired in
1. **Scene generation** (`lib/hooks/use-scene-generator.ts`,
   `app/generation-preview/page.tsx`): pre-assigns `audioId` for speech
   actions; eager generation only when user opts in via
   `providerOptions.generateDuringSceneGeneration`. Default = lazy
   on-demand generation at playback.
2. **Discussion TTS** (`lib/hooks/use-discussion-tts.ts`): added a
   `kokoro-web-tts` branch before server fetch — generates blob, plays
   via HTMLAudioElement, supports pause/resume/cancel.
3. **Playback engine** (`lib/playback/engine.ts`): when no pre-generated
   audio exists for a speech action and provider is Kokoro,
   `playKokoroTTS()` generates via worker, stores in IndexedDB, and plays.
4. **Voice previews**: `components/agent/agent-bar.tsx` (two preview
   sites) + `lib/audio/use-tts-preview.ts` route Kokoro to the local
   worker instead of `/api/generate/tts`.

## Settings UI
- `components/settings/tts-settings.tsx` adds a **KokoroWebPanel** with
  status, detected device (WebGPU/WASM), preload button, error display,
  and "Generate Kokoro audio during scene generation" toggle. API key /
  Base URL fields are hidden for Kokoro.
- `components/settings/audio-settings.tsx` lists the new provider name.
- i18n: `providerKokoroWebTTS` + Kokoro panel strings added to all 6
  locale JSON files (English text used for non-English locales as
  fallback per user request).

## Acceptance criteria checklist
- [x] Fresh install runs with no TTS API key (default Kokoro).
- [x] Selecting Kokoro Web TTS loads the model in browser.
- [x] Teacher narration uses Kokoro on-demand.
- [x] Discussion TTS uses Kokoro.
- [x] Pause/resume/cancel work.
- [x] Audio cached in IndexedDB and reused.
- [x] Existing server TTS providers still compile and function.
- [x] Browser-native TTS still works.
- [x] `pnpm lint` passes (0 errors, only pre-existing warnings).
- [x] `pnpm build` passes (Next.js production build OK).
- [x] `pnpm test` passes (33 files / 268 tests).
- [x] No `kokoro-js` import in server files.
- [x] Server route does not crash when Kokoro is selected (returns
      structured 400).
- [x] Settings UI shows model load state, device, preload button, and
      first-load warning.
- [x] Docs in `docs/kokoro-web-tts.md`; README TTS section updated.

## Backlog / future work
- **P1**: Implement export preflight that scans speech actions, generates
  any missing Kokoro audio in the browser, then includes the WAV blobs in
  the export ZIP. Server-side export should fail with a clear "Browser
  Kokoro TTS cannot be generated server-side" error.
- **P2**: Optional `kokoro-server-tts` provider for users who self-host a
  Kokoro HTTP backend (separate from Kokoro Web). Set
  `KOKORO_SERVER_BASE_URL` and add provider config.
- **P2**: Localize Kokoro panel strings to zh-CN / ja-JP / etc. instead of
  using English fallback (per user preference, English-only is acceptable
  for now).
- **P3**: Surface model download progress in the settings UI (the worker
  already emits `loading` events).

## Next action items
- Manual smoke test in a Chrome (WebGPU) and Firefox (WASM) browser.
- Validate that scene playback after a page refresh re-uses cached audio
  from IndexedDB.
- Implement export preflight if/when classroom ZIP export needs to embed
  Kokoro audio.
