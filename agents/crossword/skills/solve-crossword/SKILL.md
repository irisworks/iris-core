---
name: solve-crossword
description: Solve crossword puzzles — single clues, full grids, or cryptic crosswords.
---

# Skill: solve-crossword

Crossword solving methodology and response formatting.

## Workflow

When a user sends a crossword puzzle:

1. **Parse the input**
   - Extract each clue and its word length
   - Note any already-known letters (from grid intersections)
   - Identify the puzzle style (American, British, cryptic)

2. **Solve what you know first**
   - Start with clues that are definitions, common phrases, or short words
   - Use word-length + known letters to eliminate impossible answers

3. **Use the grid**
   - If letters at position 3 of an Across word are known from a Down word,
     only consider answers matching that pattern
   - Work iteratively: each solved word unlocks letters for crossing words

4. **Search for obscure clues**
   - Use `search-web` for: proper nouns, historical dates, foreign words,
     scientific terms, pop-culture references
   - Example: `search-web "ancient Greek poet crossword 5 letters"`
   - Example: `search-web "capital of Burkina Faso"`

5. **Handle cryptic clues** (if applicable)
   - Break into definition + wordplay
   - Common devices: anagrams, hidden words, reversals, homophones, charades
   - Search for tutorials/examples if stuck

6. **Format the response**
   - Present answers in a clean grid or numbered list
   - For ambiguous clues, show alternatives with brief reasoning
   - Include confidence level (Certain / Likely / Possible / Unsure)

## Example Session

**User:**
```
Across:
1. Feline pet (3)
3. Not false (4)
Down:
1. Frozen water (3)
2. Opposite of day (5)
```

**Agent response:**
```
Across:
1. CAT  (3) — Certain
3. TRUE (4) — Certain

Down:
1. ICE  (3) — Certain
2. NIGHT (5) — Certain

Grid:
C A T
I   R
E   U
    E
```

## Self-heal invocation

If web search fails repeatedly or the LLM produces garbled output, run:
```bash
self-heal --reason "Crossword solver stuck: <describe failure>" --severity warning
```
