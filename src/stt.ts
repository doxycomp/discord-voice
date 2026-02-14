/**
 * Speech-to-Text providers
 */

import type { DiscordVoiceConfig } from "./config.js";

export interface STTResult {
  text: string;
  confidence?: number;
  language?: string;
}

export interface STTProvider {
  transcribe(audioBuffer: Buffer, sampleRate: number): Promise<STTResult>;
}

/**
 * OpenAI Whisper STT Provider
 */
export class WhisperSTT implements STTProvider {
  private apiKey: string;
  private model: string;

  constructor(config: DiscordVoiceConfig) {
    this.apiKey = config.openai?.apiKey || process.env.OPENAI_API_KEY || "";
    this.model = config.openai?.whisperModel || "whisper-1";

    if (!this.apiKey) {
      throw new Error("OpenAI API key required for Whisper STT");
    }
  }

  async transcribe(audioBuffer: Buffer, sampleRate: number): Promise<STTResult> {
    // Convert raw PCM to WAV format for Whisper API
    const wavBuffer = this.pcmToWav(audioBuffer, sampleRate);

    const formData = new FormData();
    formData.append("file", new Blob([new Uint8Array(wavBuffer)], { type: "audio/wav" }), "audio.wav");
    formData.append("model", this.model);
    formData.append("response_format", "json");

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Whisper API error: ${response.status} ${error}`);
    }

    const result = (await response.json()) as { text: string; language?: string };
    return {
      text: result.text.trim(),
      language: result.language,
    };
  }

  /**
   * Convert raw PCM audio to WAV format
   */
  private pcmToWav(pcmBuffer: Buffer, sampleRate: number): Buffer {
    const numChannels = 1; // Mono
    const bitsPerSample = 16;
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const dataSize = pcmBuffer.length;
    const headerSize = 44;
    const fileSize = headerSize + dataSize - 8;

    const buffer = Buffer.alloc(headerSize + dataSize);

    // RIFF header
    buffer.write("RIFF", 0);
    buffer.writeUInt32LE(fileSize, 4);
    buffer.write("WAVE", 8);

    // fmt chunk
    buffer.write("fmt ", 12);
    buffer.writeUInt32LE(16, 16); // Chunk size
    buffer.writeUInt16LE(1, 20); // Audio format (PCM)
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);

    // data chunk
    buffer.write("data", 36);
    buffer.writeUInt32LE(dataSize, 40);
    pcmBuffer.copy(buffer, headerSize);

    return buffer;
  }
}

/** Shared PCM-to-WAV conversion for OpenAI transcribe providers */
function pcmToWavOpenAI(pcmBuffer: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmBuffer.length;
  const headerSize = 44;
  const fileSize = headerSize + dataSize - 8;

  const buffer = Buffer.alloc(headerSize + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(fileSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(buffer, headerSize);
  return buffer;
}

/**
 * Generic OpenAI Transcribe STT Provider
 *
 * Uses the /audio/transcriptions endpoint with configurable models:
 * - gpt-4o-mini-transcribe (faster, lower cost)
 * - gpt-4o-transcribe (higher quality)
 * - gpt-4o-transcribe-diarize (speaker diarization)
 * See: https://platform.openai.com/docs/models
 */
export class OpenAITranscribeSTT implements STTProvider {
  private apiKey: string;
  private model: string;

  constructor(config: DiscordVoiceConfig, model: string) {
    this.apiKey = config.openai?.apiKey || process.env.OPENAI_API_KEY || "";
    this.model = model;

    if (!this.apiKey) {
      throw new Error("OpenAI API key required for OpenAI transcribe STT");
    }
  }

  async transcribe(audioBuffer: Buffer, sampleRate: number): Promise<STTResult> {
    const wavBuffer = pcmToWavOpenAI(audioBuffer, sampleRate);

    const formData = new FormData();
    formData.append("file", new Blob([new Uint8Array(wavBuffer)], { type: "audio/wav" }), "audio.wav");
    formData.append("model", this.model);
    formData.append("response_format", "json");

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI transcribe API error (${this.model}): ${response.status} ${error}`);
    }

    const result = (await response.json()) as {
      text?: string;
      language?: string;
      segments?: Array<{ text: string }>;
    };

    // gpt-4o-transcribe-diarize returns segments; plain models return text
    const text = result.text ?? (result.segments?.map((s) => s.text).join(" ") ?? "");
    return {
      text: text.trim(),
      language: result.language,
    };
  }
}

/**
 * Deepgram STT Provider
 */
export class DeepgramSTT implements STTProvider {
  private apiKey: string;
  private model: string;

  constructor(config: DiscordVoiceConfig) {
    this.apiKey = config.deepgram?.apiKey || process.env.DEEPGRAM_API_KEY || "";
    this.model = config.deepgram?.model || "nova-2";

    if (!this.apiKey) {
      throw new Error("Deepgram API key required for Deepgram STT");
    }
  }

  async transcribe(audioBuffer: Buffer, sampleRate: number): Promise<STTResult> {
    // Deepgram expects: encoding=linear16, sample_rate, channels=1
    const url = new URL("https://api.deepgram.com/v1/listen");
    url.searchParams.set("model", this.model);
    url.searchParams.set("encoding", "linear16");
    url.searchParams.set("sample_rate", sampleRate.toString());
    url.searchParams.set("channels", "1");
    url.searchParams.set("punctuate", "true");
    url.searchParams.set("smart_format", "true");

    const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          Authorization: `Token ${this.apiKey}`,
          "Content-Type": "application/octet-stream",
        },
        body: audioBuffer,
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Deepgram API error: ${response.status} ${error}`);
    }

    const result = (await response.json()) as {
      results?: {
        channels?: Array<{
          alternatives?: Array<{
            transcript?: string;
            confidence?: number;
          }>;
        }>;
      };
    };

    const transcript = result.results?.channels?.[0]?.alternatives?.[0];
    return {
      text: transcript?.transcript?.trim() || "",
      confidence: transcript?.confidence,
    };
  }
}

/** OpenAI transcribe model IDs */
export const OPENAI_TRANSCRIBE_MODELS = {
  "gpt4o-mini": "gpt-4o-mini-transcribe",
  "gpt4o-transcribe": "gpt-4o-transcribe",
  "gpt4o-transcribe-diarize": "gpt-4o-transcribe-diarize",
} as const;

/**
 * Create STT provider based on config
 */
export function createSTTProvider(config: DiscordVoiceConfig): STTProvider {
  switch (config.sttProvider) {
    case "deepgram":
      return new DeepgramSTT(config);
    case "gpt4o-mini":
    case "gpt4o-transcribe":
    case "gpt4o-transcribe-diarize":
      return new OpenAITranscribeSTT(config, OPENAI_TRANSCRIBE_MODELS[config.sttProvider]);
    case "whisper":
    default:
      return new WhisperSTT(config);
  }
}
