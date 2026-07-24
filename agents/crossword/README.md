# Crossword Solver Agent

A sub-agent that solves crossword puzzles via reasoning + web search.

## Quick Start

Talk to the agent via Iris bridge:
```
@crossword solve: Clue "Feline pet" (3)
```

Or send a full puzzle in the input format described in `MEMORY.md`.

## Skills

- `solve-crossword` — Main solving methodology and output formatting
- `search-web` — Web search via Perplexity API for obscure clues
- `self-heal` — Escalation to Iris on failures

## Architecture

- Container: `iris-crossword`
- Bridge port: 4100
- Model: inherited from host (`IRIS_PROVIDER` / `IRIS_MODEL`)
- Secrets mode: env (inherits `/iris/.env`)
