---
name: search-web
description: Search the web using Perplexity AI API. Returns sourced, up-to-date information.
---

# Skill: search-web

Perform web searches via Perplexity API. Returns AI-summarized results with citations.

## Usage

```bash
search-web "your search query"
```

## Examples

```bash
# Simple search
search-web "latest news on AI regulation 2025"

# Technical query  
search-web "Terraform Azure VM module examples"

# Current events
search-web "stock market today S&P 500"
```

## Configuration

Requires the `PERPLEXITY-API-KEY` secret, resolved via `get-secret`.
`bootstrap.sh` prompts for it as an optional step ("Set up web search
(Perplexity)?") — skip it there and add it later by re-running with
`--setup`, or set it directly.

On the default zero-cloud install, set it as an env var in `/iris/.env`:

```bash
PERPLEXITY_API_KEY=your-api-key-here
```

On the Key Vault profile:

```bash
az keyvault secret set --vault-name "$IRIS_KEY_VAULT" \
  --name PERPLEXITY-API-KEY \
  --value "your-api-key-here"
```

Get API key from: https://www.perplexity.ai/settings/api

## Output Format

Returns JSON with:
- `answer`: Summarized answer
- `sources`: Array of source URLs
- `model`: Perplexity model used

## Scripts

- `{baseDir}/search.sh` — Main search script
