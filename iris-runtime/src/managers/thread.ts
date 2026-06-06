/**
 * ThreadManager — reads conversation thread history.
 * Reads from local files first; falls back to Blob when BLOB_ENABLED=true.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { blobRead } from "../blob.js";
import { resolveChannelDir } from "../store.js";

function parseJsonl(content: string): unknown[] {
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

export class ThreadManager {
  constructor(private workingDir: string) {}

  getHistory(channelId: string): unknown[] {
    const channelDir = resolveChannelDir(this.workingDir, channelId);
    const logPath = join(channelDir, "log.jsonl");
    if (!existsSync(logPath)) return [];
    return parseJsonl(readFileSync(logPath, "utf-8"));
  }

  async getHistoryWithBlobFallback(agentId: string, channelId: string): Promise<unknown[]> {
    const local = this.getHistory(channelId);
    if (local.length > 0) return local;
    const remote = await blobRead(`agents/${agentId}/threads/${channelId}/log.jsonl`);
    return remote ? parseJsonl(remote) : [];
  }

  getSessionHistory(workingDir: string, sessionId: string): unknown[] {
    const logPath = join(workingDir, `SESSION-${sessionId}`, "log.jsonl");
    if (!existsSync(logPath)) return [];
    return parseJsonl(readFileSync(logPath, "utf-8"));
  }
}
