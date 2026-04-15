#!/usr/bin/env bash
# search-web — Search the web using Perplexity AI API
# Usage: search-web "your query"

set -euo pipefail

QUERY="${1:-}"
if [[ -z "$QUERY" ]]; then
  echo "Usage: search-web <query>" >&2
  echo "Example: search-web 'latest AI news'" >&2
  exit 1
fi

# Get API key from Key Vault
API_KEY=$(bash /iris/data/skills/get-secret/get-secret PERPLEXITY-API-KEY 2>/dev/null) || {
  echo "Error: PERPLEXITY-API-KEY not found in Key Vault" >&2
  echo "Set it with: az keyvault secret set --vault-name $IRIS_KEY_VAULT --name PERPLEXITY-API-KEY --value <key>" >&2
  exit 1
}

# Build JSON payload using jq to handle escaping
PAYLOAD=$(jq -n \
  --arg query "$QUERY" \
  '{
    model: "sonar-pro",
    messages: [
      {role: "system", content: "Be concise and factual. Include citations."},
      {role: "user", content: $query}
    ],
    max_tokens: 1000,
    temperature: 0.2
  }')

# Call Perplexity API
RESPONSE=$(curl -s -X POST https://api.perplexity.ai/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD") || {
  echo "Error: Failed to call Perplexity API" >&2
  exit 1
}

# Check for API errors
if echo "$RESPONSE" | jq -e '.error' >/dev/null 2>&1; then
  echo "API Error: $(echo "$RESPONSE" | jq -r '.error.message // .error' 2>/dev/null)" >&2
  exit 1
fi

# Extract and display answer
ANSWER=$(echo "$RESPONSE" | jq -r '.choices[0].message.content // empty' 2>/dev/null)
CITATIONS=$(echo "$RESPONSE" | jq -r '.citations // empty' 2>/dev/null)

if [[ -z "$ANSWER" ]]; then
  echo "Error: No answer returned from API" >&2
  exit 1
fi

echo "$ANSWER"

# Show citations if available
if [[ -n "$CITATIONS" ]] && [[ "$CITATIONS" != "null" ]] && [[ "$CITATIONS" != "[]" ]]; then
  echo ""
  echo "Sources:"
  echo "$CITATIONS" | jq -r '.[] | "  • " + .' 2>/dev/null || true
fi
