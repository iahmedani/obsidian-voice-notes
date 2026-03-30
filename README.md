# Voice Notes (Local Whisper)

Record voice notes and meetings with local Whisper transcription, speaker identification, and AI-powered meeting summaries.

## Features

- **Dictation mode** - real-time voice-to-text at your cursor position
- **Full voice notes** - record, transcribe, and save with audio playback
- **Meeting mode** - capture system audio + mic with live transcript sidebar
- **Speaker labels** - instant "Me" vs "Speaker" identification (macOS with ScreenCaptureKit)
- **AI meeting notes** - summaries, action items, and key decisions
- **Fully local** - no cloud transcription service, your audio never leaves your machine

## Requirements

- A Whisper transcription server running locally or via Docker
- macOS (Apple Silicon recommended) or any OS with Docker
- See [voice-notes-server](https://github.com/iahmedani/voice-notes-server) for server setup

## Quick start

1. Install this plugin from Obsidian Community Plugins
2. Set up the transcription server ([instructions](https://github.com/iahmedani/voice-notes-server))
3. In plugin settings, verify Server URL is `http://127.0.0.1:5678`
4. Click the microphone ribbon icon or run **Start dictation**

## Commands

| Command | Description |
| --- | --- |
| Toggle dictation | Start or stop real-time voice-to-text |
| Record full voice note | Open modal for record/stop/save workflow |
| Start meeting transcription | Begin meeting mode with system audio capture |
| Stop meeting transcription | End meeting and generate notes |
| Mark moment in meeting | Bookmark a moment during a meeting |
| Generate meeting notes from selection | Summarize selected text with AI |
| Check Whisper server status | Verify server connectivity |

## Meeting mode

Meeting mode captures both system audio (the other speakers) and your microphone, transcribes in real-time to a sidebar panel, and generates structured notes when you stop.

**Speaker identification**: On macOS 14+ with ScreenCaptureKit, speakers are labeled instantly by comparing system audio energy (them) vs mic energy (you). No server processing required.

**Post-meeting options** (configurable in settings):
- Transcript only
- AI summary with key decisions
- Full notes with action items, decisions, and follow-ups

## AI summarization

Supports three providers for meeting summaries and action extraction:
- **Anthropic** (Claude)
- **OpenAI** (GPT)
- **Ollama** (local, free)

Configure your provider and API key in Settings.

## Server setup

This plugin requires a companion transcription server. See [voice-notes-server](https://github.com/iahmedani/voice-notes-server) for:
- **Native macOS** (Apple Silicon MLX GPU) - fastest option
- **Docker** (any OS, CPU) - portable option
