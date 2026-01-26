/**
 * Discord Voice Plugin Configuration
 */

export interface DiscordVoiceConfig {
  enabled: boolean;
  sttProvider: "whisper" | "deepgram";
  ttsProvider: "openai" | "elevenlabs";
  ttsVoice: string;
  vadSensitivity: "low" | "medium" | "high";
  allowedUsers: string[];
  silenceThresholdMs: number;
  minAudioMs: number;
  maxRecordingMs: number;
  autoJoinChannel?: string; // Channel ID to auto-join on startup
  openai?: {
    apiKey?: string;
    whisperModel?: string;
    ttsModel?: string;
  };
  elevenlabs?: {
    apiKey?: string;
    voiceId?: string;
    modelId?: string;
  };
  deepgram?: {
    apiKey?: string;
    model?: string;
  };
}

export const DEFAULT_CONFIG: DiscordVoiceConfig = {
  enabled: true,
  sttProvider: "whisper",
  ttsProvider: "openai",
  ttsVoice: "nova",
  vadSensitivity: "medium",
  allowedUsers: [],
  silenceThresholdMs: 1500,
  minAudioMs: 500,
  maxRecordingMs: 30000,
};

export function parseConfig(raw: unknown): DiscordVoiceConfig {
  if (!raw || typeof raw !== "object") {
    return DEFAULT_CONFIG;
  }

  const obj = raw as Record<string, unknown>;

  return {
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : DEFAULT_CONFIG.enabled,
    sttProvider: obj.sttProvider === "deepgram" ? "deepgram" : "whisper",
    ttsProvider: obj.ttsProvider === "elevenlabs" ? "elevenlabs" : "openai",
    ttsVoice: typeof obj.ttsVoice === "string" ? obj.ttsVoice : DEFAULT_CONFIG.ttsVoice,
    vadSensitivity: ["low", "medium", "high"].includes(obj.vadSensitivity as string)
      ? (obj.vadSensitivity as "low" | "medium" | "high")
      : DEFAULT_CONFIG.vadSensitivity,
    allowedUsers: Array.isArray(obj.allowedUsers)
      ? obj.allowedUsers.filter((u): u is string => typeof u === "string")
      : [],
    silenceThresholdMs:
      typeof obj.silenceThresholdMs === "number"
        ? obj.silenceThresholdMs
        : DEFAULT_CONFIG.silenceThresholdMs,
    minAudioMs:
      typeof obj.minAudioMs === "number"
        ? obj.minAudioMs
        : DEFAULT_CONFIG.minAudioMs,
    maxRecordingMs:
      typeof obj.maxRecordingMs === "number"
        ? obj.maxRecordingMs
        : DEFAULT_CONFIG.maxRecordingMs,
    autoJoinChannel:
      typeof obj.autoJoinChannel === "string" && obj.autoJoinChannel.trim()
        ? obj.autoJoinChannel.trim()
        : undefined,
    openai: obj.openai && typeof obj.openai === "object"
      ? {
          apiKey: (obj.openai as Record<string, unknown>).apiKey as string | undefined,
          whisperModel: ((obj.openai as Record<string, unknown>).whisperModel as string) || "whisper-1",
          ttsModel: ((obj.openai as Record<string, unknown>).ttsModel as string) || "tts-1",
        }
      : undefined,
    elevenlabs: obj.elevenlabs && typeof obj.elevenlabs === "object"
      ? {
          apiKey: (obj.elevenlabs as Record<string, unknown>).apiKey as string | undefined,
          voiceId: (obj.elevenlabs as Record<string, unknown>).voiceId as string | undefined,
          modelId: ((obj.elevenlabs as Record<string, unknown>).modelId as string) || "eleven_multilingual_v2",
        }
      : undefined,
    deepgram: obj.deepgram && typeof obj.deepgram === "object"
      ? {
          apiKey: (obj.deepgram as Record<string, unknown>).apiKey as string | undefined,
          model: ((obj.deepgram as Record<string, unknown>).model as string) || "nova-2",
        }
      : undefined,
  };
}

/**
 * Get VAD threshold based on sensitivity setting
 */
export function getVadThreshold(sensitivity: "low" | "medium" | "high"): number {
  switch (sensitivity) {
    case "low":
      return 0.01; // Very sensitive - picks up quiet speech
    case "high":
      return 0.05; // Less sensitive - requires louder speech
    case "medium":
    default:
      return 0.02;
  }
}
