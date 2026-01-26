/**
 * Discord Voice Connection Manager
 * Handles joining, leaving, listening, and speaking in voice channels
 */

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  EndBehaviorType,
  StreamType,
  type VoiceConnection,
  type AudioPlayer,
  type AudioReceiveStream,
} from "@discordjs/voice";
import type {
  VoiceChannel,
  StageChannel,
  GuildMember,
  VoiceBasedChannel,
} from "discord.js";
import { Readable, PassThrough } from "stream";
import { pipeline } from "stream/promises";
import * as prism from "prism-media";

import type { DiscordVoiceConfig } from "./config.js";
import { getVadThreshold } from "./config.js";
import { createSTTProvider, type STTProvider } from "./stt.js";
import { createTTSProvider, type TTSProvider } from "./tts.js";

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug?(msg: string): void;
}

interface UserAudioState {
  chunks: Buffer[];
  lastActivityMs: number;
  isRecording: boolean;
  silenceTimer?: ReturnType<typeof setTimeout>;
}

export interface VoiceSession {
  guildId: string;
  channelId: string;
  connection: VoiceConnection;
  player: AudioPlayer;
  userAudioStates: Map<string, UserAudioState>;
  speaking: boolean;
}

export class VoiceConnectionManager {
  private sessions: Map<string, VoiceSession> = new Map();
  private config: DiscordVoiceConfig;
  private sttProvider: STTProvider | null = null;
  private ttsProvider: TTSProvider | null = null;
  private logger: Logger;
  private onTranscript: (userId: string, guildId: string, channelId: string, text: string) => Promise<string>;

  constructor(
    config: DiscordVoiceConfig,
    logger: Logger,
    onTranscript: (userId: string, guildId: string, channelId: string, text: string) => Promise<string>
  ) {
    this.config = config;
    this.logger = logger;
    this.onTranscript = onTranscript;
  }

  /**
   * Initialize providers lazily
   */
  private ensureProviders(): void {
    if (!this.sttProvider) {
      this.sttProvider = createSTTProvider(this.config);
    }
    if (!this.ttsProvider) {
      this.ttsProvider = createTTSProvider(this.config);
    }
  }

  /**
   * Join a voice channel
   */
  async join(channel: VoiceBasedChannel): Promise<VoiceSession> {
    const existingSession = this.sessions.get(channel.guildId);
    if (existingSession) {
      if (existingSession.channelId === channel.id) {
        return existingSession;
      }
      // Leave current channel first
      await this.leave(channel.guildId);
    }

    this.ensureProviders();

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false, // We need to hear users
      selfMute: false,
    });

    const player = createAudioPlayer();
    connection.subscribe(player);

    const session: VoiceSession = {
      guildId: channel.guildId,
      channelId: channel.id,
      connection,
      player,
      userAudioStates: new Map(),
      speaking: false,
    };

    this.sessions.set(channel.guildId, session);

    // Wait for the connection to be ready
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      this.logger.info(`[discord-voice] Joined voice channel ${channel.name} in ${channel.guild.name}`);
    } catch (error) {
      connection.destroy();
      this.sessions.delete(channel.guildId);
      throw new Error(`Failed to join voice channel: ${error}`);
    }

    // Start listening to users
    this.startListening(session);

    // Handle disconnection
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // Connection is recovering
      } catch {
        // Connection is not recovering, clean up
        connection.destroy();
        this.sessions.delete(channel.guildId);
        this.logger.info(`[discord-voice] Disconnected from voice channel in ${channel.guild.name}`);
      }
    });

    return session;
  }

  /**
   * Leave a voice channel
   */
  async leave(guildId: string): Promise<boolean> {
    const session = this.sessions.get(guildId);
    if (!session) {
      return false;
    }

    // Clear all timers
    for (const state of session.userAudioStates.values()) {
      if (state.silenceTimer) {
        clearTimeout(state.silenceTimer);
      }
    }

    session.connection.destroy();
    this.sessions.delete(guildId);
    this.logger.info(`[discord-voice] Left voice channel in guild ${guildId}`);
    return true;
  }

  /**
   * Start listening to voice in the channel
   */
  private startListening(session: VoiceSession): void {
    const receiver = session.connection.receiver;

    receiver.speaking.on("start", (userId: string) => {
      if (!this.isUserAllowed(userId)) {
        return;
      }

      // Don't listen while we're speaking
      if (session.speaking) {
        return;
      }

      this.logger.debug?.(`[discord-voice] User ${userId} started speaking`);
      
      let state = session.userAudioStates.get(userId);
      if (!state) {
        state = {
          chunks: [],
          lastActivityMs: Date.now(),
          isRecording: false,
        };
        session.userAudioStates.set(userId, state);
      }

      // Clear any existing silence timer
      if (state.silenceTimer) {
        clearTimeout(state.silenceTimer);
        state.silenceTimer = undefined;
      }

      if (!state.isRecording) {
        state.isRecording = true;
        state.chunks = [];
        this.startRecording(session, userId);
      }

      state.lastActivityMs = Date.now();
    });

    receiver.speaking.on("end", (userId: string) => {
      if (!this.isUserAllowed(userId)) {
        return;
      }

      this.logger.debug?.(`[discord-voice] User ${userId} stopped speaking`);
      
      const state = session.userAudioStates.get(userId);
      if (!state || !state.isRecording) {
        return;
      }

      state.lastActivityMs = Date.now();

      // Set silence timer to process the recording
      state.silenceTimer = setTimeout(async () => {
        if (state.isRecording && state.chunks.length > 0) {
          state.isRecording = false;
          await this.processRecording(session, userId, state.chunks);
          state.chunks = [];
        }
      }, this.config.silenceThresholdMs);
    });
  }

  /**
   * Start recording audio from a user
   */
  private startRecording(session: VoiceSession, userId: string): void {
    const state = session.userAudioStates.get(userId);
    if (!state) return;

    const opusStream = session.connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: this.config.silenceThresholdMs,
      },
    });

    // Decode Opus to PCM
    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 1,
      frameSize: 960,
    });

    opusStream.pipe(decoder);

    decoder.on("data", (chunk: Buffer) => {
      if (state.isRecording) {
        state.chunks.push(chunk);
        state.lastActivityMs = Date.now();

        // Check max recording length
        const totalSize = state.chunks.reduce((sum, c) => sum + c.length, 0);
        const durationMs = (totalSize / 2) / 48; // 16-bit samples at 48kHz
        if (durationMs >= this.config.maxRecordingMs) {
          this.logger.debug?.(`[discord-voice] Max recording length reached for user ${userId}`);
          state.isRecording = false;
          this.processRecording(session, userId, state.chunks);
          state.chunks = [];
        }
      }
    });

    decoder.on("end", () => {
      this.logger.debug?.(`[discord-voice] Decoder stream ended for user ${userId}`);
    });

    decoder.on("error", (error: Error) => {
      this.logger.error(`[discord-voice] Decoder error for user ${userId}: ${error.message}`);
    });
  }

  /**
   * Process recorded audio through STT and get response
   */
  private async processRecording(session: VoiceSession, userId: string, chunks: Buffer[]): Promise<void> {
    if (!this.sttProvider || !this.ttsProvider) {
      return;
    }

    const audioBuffer = Buffer.concat(chunks);
    
    // Skip very short recordings (likely noise)
    const durationMs = (audioBuffer.length / 2) / 48; // 16-bit samples at 48kHz
    if (durationMs < this.config.minAudioMs) {
      this.logger.debug?.(`[discord-voice] Skipping short recording (${Math.round(durationMs)}ms < ${this.config.minAudioMs}ms) for user ${userId}`);
      return;
    }

    this.logger.info(`[discord-voice] Processing ${Math.round(durationMs)}ms of audio from user ${userId}`);

    try {
      // Transcribe
      const sttResult = await this.sttProvider.transcribe(audioBuffer, 48000);
      
      if (!sttResult.text || sttResult.text.trim().length === 0) {
        this.logger.debug?.(`[discord-voice] Empty transcription for user ${userId}`);
        return;
      }

      this.logger.info(`[discord-voice] Transcribed: "${sttResult.text}"`);

      // Play looping thinking sound while processing
      const stopThinking = await this.startThinkingLoop(session);

      // Get response from agent
      const response = await this.onTranscript(userId, session.guildId, session.channelId, sttResult.text);
      
      // Stop thinking sound
      stopThinking();
      
      if (!response || response.trim().length === 0) {
        return;
      }

      // Synthesize and play response
      await this.speak(session.guildId, response);
    } catch (error) {
      this.logger.error(`[discord-voice] Error processing audio: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Speak text in the voice channel
   */
  async speak(guildId: string, text: string): Promise<void> {
    const session = this.sessions.get(guildId);
    if (!session) {
      throw new Error("Not connected to voice channel");
    }

    if (!this.ttsProvider) {
      this.ensureProviders();
    }

    if (!this.ttsProvider) {
      throw new Error("TTS provider not initialized");
    }

    session.speaking = true;

    try {
      this.logger.info(`[discord-voice] Speaking: "${text.substring(0, 50)}${text.length > 50 ? "..." : ""}"`);
      
      const ttsResult = await this.ttsProvider.synthesize(text);
      
      // Create audio resource based on format
      let resource;
      if (ttsResult.format === "opus") {
        resource = createAudioResource(Readable.from(ttsResult.audioBuffer), {
          inputType: StreamType.OggOpus,
        });
      } else {
        // For mp3, create a resource that will be transcoded
        resource = createAudioResource(Readable.from(ttsResult.audioBuffer));
      }

      session.player.play(resource);

      // Wait for playback to finish
      await new Promise<void>((resolve) => {
        session.player.once(AudioPlayerStatus.Idle, () => {
          session.speaking = false;
          resolve();
        });
        session.player.once("error", (error: Error) => {
          this.logger.error(`[discord-voice] Playback error: ${error.message}`);
          session.speaking = false;
          resolve();
        });
      });
    } catch (error) {
      session.speaking = false;
      throw error;
    }
  }

  /**
   * Start looping thinking sound, returns stop function
   */
  private async startThinkingLoop(session: VoiceSession): Promise<() => void> {
    let stopped = false;
    let thinkingPlayer: AudioPlayer | null = null;
    
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const thinkingPath = path.join(__dirname, "..", "assets", "thinking.mp3");
      
      if (!fs.existsSync(thinkingPath)) {
        return () => {};
      }

      const audioData = fs.readFileSync(thinkingPath);
      thinkingPlayer = createAudioPlayer();
      session.connection.subscribe(thinkingPlayer);

      const playLoop = () => {
        if (stopped || !thinkingPlayer) return;
        const resource = createAudioResource(Readable.from(Buffer.from(audioData)), {
          inlineVolume: true,
        });
        resource.volume?.setVolume(0.7);
        thinkingPlayer.play(resource);
      };

      thinkingPlayer.on(AudioPlayerStatus.Idle, playLoop);
      playLoop(); // Start first play

      return () => {
        stopped = true;
        if (thinkingPlayer) {
          thinkingPlayer.stop(true);
          thinkingPlayer.removeAllListeners();
        }
        // Re-subscribe main player
        session.connection.subscribe(session.player);
      };
    } catch (error) {
      this.logger.debug?.(`[discord-voice] Error starting thinking loop: ${error instanceof Error ? error.message : String(error)}`);
      return () => {
        if (thinkingPlayer) {
          thinkingPlayer.stop(true);
          thinkingPlayer.removeAllListeners();
        }
        session.connection.subscribe(session.player);
      };
    }
  }

  /**
   * Play thinking sound once (simple version - uses main player, no loop)
   */
  private async playThinkingSoundSimple(session: VoiceSession): Promise<void> {
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const thinkingPath = path.join(__dirname, "..", "assets", "thinking.mp3");
      
      if (!fs.existsSync(thinkingPath)) {
        return;
      }

      const audioBuffer = fs.readFileSync(thinkingPath);
      const resource = createAudioResource(Readable.from(audioBuffer), {
        inlineVolume: true,
      });
      resource.volume?.setVolume(0.5);
      
      session.player.play(resource);
      
      // Don't wait for it to finish - let it play while processing
      // The response TTS will interrupt it naturally
    } catch (error) {
      this.logger.debug?.(`[discord-voice] Error playing thinking sound: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Play thinking/processing sound while waiting for agent response (looping version - currently unused)
   */
  private async playThinkingSound(guildId: string): Promise<AudioPlayer | null> {
    const session = this.sessions.get(guildId);
    if (!session) {
      return null;
    }

    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      
      // Get the assets directory relative to this module
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const thinkingPath = path.join(__dirname, "..", "assets", "thinking.mp3");
      
      if (!fs.existsSync(thinkingPath)) {
        this.logger.debug?.(`[discord-voice] Thinking sound not found at ${thinkingPath}`);
        return null;
      }

      // Create a separate player for thinking sound so we can stop it independently
      const thinkingPlayer = createAudioPlayer();
      session.connection.subscribe(thinkingPlayer);
      
      const audioBuffer = fs.readFileSync(thinkingPath);
      const resource = createAudioResource(Readable.from(audioBuffer), {
        inlineVolume: true,
      });
      
      // Set volume for thinking sound
      resource.volume?.setVolume(0.6);
      
      thinkingPlayer.play(resource);
      
      // When thinking sound ends, loop it if player hasn't been stopped
      thinkingPlayer.on(AudioPlayerStatus.Idle, () => {
        if (thinkingPlayer.state.status !== "idle") return;
        // Re-create resource for looping
        try {
          const loopResource = createAudioResource(Readable.from(fs.readFileSync(thinkingPath)), {
            inlineVolume: true,
          });
          loopResource.volume?.setVolume(0.6);
          thinkingPlayer.play(loopResource);
        } catch {
          // Player was stopped, ignore
        }
      });

      return thinkingPlayer;
    } catch (error) {
      this.logger.debug?.(`[discord-voice] Error playing thinking sound: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Check if a user is allowed to use voice
   */
  private isUserAllowed(userId: string): boolean {
    if (this.config.allowedUsers.length === 0) {
      return true;
    }
    return this.config.allowedUsers.includes(userId);
  }

  /**
   * Get session for a guild
   */
  getSession(guildId: string): VoiceSession | undefined {
    return this.sessions.get(guildId);
  }

  /**
   * Get all active sessions
   */
  getAllSessions(): VoiceSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Destroy all connections
   */
  async destroy(): Promise<void> {
    const guildIds = Array.from(this.sessions.keys());
    for (const guildId of guildIds) {
      await this.leave(guildId);
    }
  }
}
