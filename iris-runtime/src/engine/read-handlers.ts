/**
 * Read-handlers: workspace-discovered, declarative shell recipes that teach
 * the read tool how to turn a non-image file format into text — the same
 * extension seam skills already have (drop a directory in, no core PR, no
 * restart), applied to file-format handling instead of agent behavior.
 *
 * Deliberately NOT loadable JS/code: a handler is a shell command template
 * run through the same sandboxed executor every other tool call goes
 * through (see tools/read.ts), never imported into the running process.
 * That keeps a bad or malicious handler's blast radius identical to a bad
 * skill or a bad bash call, instead of arbitrary code sharing the engine's
 * own address space.
 *
 * Override rule matches skills: ship a handler with the same directory name
 * as a core one (e.g. read-handlers/pdf-text/) to replace it. Two handlers
 * that claim the same mimeType under different names is a load-time warning,
 * first one scanned wins — name your override to match, don't rely on
 * scan order.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import * as log from "./log.js";

export interface ReadHandler {
	name: string;
	mimeTypes: string[];
	/** Shell command template; `{path}` is substituted with the shell-escaped file path. */
	command: string;
	/** Seconds before the handler's command is killed. */
	timeoutSeconds: number;
}

const DEFAULT_TIMEOUT_SECONDS = 30;
const MANIFEST_FILENAME = "handler.json";

interface RawHandlerManifest {
	name?: unknown;
	mimeTypes?: unknown;
	command?: unknown;
	timeoutSeconds?: unknown;
}

function parseManifest(manifestPath: string, dirName: string): ReadHandler | undefined {
	let raw: RawHandlerManifest;
	try {
		raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
	} catch (error) {
		log.logWarning(`read-handlers: failed to parse ${manifestPath}: ${error instanceof Error ? error.message : error}`);
		return undefined;
	}

	const mimeTypes = Array.isArray(raw.mimeTypes) ? raw.mimeTypes.filter((m): m is string => typeof m === "string" && m.length > 0) : [];
	if (mimeTypes.length === 0) {
		log.logWarning(`read-handlers: skipping ${manifestPath} — "mimeTypes" must be a non-empty array of strings`);
		return undefined;
	}
	if (typeof raw.command !== "string" || raw.command.trim().length === 0) {
		log.logWarning(`read-handlers: skipping ${manifestPath} — "command" must be a non-empty string`);
		return undefined;
	}

	return {
		name: typeof raw.name === "string" && raw.name.length > 0 ? raw.name : dirName,
		mimeTypes,
		command: raw.command,
		timeoutSeconds:
			typeof raw.timeoutSeconds === "number" && raw.timeoutSeconds > 0 ? raw.timeoutSeconds : DEFAULT_TIMEOUT_SECONDS,
	};
}

/**
 * Scan `<workspaceDir>/read-handlers/*\/handler.json` and build a mimeType ->
 * handler registry. Re-scanning is cheap (a handful of small JSON files) and
 * called fresh on every read-tool invocation so handlers hot-reload the same
 * way skills do — no restart needed to pick up a new or edited handler.
 */
export function loadReadHandlerRegistry(workspaceDir: string): Map<string, ReadHandler> {
	const registry = new Map<string, ReadHandler>();
	const dir = join(workspaceDir, "read-handlers");
	if (!existsSync(dir)) return registry;

	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const manifestPath = join(dir, entry.name, MANIFEST_FILENAME);
		if (!existsSync(manifestPath)) continue;

		const handler = parseManifest(manifestPath, entry.name);
		if (!handler) continue;

		for (const mimeType of handler.mimeTypes) {
			const existing = registry.get(mimeType);
			if (existing && existing.name !== handler.name) {
				log.logWarning(
					`read-handlers: "${handler.name}" and "${existing.name}" both claim ${mimeType} — keeping "${existing.name}". ` +
						`To override a handler, use its exact directory name instead of adding a new one.`,
				);
				continue;
			}
			registry.set(mimeType, handler);
		}
	}

	return registry;
}

/** Substitute `{path}` in a handler's command template with the shell-escaped file path. */
export function renderHandlerCommand(handler: ReadHandler, path: string): string {
	return handler.command.replaceAll("{path}", shellEscape(path));
}

function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}
