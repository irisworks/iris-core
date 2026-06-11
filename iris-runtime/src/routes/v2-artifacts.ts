/**
 * GET /v2/artifacts?agentId={}&channelId={}
 *
 * Lists artifact files stored in Azure Blob for a given agent + channel.
 * Returns file metadata the frontend can use to render a "Files" panel.
 *
 * Response: { files: ArtifactFile[] }
 *
 * ArtifactFile: { name, blobPath, localPath, ext, language }
 */

import { extname } from "path";
import type { V2Handler } from "./v2-types.js";
import { ok, err } from "./v2-types.js";
import { blobList } from "../blob.js";
import { resolveChannelPath } from "../store.js";

const IRIS_DIR = process.env.IRIS_DIR ?? "/iris";

const EXT_TO_LANG: Record<string, string> = {
  ".py": "python", ".js": "javascript", ".ts": "typescript",
  ".jsx": "jsx", ".tsx": "tsx", ".json": "json",
  ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
  ".sh": "bash", ".md": "markdown", ".txt": "text",
  ".html": "html", ".css": "css",
  ".cpp": "cpp", ".c": "c", ".h": "c",
  ".java": "java", ".go": "go", ".rs": "rust",
  ".rb": "ruby", ".swift": "swift", ".kt": "kotlin",
  ".cs": "csharp", ".r": "r", ".sql": "sql",
  ".tf": "hcl", ".xml": "xml", ".csv": "text",
  ".png": "image", ".jpg": "image", ".jpeg": "image",
  ".gif": "image", ".webp": "image", ".pdf": "pdf",
};

interface ArtifactFile {
  name:      string;
  blobPath:  string;
  localPath: string;
  ext:       string;
  language:  string;
}

export const handleV2Artifacts: V2Handler = async (method, _parts, req, _readBody, _deps) => {
  if (method !== "GET") return null;

  const rawUrl  = req.url ?? "";
  const qStart  = rawUrl.indexOf("?");
  const params  = qStart >= 0 ? new URLSearchParams(rawUrl.slice(qStart + 1)) : null;
  const agentId  = params?.get("agentId");
  const channelId = params?.get("channelId");

  if (!agentId)   return err(400, "agentId is required");
  if (!channelId) return err(400, "channelId is required");

  const channelRelPath = resolveChannelPath(channelId);
  const blobPrefix     = `agents/${agentId}/artifacts/${channelRelPath}/`;
  const blobPaths      = await blobList(blobPrefix);

  const files: ArtifactFile[] = blobPaths.map((blobPath) => {
    const relToPrefix = blobPath.slice(blobPrefix.length);
    const name        = relToPrefix.split("/").pop() ?? relToPrefix;
    const ext         = extname(name).toLowerCase();
    const language    = EXT_TO_LANG[ext] ?? "text";
    // Reconstruct the local path so the frontend's existing file viewer works
    const localPath   = `${IRIS_DIR}/data/agents/${agentId}/${channelRelPath}/${relToPrefix}`;

    return { name, blobPath, localPath, ext, language };
  });

  return ok({ agentId, channelId, files });
};
