---
name: transcribe-audio
description: Transcribe an audio file (m4a, mp3, wav, ogg, webm) to text using OpenAI Whisper API. Use when a user shares a voice note or audio attachment.
---

# Skill: transcribe-audio

Transcribes audio files via OpenAI Whisper API. Supports m4a, mp3, mp4, wav, ogg, webm.
Max file size: 25MB. Returns plain text transcript.

## Usage

```bash
transcribe-audio /path/to/file.m4a
transcribe-audio /path/to/file.m4a --lang de   # hint language (ISO 639-1)
```

## Implementation

Script is at: {baseDir}/transcribe-audio.sh

Requires secret: `OPENAI-API-KEY` in Key Vault (fetched via get-secret).

## Notes

- Whisper auto-detects language if --lang not provided
- m4a files work natively — no conversion needed
- If file > 25MB, split with: `ffmpeg -i input.m4a -f segment -segment_time 300 -c copy out%03d.m4a`
- Transcript is printed to stdout — capture with: `text=$(transcribe-audio file.m4a)`
