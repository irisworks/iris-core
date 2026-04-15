---
name: store-file
description: Persist files through the storage abstraction rather than writing to arbitrary paths.
---

# Skill: store-file

Store a file durably. Always use this skill instead of writing to arbitrary paths.
Today it writes to the local VM filesystem under `/iris/data/`.
Future: swap to Azure Blob Storage, S3, or GCS without changing any other skill.

## Usage

```
store-file <relative-path> <content>
```

Or pipe content:
```
echo "content" | store-file <relative-path>
```

## Implementation

```bash
#!/usr/bin/env bash
# store-file — cloud-portable file storage
set -euo pipefail

STORAGE_ROOT="${IRIS_STORAGE_ROOT:-/iris/data}"
REL_PATH="${1:?Usage: store-file <relative-path> [content]}"
FULL_PATH="${STORAGE_ROOT}/${REL_PATH}"

mkdir -p "$(dirname "$FULL_PATH")"

if [[ -n "${2:-}" ]]; then
  echo "$2" > "$FULL_PATH"
else
  cat > "$FULL_PATH"
fi

echo "stored: $FULL_PATH"
```

## Notes

- Path is always relative — never use absolute paths with this skill
- Creates parent directories automatically
- The `IRIS_STORAGE_ROOT` env var controls where files go (set by container env)
- Do not store secrets here — use Key Vault for secrets

## Example

```bash
store-file "sends/log.jsonl" '{"ts":"2026-04-11","to":"list","status":"ok"}'
store-file "drafts/april-update.md" "$(cat draft.md)"
```
