---
name: search-web
description: Search the web using Perplexity AI API. Agent-local version.
---

# Skill: search-web

Search the web via Perplexity API for crossword clues and facts.

## Usage

```bash
search-web "your query"
```

## Examples

```bash
search-web "capital of Burkina Faso"
search-web "Shakespeare play with ghost crossword 6 letters"
search-web "meaning of Latin phrase 'carpe diem'"
```

## Scripts

- `{baseDir}/search.sh` — Main search script (uses `PERPLEXITY_API_KEY` from env)
