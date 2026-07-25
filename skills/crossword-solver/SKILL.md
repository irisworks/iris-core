---
name: crossword-solver
description: Solve crossword clues using web search. Returns the answer and explains the wordplay.
---

# Skill: crossword-solver

Solve cryptic, quick, and general crossword clues using web search.
Returns the answer and a clear explanation of the wordplay.

## Usage

```bash
# Basic clue
solve-crossword "Feline pet (3)"

# Cryptic clue with pattern
solve-crossword "Sounds like a measure of time (4)"

# Clue with answer length hint
solve-crossword "Noble gas, used in lighting (4)"
```

## Output

- **Answer**: The likely solution
- **Wordplay**: How the clue works — definitions, anagrams, homophones, double definitions, hidden words, reversals, charades, containers, etc.

## Examples

```bash
$ solve-crossword "Fastening device; sounds like 'you' (3)"
Answer: TIE
Wordplay: Homophone of "you" = TIE (fastening device)
```

## Scripts

- `{baseDir}/solve-crossword.sh` — Main solving script
