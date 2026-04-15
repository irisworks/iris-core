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

Requires `PERPLEXITY-API-KEY` in Azure Key Vault:

```bash
az keyvault secret set --vault-name iris-core-kv-51560915 \
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
