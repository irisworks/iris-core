/**
 * Channel mode configuration.
 *
 * Loads and resolves the operational mode for each Slack channel.
 * Previously embedded inside SlackBot — extracted so routing decisions
 * live in their own testable, replaceable unit with no socket dependencies.
 *
 * Modes
 * ─────
 * dm                 Default. Every message triggers the LLM.
 * admin              Like dm, but "stop / compact / reset" commands work.
 * thread             Only responds inside pre-registered session threads.
 * interactive-thread Top-level @mention creates a session; replies continue it.
 * passthrough        Forwards to an external HTTP endpoint — LLM never runs.
 * leads              All top-level messages fire LLM (no @mention needed).
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import * as log from "../log.js";

export type ChannelMode =
	| "thread"
	| "interactive-thread"
	| "passthrough"
	| "leads"
	| "dm"
	| "admin";

const VALID_MODES = new Set<string>([
	"thread", "interactive-thread", "passthrough", "leads", "dm", "admin",
]);

export class ChannelModeConfig {
	private modes = new Map<string, ChannelMode>();
	private passthroughUrls = new Map<string, string>();
	private requireMentionChannels = new Set<string>();

	/**
	 * Load channel configuration from {workingDir}/data/channels.json.
	 * Safe to call multiple times — replaces current config entirely.
	 */
	load(workingDir: string): void {
		const path = join(workingDir, "data", "channels.json");
		if (!existsSync(path)) return;
		try {
			const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<
				string,
				{ mode?: string; url?: string; requireMentionForTopLevel?: boolean }
			>;
			this.modes.clear();
			this.passthroughUrls.clear();
			this.requireMentionChannels.clear();

			for (const [id, cfg] of Object.entries(raw)) {
				if (cfg.mode && VALID_MODES.has(cfg.mode)) {
					this.modes.set(id, cfg.mode as ChannelMode);
				}
				if (cfg.mode === "passthrough" && cfg.url) {
					this.passthroughUrls.set(id, cfg.url);
				}
				if (cfg.requireMentionForTopLevel) {
					this.requireMentionChannels.add(id);
				}
			}
			log.logInfo(`[channel-mode] Loaded ${this.modes.size} entries`);
		} catch (err) {
			log.logWarning("[channel-mode] Failed to load channels.json", err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * Resolve the mode for a channel.
	 * Checks exact match first, then wildcard suffix (e.g. "D*" for all DMs).
	 * Falls back to "dm" when no entry is found.
	 */
	getMode(channelId: string): ChannelMode {
		const exact = this.modes.get(channelId);
		if (exact) return exact;
		for (const [pattern, mode] of this.modes) {
			if (pattern.endsWith("*") && channelId.startsWith(pattern.slice(0, -1))) {
				return mode;
			}
		}
		return "dm";
	}

	getPassthroughUrl(channelId: string): string | undefined {
		return this.passthroughUrls.get(channelId);
	}

	requiresMentionForTopLevel(channelId: string): boolean {
		return this.requireMentionChannels.has(channelId);
	}
}
