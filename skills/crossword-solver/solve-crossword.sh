#!/usr/bin/env bash
# solve-crossword — Solve a crossword clue using web search
# Usage: solve-crossword "clue text (optional length)"

set -euo pipefail

CLUE="${1:-}"
if [[ -z "$CLUE" ]]; then
  echo "Usage: solve-crossword <crossword clue>" >&2
  echo "Example: solve-crossword 'Feline pet (3)'" >&2
  exit 1
fi

# Build a rich prompt for the solver
PROMPT="You are an expert crossword solver. Solve this clue and explain the wordplay clearly.

Clue: \"$CLUE\"

Format your response EXACTLY as:
**Answer:** <answer>
**Wordplay:** <concise explanation>

If there are multiple plausible answers, list the most likely one first and briefly mention alternatives.
Keep wordplay explanations under 3 sentences."

# Call search-web skill
RESULT=$(bash /iris/data/skills/search-web/search.sh "$PROMPT" 2>/dev/null) || {
  echo "Error: Failed to search for crossword solution." >&2
  exit 1
}

echo "$RESULT"
