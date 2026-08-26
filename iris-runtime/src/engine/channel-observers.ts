// ============================================================================
// Channel observers (IRIS-180)
//
// A `SESSION-<id>` turn runs on whichever transport the session API picked
// (api.ts's sessionTransport() — Slack, Telegram, or Bridge), and that
// transport's MessageContext posts wherever it posts. Nothing in that path
// knows a WebSocket client may also be watching the same channel.
//
// This is the same shape of problem engine/bridge.ts's status forwarding
// solves: several transports serve one virtual namespace and all of them drop
// an event some other surface wants. So the mirror is hooked once in
// engine/index.ts rather than reimplemented in each transport.
//
// The registry is deliberately transport-agnostic — it speaks run events, not
// WebTransport's wire frames — so engine/ keeps its "never import a concrete
// transport" rule (see transport/types.ts).
// ============================================================================

import type { MessageContext, ToolEvent } from "../transport/types.js";

/** A run event worth mirroring to a passive watcher of the same channel. */
export type ChannelObserverEvent =
	| { kind: "thinking"; text?: string }
	| { kind: "status"; label: string }
	| { kind: "tool"; event: ToolEvent }
	| { kind: "final"; text: string }
	| { kind: "file"; filename: string; title?: string };

export interface ChannelObserver {
	/** Whether anyone is currently watching this channel — keeps the mirror off the hot path when nobody is. */
	watching(channelId: string): boolean;
	emit(channelId: string, event: ChannelObserverEvent): void;
}

const observers = new Set<ChannelObserver>();

export function registerChannelObserver(observer: ChannelObserver): void {
	observers.add(observer);
}

export function unregisterChannelObserver(observer: ChannelObserver): void {
	observers.delete(observer);
}

/** True if at least one observer has a live watcher for this channel. */
export function isChannelObserved(channelId: string): boolean {
	for (const observer of observers) {
		if (observer.watching(channelId)) return true;
	}
	return false;
}

/**
 * Fan a run event out to every observer watching this channel. An observer
 * that throws must not take the agent run down with it — mirroring is a
 * side-channel, never load-bearing for the turn itself.
 */
export function publishChannelEvent(channelId: string, event: ChannelObserverEvent): void {
	for (const observer of observers) {
		if (!observer.watching(channelId)) continue;
		try {
			observer.emit(channelId, event);
		} catch {
			// ignore — a broken watcher can't fail the run
		}
	}
}

/** Test seam: drop all registrations. */
export function clearChannelObservers(): void {
	observers.clear();
}

/**
 * Wraps a run's MessageContext so the events a watcher cares about are
 * published alongside whatever the owning transport already does. Every
 * wrapped method still delegates first — the mirror observes the run, it
 * never replaces or short-circuits the transport's own behavior.
 *
 * `onToolEvent` is wrapped even when the underlying transport doesn't
 * implement it (Slack/Telegram/Bridge don't), which is the whole point: that
 * is how a watcher gets structured tool cards for a turn running on a
 * transport that would otherwise only flatten them into text.
 */
export function mirrorContextToObservers(channelId: string, ctx: MessageContext): MessageContext {
	return {
		...ctx,
		setTyping: async (isTyping: boolean) => {
			await ctx.setTyping(isTyping);
			if (isTyping) publishChannelEvent(channelId, { kind: "thinking" });
		},
		replaceMessage: async (text: string) => {
			await ctx.replaceMessage(text);
			publishChannelEvent(channelId, { kind: "final", text });
		},
		respond: async (text: string, shouldLog?: boolean) => {
			await ctx.respond(text, shouldLog);
			publishChannelEvent(channelId, { kind: "final", text });
		},
		uploadFile: async (filePath: string, title?: string) => {
			await ctx.uploadFile(filePath, title);
			publishChannelEvent(channelId, {
				kind: "file",
				filename: filePath.split("/").pop() ?? filePath,
				...(title !== undefined && { title }),
			});
		},
		onToolEvent: (event: ToolEvent) => {
			ctx.onToolEvent?.(event);
			publishChannelEvent(channelId, { kind: "tool", event });
		},
		setStatus: async (label: string) => {
			await ctx.setStatus?.(label);
			publishChannelEvent(channelId, { kind: "status", label: label.replace(/^_+|_+$/g, "").trim() });
		},
	};
}
