/**
 * Azure Blob Storage client — write-through layer for agents, memory, threads, skills.
 *
 * BLOB_ENABLED=false (default) → all operations are no-ops / return null.
 *                                 Local file storage continues to be the source of truth.
 * BLOB_ENABLED=true            → writes go to both local files AND Blob.
 *                                 Reads prefer local files; fall back to Blob if missing.
 *
 * Container layout (all under BLOB_CONTAINER, default "iris-runtime"):
 *   agents/{agentId}/memory/MEMORY.md
 *   agents/{agentId}/threads/{channelId}/log.jsonl
 *   agents/{agentId}/threads/{channelId}/context.jsonl
 *   agents/{agentId}/skills/{skillName}.md
 *   agents/{agentId}/logs/{date}.log
 *   agents/{agentId}/snapshots/{timestamp}.tar.gz
 *   sessions/{sessionId}.json
 *   memory/global/MEMORY.md
 *   memory/channels/{channelId}/MEMORY.md
 */

import { BlobServiceClient } from "@azure/storage-blob";
import * as log from "./log.js";

export const BLOB_ENABLED   = process.env.BLOB_ENABLED === "true";
const CONNECTION_STRING      = process.env.AZURE_STORAGE_CONNECTION_STRING ?? "";
export const BLOB_CONTAINER  = process.env.BLOB_CONTAINER ?? "iris-runtime";

let _client: BlobServiceClient | null = null;

function getClient(): BlobServiceClient | null {
  if (!BLOB_ENABLED || !CONNECTION_STRING) return null;
  if (!_client) {
    try {
      _client = BlobServiceClient.fromConnectionString(CONNECTION_STRING);
    } catch (err) {
      log.logWarning("[blob] Failed to initialise BlobServiceClient", String(err));
    }
  }
  return _client;
}

export async function blobWrite(blobPath: string, content: string): Promise<void> {
  const client = getClient();
  if (!client) return;
  try {
    const cc = client.getContainerClient(BLOB_CONTAINER);
    await cc.createIfNotExists();
    const buf = Buffer.from(content, "utf-8");
    await cc.getBlockBlobClient(blobPath).upload(buf, buf.byteLength, {
      blobHTTPHeaders: { blobContentType: "text/plain; charset=utf-8" },
    });
  } catch (err) {
    log.logWarning(`[blob] write failed: ${blobPath}`, String(err));
  }
}

export async function blobRead(blobPath: string): Promise<string | null> {
  const client = getClient();
  if (!client) return null;
  try {
    const download = await client
      .getContainerClient(BLOB_CONTAINER)
      .getBlockBlobClient(blobPath)
      .download();
    const chunks: Uint8Array[] = [];
    for await (const chunk of download.readableStreamBody as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf-8");
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) return null;
    log.logWarning(`[blob] read failed: ${blobPath}`, String(err));
    return null;
  }
}

export async function blobDelete(blobPath: string): Promise<void> {
  const client = getClient();
  if (!client) return;
  try {
    await client
      .getContainerClient(BLOB_CONTAINER)
      .getBlockBlobClient(blobPath)
      .deleteIfExists();
  } catch (err) {
    log.logWarning(`[blob] delete failed: ${blobPath}`, String(err));
  }
}

export async function blobList(prefix: string): Promise<string[]> {
  const client = getClient();
  if (!client) return [];
  try {
    const results: string[] = [];
    for await (const blob of client.getContainerClient(BLOB_CONTAINER).listBlobsFlat({ prefix })) {
      results.push(blob.name);
    }
    return results;
  } catch (err) {
    log.logWarning(`[blob] list failed: ${prefix}`, String(err));
    return [];
  }
}
