# Discord Voice Plugin for Clawdbot

Real-time voice conversations in Discord voice channels. Join a voice channel, speak, and have your words transcribed, processed by Claude, and spoken back.

## Features

- **Join/Leave Voice Channels**: Via slash commands, CLI, or agent tool
- **Voice Activity Detection (VAD)**: Automatically detects when users are speaking
- **Speech-to-Text**: Whisper API (OpenAI) or Deepgram
- **Agent Integration**: Transcribed speech is routed through the Clawdbot agent
- **Text-to-Speech**: OpenAI TTS or ElevenLabs
- **Audio Playback**: Responses are spoken back in the voice channel

## Requirements

- Discord bot with voice permissions (Connect, Speak, Use Voice Activity)
- API keys for STT and TTS providers
- System dependencies for voice:
  - `ffmpeg` (audio processing)
  - Native build tools for `@discordjs/opus` and `sodium-native`

## Installation

### 1. Install System Dependencies

```bash
# Ubuntu/Debian
sudo apt-get install ffmpeg build-essential python3

# Fedora/RHEL
sudo dnf install ffmpeg gcc-c++ make python3

# macOS
brew install ffmpeg
```

### 2. Install Node Dependencies

```bash
cd ~/.clawdbot/extensions/discord-voice
npm install
```

### 3. Configure in clawdbot.json

```json5
{
  "plugins": {
    "entries": {
      "discord-voice": {
        "enabled": true,
        "config": {
          "sttProvider": "whisper",
          "ttsProvider": "openai",
          "ttsVoice": "nova",
          "vadSensitivity": "medium",
          "allowedUsers": [],  // Empty = allow all users
          "silenceThresholdMs": 1500,
          "maxRecordingMs": 30000,
          "openai": {
            "apiKey": "sk-..."  // Or use OPENAI_API_KEY env var
          }
        }
      }
    }
  }
}
```

### 4. Discord Bot Setup

Ensure your Discord bot has these permissions:
- **Connect** - Join voice channels
- **Speak** - Play audio
- **Use Voice Activity** - Detect when users speak

Add these to your bot's OAuth2 URL or configure in Discord Developer Portal.

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the plugin |
| `sttProvider` | string | `"whisper"` | `"whisper"` or `"deepgram"` |
| `ttsProvider` | string | `"openai"` | `"openai"` or `"elevenlabs"` |
| `ttsVoice` | string | `"nova"` | Voice ID for TTS |
| `vadSensitivity` | string | `"medium"` | `"low"`, `"medium"`, or `"high"` |
| `allowedUsers` | string[] | `[]` | User IDs allowed (empty = all) |
| `silenceThresholdMs` | number | `1500` | Silence before processing (ms) |
| `maxRecordingMs` | number | `30000` | Max recording length (ms) |

### Provider Configuration

#### OpenAI (Whisper + TTS)
```json5
{
  "openai": {
    "apiKey": "sk-...",
    "whisperModel": "whisper-1",
    "ttsModel": "tts-1"
  }
}
```

#### ElevenLabs (TTS only)
```json5
{
  "elevenlabs": {
    "apiKey": "...",
    "voiceId": "21m00Tcm4TlvDq8ikWAM",  // Rachel
    "modelId": "eleven_multilingual_v2"
  }
}
```

#### Deepgram (STT only)
```json5
{
  "deepgram": {
    "apiKey": "...",
    "model": "nova-2"
  }
}
```

## Usage

### Slash Commands (Discord)

Once registered with Discord, use these commands:
- `/voice join <channel>` - Join a voice channel
- `/voice leave` - Leave the current voice channel
- `/voice status` - Show voice connection status

### CLI Commands

```bash
# Join a voice channel
clawdbot voice join <channelId>

# Leave voice
clawdbot voice leave --guild <guildId>

# Check status
clawdbot voice status
```

### Agent Tool

The agent can use the `discord_voice` tool:
```
Join voice channel 1234567890
```

The tool supports actions:
- `join` - Join a voice channel (requires channelId)
- `leave` - Leave voice channel
- `speak` - Speak text in the voice channel
- `status` - Get current voice status

## How It Works

1. **Join**: Bot joins the specified voice channel
2. **Listen**: VAD detects when users start/stop speaking
3. **Record**: Audio is buffered while user speaks
4. **Transcribe**: On silence, audio is sent to STT provider
5. **Process**: Transcribed text is sent to Clawdbot agent
6. **Synthesize**: Agent response is converted to audio via TTS
7. **Play**: Audio is played back in the voice channel

## VAD Sensitivity

- **low**: Picks up quiet speech, may trigger on background noise
- **medium**: Balanced (recommended)
- **high**: Requires louder, clearer speech

## Troubleshooting

### "Discord client not available"
Ensure the Discord channel is configured and the bot is connected before using voice.

### Opus/Sodium build errors
Install build tools:
```bash
npm install -g node-gyp
npm rebuild @discordjs/opus sodium-native
```

### No audio heard
1. Check bot has Connect + Speak permissions
2. Check bot isn't server muted
3. Verify TTS API key is valid

### Transcription not working
1. Check STT API key is valid
2. Check audio is being recorded (see debug logs)
3. Try adjusting VAD sensitivity

### Enable debug logging
```bash
DEBUG=discord-voice clawdbot gateway start
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key (Whisper + TTS) |
| `ELEVENLABS_API_KEY` | ElevenLabs API key |
| `DEEPGRAM_API_KEY` | Deepgram API key |

## Limitations

- Only one voice channel per guild at a time
- Maximum recording length: 30 seconds (configurable)
- Requires stable network for real-time audio
- TTS output may have slight delay due to synthesis

## License

Same as Clawdbot.
