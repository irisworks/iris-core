/**
 * Artifact sync — upload generated files from an agent channel directory to
 * Azure Blob Storage after each run so they are durable and accessible even
 * if the local volume is lost or the container is reprovisioned.
 *
 * Blob path layout:
 *   agents/{agentId}/artifacts/{channelRelPath}/{relativeFilePath}
 *
 * Examples:
 *   agents/3e04aa8e.../artifacts/slack/D0BAN02N5DW/solution.py
 *   agents/3e04aa8e.../artifacts/slack/D0BAN02N5DW/scratch/chart.png
 *
 * Only runs when BLOB_ENABLED=true and an agentId is available (AGENT_ID env
 * var — always set in Docker sub-agent containers).
 */

import { existsSync, readdirSync, statSync, readFileSync } from "fs";
import { join, relative, extname } from "path";
import { blobWrite, blobWriteBuffer, BLOB_ENABLED } from "./blob.js";
import { resolveChannelPath } from "./store.js";
import * as log from "./log.js";

// ── Exclusions ────────────────────────────────────────────────────────────────

const EXCLUDED_FILES = new Set([
  "log.jsonl", "context.jsonl", "last_prompt.jsonl",
  "bots.json", "models.json", "MEMORY.md", "SYSTEM.md",
]);

const EXCLUDED_DIRS = new Set(["attachments", "events", "skills", "node_modules", ".git"]);

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file

// Detect MIME type from extension
const TEXT_EXTENSIONS = new Set([
  ".py", ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs",
  ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
  ".sh", ".bash", ".zsh", ".fish",
  ".md", ".txt", ".rst", ".csv", ".tsv", ".log",
  ".html", ".htm", ".css", ".scss", ".sass", ".less",
  ".cpp", ".cc", ".cxx", ".c", ".h", ".hpp",
  ".java", ".go", ".rs", ".rb", ".php", ".swift",
  ".kt", ".kts", ".cs", ".r", ".lua", ".pl",
  ".sql", ".graphql", ".proto", ".tf", ".hcl",
  ".xml", ".svg", ".env", ".gitignore", ".dockerignore",
  ".makefile", ".dockerfile",
]);

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tiff"]);
const PDF_EXTENSIONS   = new Set([".pdf"]);

function mimeFor(ext: string): string | null {
  if (TEXT_EXTENSIONS.has(ext))  return "text/plain; charset=utf-8";
  if (IMAGE_EXTENSIONS.has(ext)) return `image/${ext.slice(1)}`;
  if (PDF_EXTENSIONS.has(ext))   return "application/pdf";
  return null; // skip unknown binary formats
}

// ── File collector ────────────────────────────────────────────────────────────

function collectFiles(dir: string, result: string[] = []): string[] {
  if (!existsSync(dir)) return result;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(fullPath, result);
    } else if (entry.isFile() && !EXCLUDED_FILES.has(entry.name)) {
      result.push(fullPath);
    }
  }
  return result;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Scan a channel's working directory and upload all artifact files to blob.
 * Fire-and-forget — never throws; errors are logged only.
 *
 * @param workingDir  The agent's root workspace dir (e.g. /workspace or /iris/data/agents/{id})
 * @param channelId   Slack channel ID, tg-* channel, SESSION-*, etc.
 * @param agentId     Optional — defaults to AGENT_ID env var (always set in containers)
 */
export async function syncChannelArtifacts(
  workingDir: string,
  channelId: string,
  agentId?: string,
): Promise<void> {
  if (!BLOB_ENABLED) return;

  const effectiveAgentId = agentId ?? process.env.AGENT_ID;
  if (!effectiveAgentId) return;

  const channelRelPath = resolveChannelPath(channelId);
  const channelDir     = join(workingDir, channelRelPath);
  const files          = collectFiles(channelDir);
  if (files.length === 0) return;

  let synced = 0;
  for (const absPath of files) {
    try {
      const stat = statSync(absPath);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;

      const rel  = relative(channelDir, absPath);
      const blob = `agents/${effectiveAgentId}/artifacts/${channelRelPath}/${rel}`;
      const ext  = extname(absPath).toLowerCase();
      const mime = mimeFor(ext);

      if (mime === null) continue; // skip unknown binary types

      if (mime.startsWith("text/")) {
        const content = readFileSync(absPath, "utf-8");
        await blobWrite(blob, content);
      } else {
        const buf = readFileSync(absPath);
        await blobWriteBuffer(blob, buf, mime);
      }
      synced++;
    } catch (err) {
      log.logWarning(
        `[artifact-sync] failed: ${absPath}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (synced > 0) {
    log.logInfo(`[artifact-sync] synced ${synced} artifact(s) for ${channelId}`);
  }
}

/**
 * Sync agent workspace state — MEMORY.md, scratch files, and pending events —
 * to blob after each run. This is the write-half of the blob-restore loop:
 * agent-provision.ts reads these back when an agent is re-provisioned after a
 * VM rebuild. Fire-and-forget; never throws.
 *
 * Blob paths:
 *   agents/{agentId}/memory/MEMORY.md
 *   agents/{agentId}/state/scratch/{filename}
 *   agents/{agentId}/state/events/{filename}
 */
export async function syncAgentState(
  workingDir: string,
  agentId?: string,
): Promise<void> {
  if (!BLOB_ENABLED) return;
  const effectiveAgentId = agentId ?? process.env.AGENT_ID;
  if (!effectiveAgentId) return;

  const uploads: Array<{ local: string; blob: string }> = [];

  // MEMORY.md — the write path that was previously missing
  const memPath = join(workingDir, "MEMORY.md");
  if (existsSync(memPath)) {
    uploads.push({ local: memPath, blob: `agents/${effectiveAgentId}/memory/MEMORY.md` });
  }

  // scratch/*.json — agent's active working memory across messages
  const scratchDir = join(workingDir, "scratch");
  if (existsSync(scratchDir)) {
    for (const entry of readdirSync(scratchDir, { withFileTypes: true })) {
      if (entry.isFile()) {
        uploads.push({
          local: join(scratchDir, entry.name),
          blob: `agents/${effectiveAgentId}/state/scratch/${entry.name}`,
        });
      }
    }
  }

  // events/* — pending scheduled task triggers
  const eventsDir = join(workingDir, "events");
  if (existsSync(eventsDir)) {
    for (const entry of readdirSync(eventsDir, { withFileTypes: true })) {
      if (entry.isFile()) {
        uploads.push({
          local: join(eventsDir, entry.name),
          blob: `agents/${effectiveAgentId}/state/events/${entry.name}`,
        });
      }
    }
  }

  let synced = 0;
  for (const { local, blob } of uploads) {
    try {
      const stat = statSync(local);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      await blobWrite(blob, readFileSync(local, "utf-8"));
      synced++;
    } catch (err) {
      log.logWarning(`[artifact-sync] state sync failed: ${local}`, err instanceof Error ? err.message : String(err));
    }
  }

  if (synced > 0) {
    log.logInfo(`[artifact-sync] synced ${synced} state file(s) for agent ${effectiveAgentId}`);
  }
}
