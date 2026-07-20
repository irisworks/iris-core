// ============================================================================
// Dispatch config — presets over flags (IRIS-54).
//
// The six named channel modes (dm/admin/thread/interactive-thread/leads/
// passthrough) are three primitives plus orthogonal flags:
//
//   container: "chat"     — channel-context LLM run
//              "sessions" — per-thread session LLM run
//              "relay"    — webhook forward, LLM never runs
//   trigger:   "mention"       — only an explicit @mention (or an existing
//                                 thread/session) dispatches; plain top-level
//                                 chatter is logged only
//              "all-top-level" — any top-level message dispatches, no mention
//                                 needed
//              "api-only"      — nothing organic opens a new container; only
//                                 a pre-existing (API-created) session
//                                 continues
//   adminCommands     — stop/compact/reset text commands are intercepted
//                        (chat container only; mentions/DMs only)
//   acceptBotMessages — bot/integration messages are admitted as triggers
//                        (chat container, all-top-level trigger only)
//   replayMissed      — pre-startup top-level messages are replayed instead
//                        of skipped
//
// The legacy mode names remain forever as silent aliases expanding to this
// shape, so no existing channels.json ever breaks. New configs may specify
// the primitive shape directly, but docs lead with the named recipes — raw
// flag combos are not a supported/documented surface.
// ============================================================================

export type DispatchContainer = "chat" | "sessions" | "relay";
export type DispatchTrigger = "mention" | "all-top-level" | "api-only";

export interface RelayConfig {
	url: string;
	secretName?: string;
	payload?: unknown;
	replyPrefix?: string;
}

export interface DispatchConfig {
	container: DispatchContainer;
	trigger: DispatchTrigger;
	adminCommands: boolean;
	acceptBotMessages: boolean;
	replayMissed: boolean;
	/** Only meaningful for container "relay"; absent (with container "relay") means misconfigured — refuse. */
	relay?: RelayConfig;
}

export type LegacyChannelMode = "dm" | "admin" | "thread" | "interactive-thread" | "leads" | "passthrough";

export const LEGACY_MODES: ReadonlySet<string> = new Set([
	"dm",
	"admin",
	"thread",
	"interactive-thread",
	"leads",
	"passthrough",
]);

/** One raw data/channels.json entry, keyed by channel ID or prefix wildcard. */
export interface RawChannelEntry {
	mode: string;
	requireMentionForTopLevel?: boolean;
	url?: string;
	secretName?: string;
	payload?: unknown;
	replyPrefix?: string;
}

/** A resolved channels.json entry: the legacy name (for compat getters) plus its expanded dispatch config. */
export interface ResolvedChannelConfig {
	legacyMode: LegacyChannelMode;
	requireMentionForTopLevel: boolean;
	dispatch: DispatchConfig;
}

/**
 * Expand a legacy mode name (+ requireMentionForTopLevel) into the 3-primitive
 * schema. Returns undefined for an unrecognised mode string — callers must
 * already have validated `mode` against LEGACY_MODES before calling this.
 */
export function expandLegacyMode(entry: RawChannelEntry): DispatchConfig {
	const mentionGated = entry.requireMentionForTopLevel === true;
	switch (entry.mode as LegacyChannelMode) {
		case "dm":
			return { container: "chat", trigger: "mention", adminCommands: false, acceptBotMessages: false, replayMissed: false };
		case "admin":
			return { container: "chat", trigger: "mention", adminCommands: true, acceptBotMessages: false, replayMissed: false };
		case "leads":
			return { container: "chat", trigger: "all-top-level", adminCommands: false, acceptBotMessages: true, replayMissed: true };
		case "thread":
			return { container: "sessions", trigger: "api-only", adminCommands: false, acceptBotMessages: false, replayMissed: false };
		case "interactive-thread":
			return {
				container: "sessions",
				trigger: mentionGated ? "mention" : "all-top-level",
				adminCommands: false,
				acceptBotMessages: false,
				replayMissed: false,
			};
		case "passthrough": {
			const base: DispatchConfig = {
				container: "relay",
				trigger: mentionGated ? "mention" : "all-top-level",
				adminCommands: false,
				acceptBotMessages: false,
				replayMissed: false,
			};
			if (!entry.url) return base; // misconfigured — relay left undefined, callers refuse
			return { ...base, relay: { url: entry.url, secretName: entry.secretName, payload: entry.payload, replyPrefix: entry.replyPrefix } };
		}
	}
}

/** Resolve one raw channels.json entry into its ResolvedChannelConfig, or undefined if `mode` is unrecognised. */
export function resolveChannelEntry(entry: RawChannelEntry): ResolvedChannelConfig | undefined {
	if (!LEGACY_MODES.has(entry.mode)) return undefined;
	return {
		legacyMode: entry.mode as LegacyChannelMode,
		requireMentionForTopLevel: entry.requireMentionForTopLevel === true,
		dispatch: expandLegacyMode(entry),
	};
}

/**
 * Resolve the config map entry for a channel id: an exact ID match wins;
 * otherwise the longest matching prefix wildcard (e.g. "D*") wins, so more
 * specific patterns take precedence regardless of file order.
 */
export function resolveWildcard<T>(configs: Map<string, T>, channelId: string): T | undefined {
	const exact = configs.get(channelId);
	if (exact) return exact;
	let best: T | undefined;
	let bestPrefixLen = -1;
	for (const [pattern, config] of configs) {
		if (!pattern.endsWith("*")) continue;
		const prefix = pattern.slice(0, -1);
		if (channelId.startsWith(prefix) && prefix.length > bestPrefixLen) {
			best = config;
			bestPrefixLen = prefix.length;
		}
	}
	return best;
}

/** Default config for a channel with no data/channels.json entry: legacy "dm". */
export const DEFAULT_CHANNEL_CONFIG: ResolvedChannelConfig = {
	legacyMode: "dm",
	requireMentionForTopLevel: false,
	dispatch: { container: "chat", trigger: "mention", adminCommands: false, acceptBotMessages: false, replayMissed: false },
};
