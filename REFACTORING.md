# Refactoring Plan: Discord Voice Plugin

> Initialized 2025-02-13, updated after Merge PR #2 (optimize/refactor)

## Project Overview

**discord-voice** is an OpenClaw plugin for real-time voice conversations in Discord voice channels:

- **STT:** Whisper API, Deepgram (incl. streaming), Local Whisper (Xenova), OpenAI Transcribe (gpt4o-mini/transcribe/diarize)
- **TTS:** OpenAI, ElevenLabs, Kokoro (local)
- **Features:** VAD, streaming STT/TTS, barge-in, auto-reconnect, heartbeat, thinking sound

---

## Codebase Analysis

### File Structure & LOC (as of optimize/refactor)

| File | LOC | Role |
|------|-----|------|
| `index.ts` | ~555 | Plugin entry, gateway, tool, CLI, `handleTranscript` |
| `src/voice-connection.ts` | ~905 | VoiceManager: join/leave, recording, playback, heartbeat |
| `src/stt.ts` | ~350 | STT providers (Whisper, Deepgram, Local Whisper, OpenAI Transcribe) |
| `src/tts.ts` | ~210 | TTS providers (OpenAI, ElevenLabs, Kokoro) |
| `src/streaming-stt.ts` | ~415 | Deepgram streaming STT + manager |
| `src/streaming-tts.ts` | ~225 | Streaming TTS (OpenAI, ElevenLabs; Kokoro not supported) |
| `src/config.ts` | ~330 | Config parsing, VAD/RMS thresholds |
| `src/core-bridge.ts` | ~195 | Dynamic import to OpenClaw core |
| `src/constants.ts` | ~22 | Cooldowns, RMS thresholds |

**Total:** ~3,200 LOC

---

## Voice Pipeline & Latency (Snappy)

To make Discord Voice feel responsive and natural, these areas matter:

### Latency Chain (user speaks → bot responds)

1. **After speech ends** – `silenceThresholdMs` (default 800 ms) wait before processing
2. **STT** – Deepgram streaming (~1 s faster than batch), local Whisper is CPU-bound
3. **Agent** – Model choice, `thinkLevel` (default "off" for voice)
4. **TTS** – Streaming (OpenAI/ElevenLabs) vs batch (Kokoro)
5. **Playback** – Thinking sound stop + configurable delay before response

### Current Configuration (latency-friendly)

| Option | Default | Note |
|--------|---------|------|
| `silenceThresholdMs` | 800 | Lower (e.g. 500–800 ms) for faster response |
| `minAudioMs` | 300 | Too low → noise; too high → delayed response |
| `streamingSTT` | true | Use Deepgram streaming |
| `thinkLevel` | "off" | Faster agent responses |
| `sttProvider` | whisper | Deepgram + streaming recommended for low latency |

### Known Latency Considerations

- **Kokoro:** No streaming TTS → higher time-to-first-audio than OpenAI/ElevenLabs (unavoidable)

---

## Identified Issues

### 1. Monolithic Files

- **index.ts:** Gateway handlers, tool logic, CLI, Discord client, `handleTranscript`, session setup – all in one file
- **voice-connection.ts:** Recording, playback, heartbeat, reconnect, thinking sound, RMS – too many responsibilities

### 2. Code Duplication

- **Session/guild resolution** repeated in gateway methods and tool:
  ```ts
  if (!guildId) {
    const sessions = vm.getAllSessions();
    guildId = sessions[0]?.guildId;
  }
  ```
- **Channel validation** identical in gateway and tool
- **getRmsThreshold** (constants) vs **getVadThreshold** (config) – similar semantics, different scales

### 3. Magic Numbers & Constants

- `SPEAK_COOLDOWN_VAD_MS` (800) vs `SPEAK_COOLDOWN_PROCESSING_MS` (500)
- `minAudioMs`, `silenceThresholdMs` – defaults partly in config, partly hardcoded
- Thinking sound delay now configurable via `stopDelayMs`

### 4. Logging Inconsistency

- `streaming-stt.ts`: Logger injected ✅
- `index.ts` CLI: `console.log` / `console.error` (CLI context)
- `api.logger` not passed through everywhere

### 5. Types & Casts

- Multiple `as VoiceBasedChannel`, `as { guildId?: string }`
- `any` in CLI: `const prog = program as any`
- Missing shared types for gateway params / tool params

### 6. Infrastructure

- Smoke test present ✅ (incl. Local Whisper, Kokoro)
- `npm run typecheck` ✅
- No unit tests
- No ESLint/Prettier
- `assets/thinking.mp3` referenced but not in repo

### 7. Dependencies & Interfaces

- `core-bridge.ts` imports from `dist/` – plugin requires built OpenClaw
- `PluginApi` interface only defined locally in `index.ts`

---

## Refactoring Backlog (Prioritized)

### Phase 0: Voice Pipeline Latency ✅

0. [x] **Kokoro in createStreamingTTSProvider** – Return null for `ttsProvider: "kokoro"`, direct fallback to batch
1. [x] **silenceThresholdMs optimization** – Default reduced to 800 ms
2. [x] **Thinking sound delay** – `stopDelayMs` in thinkingSound config (default 50 ms, range 0–500 ms)

### Phase 1: Foundations ✅

1. [x] **Centralize constants** – `src/constants.ts`
2. [x] **Remove dead code** – `playThinkingSoundSimple` deleted
3. [x] **Unify logging** – Logger injected into StreamingSTTManager
4. [x] **Typecheck script** – `npm run typecheck`
5. [x] **Document assets** – README/config for `assets/thinking.mp3`

### Phase 2: Modularization

6. [ ] **Split index.ts**:
   - `src/plugin/register.ts` – Plugin registration
   - `src/plugin/gateway.ts` – Gateway methods
   - `src/plugin/tool.ts` – Agent tool
   - `src/plugin/cli.ts` – CLI commands
   - `src/plugin/transcript-handler.ts` – `handleTranscript` + session logic
7. [ ] **Split voice-connection.ts**:
   - `src/voice/connection-manager.ts` – Join/leave, sessions
   - `src/voice/recording.ts` – UserAudioState, startRecording, processRecording
   - `src/voice/playback.ts` – speak, stopSpeaking, thinking loop
   - `src/voice/heartbeat.ts` – Heartbeat + reconnect
8. [ ] **Shared helpers** – `resolveGuildFromSessions`, `validateVoiceChannel` in `src/utils/`

### Phase 3: Robustness & Tests

9. [ ] **ESLint + Prettier** – Project configuration
10. [ ] **Shared types** – `types.ts` for gateway params, tool params, PluginApi
11. [ ] **Unit tests** – At least for config, stt, tts (no network)
12. [ ] **Integration tests** (optional) – With mocks for Discord/APIs

### Phase 4: Optional

13. [ ] **Provider factory** – Unified factory for STT/TTS (incl. streaming)
14. [ ] **Dependency injection** – Logger, config as explicit dependencies
15. [ ] **Docs** – JSDoc/TSDoc for public APIs

---

## Quick Commands

```bash
# Typecheck (before/after refactoring)
npm run typecheck

# Smoke test (incl. Local Whisper, Kokoro)
npm run smoke-test

# Build
npm run build
```

---

## Next Steps

1. **Phase 0** done – Kokoro streaming fix, silenceThresholdMs, thinking delay
2. Then Phase 2 in small, backward-compatible steps
3. Before larger changes: ensure `npm run typecheck` and `npm run smoke-test` pass
