---
name: word-count
description: Count words, lines, and characters in a text string.
---

# Skill: word-count

Count words, lines, and characters in arbitrary text.

## Usage

```bash
word-count "your text here"
```

## Examples

```bash
# Inline text
word-count "Hello world\nThis is a test"

# From file
word-count "$(cat file.txt)"
```

## Output Format

```
Words:   5
Lines:   2
Chars:   24
```

## Scripts

- `{baseDir}/count.sh` — Main counting script
