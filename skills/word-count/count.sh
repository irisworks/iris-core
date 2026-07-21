#!/usr/bin/env bash
# word-count — count words, lines, and characters in input text
set -euo pipefail

TEXT="${1:-}"

WORDS=$(echo -n "$TEXT" | wc -w | tr -d ' ')
LINES=$(echo -n "$TEXT" | awk 'END {print NR}')
CHARS=$(echo -n "$TEXT" | wc -c | tr -d ' ')

echo "Words:   $WORDS"
echo "Lines:   $LINES"
echo "Chars:   $CHARS"
