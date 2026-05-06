#!/usr/bin/env bash
# transcribe-audio — transcribe audio to text via OpenAI Whisper API
set -euo pipefail

AUDIO_FILE="${1:-}"
LANG=""

if [[ -z "$AUDIO_FILE" ]]; then
  echo "Usage: transcribe-audio <file> [--lang <iso-code>]" >&2
  exit 1
fi

shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --lang) LANG="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ ! -f "$AUDIO_FILE" ]]; then
  echo "File not found: $AUDIO_FILE" >&2
  exit 1
fi

# Get API key via abstraction
if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  OPENAI_API_KEY=$(get-secret OPENAI-API-KEY 2>/dev/null || true)
fi

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "Error: OPENAI-API-KEY not found in Key Vault or environment" >&2
  exit 1
fi

# Build curl args
CURL_ARGS=(
  -s
  -X POST
  https://api.openai.com/v1/audio/transcriptions
  -H "Authorization: Bearer ${OPENAI_API_KEY}"
  -F "model=whisper-1"
  -F "response_format=text"
  -F "file=@${AUDIO_FILE}"
)

if [[ -n "$LANG" ]]; then
  CURL_ARGS+=(-F "language=${LANG}")
fi

RESULT=$(curl "${CURL_ARGS[@]}")

# Check for API error
if echo "$RESULT" | grep -q '"error"'; then
  echo "Whisper API error: $RESULT" >&2
  exit 1
fi

echo "$RESULT"
