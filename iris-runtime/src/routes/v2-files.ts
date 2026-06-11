/**
 * GET /v2/files?path={absolutePath}
 *
 * Serves file content for the frontend code viewer.
 * Restricted to session and agent workspace directories only.
 * Falls back to Azure Blob Storage when the local file is missing.
 */

import { existsSync, readFileSync, statSync } from "fs";
import { resolve, extname } from "path";
import type { V2Handler } from "./v2-types.js";
import { ok, err } from "./v2-types.js";
import { blobReadBuffer } from "../blob.js";

const IRIS_DIR  = process.env.IRIS_DIR  ?? "/iris";
const IRIS_REPO = process.env.IRIS_REPO ?? "/iris/repo";

// Only allow reading from session scratch dirs and agent workspaces.
const ALLOWED_PREFIXES = [
  `${IRIS_REPO}/SESSION-`,    // main-iris session scratch
  `${IRIS_DIR}/data/agents/`, // sub-agent workspaces
  `${IRIS_REPO}/scratch/`,    // top-level scratch (legacy)
  `${IRIS_REPO}/channels/`,   // channel dirs
];

function isAllowedPath(absPath: string): boolean {
  return ALLOWED_PREFIXES.some((p) => absPath.startsWith(p));
}

/**
 * Map a local agent workspace path to its blob artifact path.
 * /iris/data/agents/{agentId}/{rest}  →  agents/{agentId}/artifacts/{rest}
 */
function localPathToBlobPath(absPath: string): string | null {
  const agentsPrefix = `${IRIS_DIR}/data/agents/`;
  if (!absPath.startsWith(agentsPrefix)) return null;
  const rest = absPath.slice(agentsPrefix.length); // "{agentId}/{...}"
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const agentId  = rest.slice(0, slash);
  const filePath = rest.slice(slash + 1);
  return `agents/${agentId}/artifacts/${filePath}`;
}

const EXT_TO_LANG: Record<string, string> = {
  ".py": "python", ".js": "javascript", ".ts": "typescript",
  ".jsx": "jsx", ".tsx": "tsx", ".json": "json",
  ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
  ".sh": "bash", ".bash": "bash", ".zsh": "bash",
  ".md": "markdown", ".txt": "text", ".html": "html",
  ".css": "css", ".scss": "scss",
  ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp",
  ".c": "c", ".h": "c",
  ".java": "java", ".go": "go", ".rs": "rust",
  ".rb": "ruby", ".php": "php", ".swift": "swift",
  ".kt": "kotlin", ".cs": "csharp", ".r": "r",
  ".sql": "sql", ".graphql": "graphql", ".proto": "protobuf",
  ".dockerfile": "dockerfile", ".tf": "hcl",
  ".xml": "xml", ".csv": "text", ".lock": "text",
};

export const handleV2Files: V2Handler = async (method, _parts, req, _readBody, _deps) => {
  if (method !== "GET") return null;

  const rawUrl = req.url ?? "";
  const qStart = rawUrl.indexOf("?");
  const params  = qStart >= 0 ? new URLSearchParams(rawUrl.slice(qStart + 1)) : null;
  const rawPath = params?.get("path");

  if (!rawPath) return err(400, "path query parameter is required");

  // Resolve and sanitise — prevent directory traversal
  const absPath = resolve(rawPath);
  if (!isAllowedPath(absPath)) {
    return err(403, "Access denied: path is outside allowed workspace directories");
  }

  const ext  = extname(absPath).toLowerCase();
  const lang = EXT_TO_LANG[ext] ?? "text";

  // ── Local file ─────────────────────────────────────────────────────────────
  if (existsSync(absPath)) {
    let stat: ReturnType<typeof statSync>;
    try { stat = statSync(absPath); } catch { return err(404, "File not found"); }
    if (!stat.isFile()) return err(400, "Path is not a file");
    if (stat.size > 2 * 1024 * 1024) return err(413, "File too large (max 2 MB)");

    let content: string;
    try { content = readFileSync(absPath, "utf-8"); }
    catch { return err(500, "Failed to read file"); }

    return ok({ path: absPath, content, language: lang, size: stat.size, source: "local" });
  }

  // ── Blob fallback ──────────────────────────────────────────────────────────
  const blobPath = localPathToBlobPath(absPath);
  if (blobPath) {
    const buf = await blobReadBuffer(blobPath);
    if (buf) {
      const content = buf.toString("utf-8");
      return ok({ path: absPath, content, language: lang, size: buf.byteLength, source: "blob" });
    }
  }

  return err(404, `File not found: ${absPath}`);
};
