/**
 * ThreadManager — reads conversation thread history.
 * Reads from local files first; falls back to Blob when BLOB_ENABLED=true.
 *
 * Two on-disk formats exist:
 *   log.jsonl     — Slack/Telegram message log written by ChannelStore.logMessage.
 *                   Each line: { role?, type?, text?, content?, ts?, user?, isBot? }
 *   context.jsonl — Agent runner context written by pi-mom core.
 *                   Each line: { type: "message", message: { role, content: [{type, text}] } }
 *                   Used by SESSION-* and BRIDGE-* channels.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { blobRead } from "../blob.js";
import { resolveChannelDir } from "../store.js";

const IRIS_DIR = process.env.IRIS_DIR ?? "/iris";

// ============================================================================
// JSONL parser
// ============================================================================

function parseJsonl(content: string): unknown[] {
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

// ============================================================================
// context.jsonl → normalised {role, content} entries
// ============================================================================

interface NormalisedEntry { role: string; content: string }

function parseContextJsonl(content: string): NormalisedEntry[] {
  return (parseJsonl(content) as Record<string, unknown>[])
    .filter(e => e.type === "message" && e.message && typeof e.message === "object")
    .map(e => {
      const msg = e.message as { role?: string; content?: unknown };
      const role = msg.role ?? "assistant";
      let text = "";
      if (Array.isArray(msg.content)) {
        text = (msg.content as { type?: string; text?: string }[])
          .filter(c => c.type === "text")
          .map(c => c.text ?? "")
          .join("\n");
      } else if (typeof msg.content === "string") {
        text = msg.content;
      }
      return { role, content: text };
    })
    .filter(e => e.content.trim().length > 0);
}

// ============================================================================
// Unified channel reader — tries log.jsonl then context.jsonl
// ============================================================================

function readChannelMessages(channelDir: string): unknown[] {
  const logPath = join(channelDir, "log.jsonl");
  if (existsSync(logPath)) {
    const entries = parseJsonl(readFileSync(logPath, "utf-8"));
    if (entries.length > 0) return entries;
  }
  const ctxPath = join(channelDir, "context.jsonl");
  if (existsSync(ctxPath)) {
    return parseContextJsonl(readFileSync(ctxPath, "utf-8"));
  }
  return [];
}

// ============================================================================
// ThreadManager
// ============================================================================

export class ThreadManager {
  constructor(private workingDir: string) {}

  getHistory(channelId: string): unknown[] {
    const channelDir = resolveChannelDir(this.workingDir, channelId);
    return readChannelMessages(channelDir);
  }

  async getHistoryWithBlobFallback(agentId: string, channelId: string): Promise<unknown[]> {
    // Sub-agent channels live in the agent's own workspace dir, not the main workingDir.
    const agentWorkspaceDir = join(IRIS_DIR, "data", "agents", agentId);
    const channelDir = resolveChannelDir(agentWorkspaceDir, channelId);
    const local = readChannelMessages(channelDir);
    if (local.length > 0) return local;

    // Try blob — log.jsonl first, then context.jsonl
    const blobLog = await blobRead(`agents/${agentId}/threads/${channelId}/log.jsonl`);
    if (blobLog) {
      const entries = parseJsonl(blobLog);
      if (entries.length > 0) return entries;
    }
    const blobCtx = await blobRead(`agents/${agentId}/threads/${channelId}/context.jsonl`);
    if (blobCtx) return parseContextJsonl(blobCtx);

    return [];
  }

  getSessionHistory(workingDir: string, sessionId: string): unknown[] {
    const sessionDir = join(workingDir, `SESSION-${sessionId}`);
    return readChannelMessages(sessionDir);
  }
}
