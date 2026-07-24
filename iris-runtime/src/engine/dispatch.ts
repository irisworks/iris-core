// ============================================================================
// Dispatch pipeline — one transport-agnostic decision function (IRIS-54).
//
// Every channel-mode consistency bug fixed in PR #37 existed because each
// named mode re-implemented its slice of "what does this message do" in two
// duplicated code paths (Slack's app_mention handler and its message
// handler). This module is the single source of truth for that decision:
// given a normalized inbound message and its channel's resolved
// DispatchConfig (see dispatch-config.ts), decide what happens.
//
// Stages: filter (transport-specific — subtype/bot-message admission — stays
// in the transport, informed by `admitsBotMessage`) -> trigger check ->
// container resolution -> decision. Queueing, notices, and admin-command
// execution stay in the transport too: they need transport state (queue
// depth, isRunning) this module has no business owning.
//
// Expressed only against these generic shapes — never Slack event types —
// so any future ChannelTransport can drive it the same way Slack does.
// ============================================================================

import { createSession, findByThread, loadSessions } from "./sessions.js";
import type { DispatchConfig, RelayConfig } from "./dispatch-config.js";

/** A normalized inbound message, independent of the transport it came from. */
export interface InboundMessage {
	channel: string;
	/** Timestamp/id of this message. */
	ts: string;
	/** Anchor of the thread this message replies in, if any. */
	threadTs?: string;
	isDM: boolean;
	/** Arrived via an explicit address to the bot (e.g. Slack's app_mention envelope). */
	isMention: boolean;
	isBotMessage: boolean;
}

export type DispatchDecision =
	| { kind: "ignore" }
	| { kind: "admin"; cmd: "stop" | "compact" | "reset" }
	| { kind: "chat" }
	| { kind: "session"; sessionId: string; threadTs: string }
	| { kind: "relay"; relay: RelayConfig; threadTs: string; errorNotice: boolean }
	| { kind: "relay-refused" };

/**
 * Whether a bot/integration message should even be admitted (logged and
 * considered for dispatch) rather than dropped outright by the transport's
 * filter stage. True only for the two shapes that intentionally see bot
 * traffic: a "chat" container configured to accept it (leads), and a
 * "sessions" container's top-level message (an interactive-thread opener
 * posted by a skill/bot — logged so the thread has an anchor, but per
 * resolveDispatch below it never itself dispatches).
 */
export function admitsBotMessage(config: DispatchConfig, hasThreadTs: boolean): boolean {
	if (config.container === "chat") return config.acceptBotMessages;
	if (config.container === "sessions") return config.trigger !== "api-only" && !hasThreadTs;
	return false;
}

/**
 * Whether (lowercased, trimmed) text is one of the admin control commands.
 * `clear` is accepted as an alias for `reset` — the conventional name in
 * other chat/CLI tools (Claude Code, ChatGPT) that users reach for instead
 * of `reset` (see #109).
 */
export function parseAdminCommand(text: string): "stop" | "compact" | "reset" | false {
	const cmd = text.toLowerCase().trim();
	if (cmd === "clear") return "reset";
	return cmd === "stop" || cmd === "compact" || cmd === "reset" ? cmd : false;
}

/**
 * Resolve what an inbound message should do, given its channel's dispatch
 * config. Session lookups/creation happen here (synchronous, disk-backed —
 * same as the code this replaces) so callers never touch sessions.ts
 * directly for routing decisions.
 */
export function resolveDispatch(
	input: InboundMessage,
	config: DispatchConfig,
	workingDir: string,
	adminCommand: "stop" | "compact" | "reset" | false,
): DispatchDecision {
	if (config.container === "relay") {
		if (!config.relay) return { kind: "relay-refused" };
		const isTopLevelChannelMsg = !input.isDM && !input.threadTs && !input.isMention;
		if (isTopLevelChannelMsg && config.trigger === "mention") return { kind: "ignore" };
		// An explicit interaction (DM or @mention) is worth a visible failure notice;
		// ambient channel traffic (top-level chatter, thread replies) fails quietly —
		// a relay channel is often an unattended external-facing feed.
		return {
			kind: "relay",
			relay: config.relay,
			threadTs: input.threadTs ?? input.ts,
			errorNotice: input.isDM || input.isMention,
		};
	}

	if (config.container === "chat") {
		// Admin-command-shaped text in a channel with adminCommands enabled is always
		// intercepted — mention, DM, or bare top-level ambient text — so `stop`/`compact`/
		// `reset` work the same whether or not the message explicitly @mentions the bot
		// (matching Telegram's unprefixed /commands, which need no such targeting either).
		// A buried thread reply that's neither a mention nor a DM stays exempt: a reply
		// that happens to be the literal word "stop" mid-conversation, not addressed to
		// the bot, shouldn't abort/wipe/compact the whole channel out from under it.
		if (adminCommand && config.adminCommands && (input.isMention || input.isDM || !input.threadTs)) {
			return { kind: "admin", cmd: adminCommand };
		}
		// adminCommands disabled: admin-command-shaped text addressed to the bot (a mention
		// or a DM) is still swallowed rather than dispatched through as ordinary chat text.
		if (adminCommand && (input.isMention || input.isDM)) {
			return { kind: "ignore" };
		}
		if (input.isDM || input.isMention) return { kind: "chat" };
		// Non-mention channel message: only a top-level, all-top-level-triggered
		// chat container (leads) dispatches; thread replies never do here, and
		// "mention"-triggered containers never do without an explicit @mention.
		if (!input.threadTs && config.trigger === "all-top-level") {
			if (input.isBotMessage && !config.acceptBotMessages) return { kind: "ignore" };
			return { kind: "chat" };
		}
		return { kind: "ignore" };
	}

	// container === "sessions"
	if (input.isDM) {
		// A DM has no thread concept of its own to key a session on — it
		// dispatches straight into chat-style (channel-context) handling, like
		// every container except relay.
		return { kind: "chat" };
	}

	const sessions = loadSessions(workingDir);

	if (input.threadTs) {
		const existing = findByThread(sessions, input.channel, input.threadTs);
		if (existing) return { kind: "session", sessionId: existing.sessionId, threadTs: input.threadTs };
		if (config.trigger === "api-only") return { kind: "ignore" }; // unregistered thread, api-only: log only
		if (input.isBotMessage) return { kind: "ignore" }; // bot thread replies never open a session
		const session = createSession(workingDir, { originChannel: input.channel, originThreadTs: input.threadTs });
		return { kind: "session", sessionId: session.sessionId, threadTs: input.threadTs };
	}

	// Top-level (no thread anchor)
	if (config.trigger === "api-only") return { kind: "ignore" }; // only pre-existing registered threads respond
	if (input.isMention) {
		const threadTs = input.ts;
		const existing = findByThread(sessions, input.channel, threadTs);
		const session = existing ?? createSession(workingDir, { originChannel: input.channel, originThreadTs: threadTs });
		return { kind: "session", sessionId: session.sessionId, threadTs };
	}
	if (config.trigger === "mention") return { kind: "ignore" }; // top-level requires an explicit mention
	if (input.isBotMessage) return { kind: "ignore" }; // bot-posted opener: log only, session opens on first human reply
	const threadTs = input.ts;
	const session = createSession(workingDir, { originChannel: input.channel, originThreadTs: threadTs });
	return { kind: "session", sessionId: session.sessionId, threadTs };
}
