/**
 * Store for full, untruncated tool output (#159).
 *
 * When a tool output is truncated (see truncate.ts), the bytes beyond the
 * limit would otherwise just be discarded. Instead, the full content is
 * persisted here, keyed by a short id, so the model can retrieve it later
 * with the `read_full` tool instead of paying the token cost of including
 * it up front.
 *
 * Stored under `<channelDir>/tool-output/<id>.txt`. Falls back to the OS
 * temp dir when no channelDir is available (headless/test callers that
 * don't wire up channel identity) - matching the bash tool's previous
 * tmpdir-only behavior, just no longer the only option.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envMs } from "../sessions.js";
import { safeJoin } from "../store.js";

const STORE_DIR_NAME = "tool-output";
const ID_PATTERN = /^[0-9a-f]{16}$/;

function retentionMs(): number {
	return envMs("IRIS_FULL_OUTPUT_RETENTION_MS", 24 * 60 * 60 * 1000);
}

function storeDir(channelDir: string | undefined): string {
	return join(channelDir ?? tmpdir(), STORE_DIR_NAME);
}

/** Delete stored entries older than the retention window. Never throws. */
function sweep(dir: string): void {
	const cutoff = Date.now() - retentionMs();
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.endsWith(".txt")) continue;
		const path = join(dir, entry);
		try {
			if (statSync(path).mtimeMs < cutoff) rmSync(path);
		} catch {
			// Raced a delete or a permission hiccup - leave it for the next sweep.
		}
	}
}

/**
 * Persist the full content of a truncated tool output, returning an id the
 * model can later pass to `read_full` to retrieve it. The id is a content
 * hash, not a random one: re-persisting identical content (e.g. re-reading
 * the same large file/command output within one session) reuses the same
 * file instead of writing another copy, and touches its mtime so repeated
 * access keeps it alive past entries that are actually going stale.
 */
export function persistFullOutput(channelDir: string | undefined, content: string): string {
	const dir = storeDir(channelDir);
	mkdirSync(dir, { recursive: true });
	sweep(dir);
	const id = createHash("sha256").update(content).digest("hex").slice(0, 16);
	const path = join(dir, `${id}.txt`);
	if (existsSync(path)) {
		const now = new Date();
		utimesSync(path, now, now);
	} else {
		writeFileSync(path, content);
	}
	return id;
}

/**
 * Look up previously persisted full output by id. Returns undefined if the
 * id is malformed, unknown, or has aged out of the retention window.
 */
export function readFullOutput(channelDir: string | undefined, id: string): string | undefined {
	if (!ID_PATTERN.test(id)) return undefined;
	const dir = storeDir(channelDir);
	const path = safeJoin(dir, `${id}.txt`);
	if (!path || !existsSync(path)) return undefined;
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return undefined;
	}
}
