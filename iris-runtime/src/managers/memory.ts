/**
 * MemoryManager — reads/writes MEMORY.md files.
 * Adds Blob write-through when BLOB_ENABLED=true.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { blobWrite } from "../blob.js";

export class MemoryManager {
  constructor(private workingDir: string) {}

  private path(scope: "global" | "channel", channelId?: string): string {
    if (scope === "global") return join(this.workingDir, "MEMORY.md");
    if (!channelId) throw new Error("channelId required for channel scope");
    return join(this.workingDir, channelId, "MEMORY.md");
  }

  read(scope: "global" | "channel", channelId?: string): string {
    const p = this.path(scope, channelId);
    return existsSync(p) ? readFileSync(p, "utf-8") : "";
  }

  write(content: string, scope: "global" | "channel", channelId?: string): void {
    const p = this.path(scope, channelId);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, "utf-8");
    const blobKey = scope === "global"
      ? "memory/global/MEMORY.md"
      : `memory/channels/${channelId}/MEMORY.md`;
    void blobWrite(blobKey, content);
  }

  readForAgent(agentId: string, agentWorkspaceDir: string): string {
    const p = join(agentWorkspaceDir, "MEMORY.md");
    return existsSync(p) ? readFileSync(p, "utf-8") : "";
  }

  writeForAgent(agentId: string, agentWorkspaceDir: string, content: string): void {
    const p = join(agentWorkspaceDir, "MEMORY.md");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, "utf-8");
    void blobWrite(`agents/${agentId}/memory/MEMORY.md`, content);
  }
}
