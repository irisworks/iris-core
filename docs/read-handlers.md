---
title: Read Handlers
description: Workspace-discovered shell recipes that teach the read tool how to extract text from a file format.
---

# Read Handlers

A read handler is a directory containing a `handler.json` that maps a MIME
type to a shell command. The read tool sniffs a file's real type from its
magic bytes (never the filename) and, if a handler claims that MIME type,
runs its command instead of dumping raw binary or falling through to the
plain-text path. Handlers **hot-reload without a restart** — drop one in and
the next read picks it up.

This is the same extension seam [skills](skills.md) have, applied to file
formats instead of agent behavior: no core PR needed to add a new format,
and Iris can write her own the same way she writes skills.

## Anatomy

```
read-handlers/
└── pdf-text/
    └── handler.json
```

```json
{
	"name": "pdf-text",
	"mimeTypes": ["application/pdf"],
	"command": "pdftotext -layout {path} -",
	"timeoutSeconds": 30
}
```

- `mimeTypes` — required, non-empty array. The MIME type(s) sniffed from a
  file's magic bytes that this handler claims.
- `command` — required. A shell command template; `{path}` is substituted
  with the shell-escaped file path before it runs through the same sandboxed
  executor every other tool call uses.
- `timeoutSeconds` — optional, defaults to 30.

A handler is deliberately **not** loadable code — no JS/TS module is ever
imported into the running process. It's a shell command, run the same way
`bash` tool calls already run, so a broken or malicious handler's blast
radius is a bad shell command, not arbitrary code sharing the engine's own
address space.

## Load order and overrides

Handlers are discovered from `<workspace>/read-handlers/` (symlinked to the
repo's `read-handlers/` directory for hot reload, same as skills). To
override a core-shipped handler — e.g. swap `pdftotext` for an OCR-capable
tool — ship a handler with the **same directory name** in your
[overlay](overlay.md); it replaces the core one in place, same override rule
as skills. Two different-named handlers claiming the same MIME type is a
load-time warning; the first one scanned wins, so rely on naming to override,
not scan order.

## What belongs in core

Core ships one default handler: `pdf-text`, extracting a PDF's text layer via
`pdftotext` (poppler-utils, installed by `bootstrap.sh`). Scanned or
image-only PDFs have no text layer and read back empty — there is no OCR
fallback in core.

Additional formats (docx, pptx, xlsx, proprietary formats, OCR handlers) are
overlay content — install-specific, like skills. Write one by hand, or ask
Iris: the same `self-extend` protocol that scaffolds a skill applies here —
identify the need, write `handler.json` in `overlay/read-handlers/<name>/`,
commit before use, test with one safe file.
