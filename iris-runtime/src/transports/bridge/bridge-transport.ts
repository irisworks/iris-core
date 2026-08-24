// ============================================================================
// BridgeTransport — headless transport for bridge-only mode (sub-agents and
// installs without chat tokens). Replaces the ad-hoc stub bot that previously
// lived in main.ts, and is the proof the ChannelTransport interface isn't
// Slack-shaped: posting/replacing is a no-op for everything except a
// `BRIDGE-*` channel — see resolveIfBridgeChannel() — while for a `SESSION-*`
// channel, responses accumulate in the context and are consumed by session
// requests (POST /sessions/:id/message) instead.
// ============================================================================

import * as log from "../../engine/log.js";
import type { ChannelState } from "../../engine/index.js";
import {
	registerPromptProfile,
	type ChannelInfo,
	type ChannelTransport,
	type MessageContext,
	type TransportEvent,
	type TransportPromptProfile,
	type UserInfo,
} from "../../transport/types.js";

export interface BridgeTransportOptions {
	/** Prompt fragments for bridge runs (currently the Slack fragments, status quo) */
	promptProfile: TransportPromptProfile;
	/**
	 * Dispatch an event into the engine (wired in main.ts to engine.handleEvent).
	 * Returns the run's promise so enqueueEvent's per-channel queue (below) can
	 * wait for one run to finish before starting the next on the same channel.
	 */
	dispatch: (event: TransportEvent, transport: ChannelTransport, isEvent?: boolean) => void | Promise<void>;
}

// ============================================================================
// Per-channel queue for sequential processing — mirrors slack.ts/telegram.ts.
// Without this, two requests that reuse the same conversationKey (same
// requestId ⇒ same BRIDGE-{id} channel) dispatch two concurrent runs against
// the same ChannelState, and both append to the same context.jsonl.
// ============================================================================

type QueuedWork = () => Promise<void>;

class ChannelQueue {
	private queue: QueuedWork[] = [];
	private processing = false;

	enqueue(work: QueuedWork): void {
		this.queue.push(work);
		this.processNext();
	}

	size(): number {
		return this.queue.length;
	}

	private async processNext(): Promise<void> {
		if (this.processing || this.queue.length === 0) return;
		this.processing = true;
		const work = this.queue.shift()!;
		try {
			await work();
		} catch (err) {
			log.logWarning("Queue error", err instanceof Error ? err.message : String(err));
		}
		this.processing = false;
		this.processNext();
	}
}

/**
 * A `BRIDGE-{requestId}` channel is engine/bridge.ts's own — the pending HTTP
 * POST /bridge request is waiting on `resolveBridgeRequest(requestId, ...)`.
 * Both `postMessage` and `createContext().replaceMessage` need this same
 * check: the engine delivers a run's final answer via `replaceMessage`, but
 * some code paths (and tests) post directly via `postMessage`, and either one
 * is how a bridge-only sub-agent's reply actually reaches the caller — without
 * it, the HTTP request hangs until BRIDGE_TIMEOUT_MS and the reply is lost
 * even though the agent generated it successfully.
 */
async function resolveIfBridgeChannel(channelId: string, text: string): Promise<void> {
	if (!channelId.startsWith("BRIDGE-")) return;
	const requestId = channelId.replace("BRIDGE-", "");
	const { resolveBridgeRequest } = await import("../../engine/bridge.js");
	resolveBridgeRequest(requestId, text);
}

export class BridgeTransport implements ChannelTransport {
	readonly transportId = "bridge";
	readonly promptProfile: TransportPromptProfile;
	readonly stopCommandHint = "say `stop` first";
	private readonly dispatch: BridgeTransportOptions["dispatch"];
	private readonly queues = new Map<string, ChannelQueue>();

	constructor(options: BridgeTransportOptions) {
		this.promptProfile = options.promptProfile;
		this.dispatch = options.dispatch;
		registerPromptProfile(this.promptProfile);
	}

	start(): void {}
	stop(): void {}

	/** Fallback owner, like Slack — everything that isn't a Telegram channel. */
	ownsChannel(channelId: string): boolean {
		return !channelId.startsWith("tg-");
	}

	getChannels(): ChannelInfo[] {
		return [];
	}

	getUsers(): UserInfo[] {
		return [];
	}

	async postMessage(channelId: string, text: string): Promise<string> {
		await resolveIfBridgeChannel(channelId, text);
		return Date.now().toString();
	}

	async updateMessage(_channelId: string, _messageId: string, _text: string): Promise<void> {}

	enqueueEvent(event: TransportEvent): boolean {
		const queue = this.getQueue(event.channel);
		if (queue.size() >= 5) {
			log.logWarning(`[bridge] Event queue full for ${event.channel}, discarding: ${event.text.substring(0, 50)}`);
			return false;
		}
		queue.enqueue(async () => {
			await this.dispatch(event, this);
		});
		return true;
	}

	private getQueue(channelId: string): ChannelQueue {
		let queue = this.queues.get(channelId);
		if (!queue) {
			queue = new ChannelQueue();
			this.queues.set(channelId, queue);
		}
		return queue;
	}

	createContext(event: TransportEvent, _state: ChannelState): MessageContext {
		let accumulatedText = "";
		return {
			transportId: this.transportId,
			message: {
				text: event.text,
				rawText: event.text,
				user: event.user,
				channel: event.channel,
				ts: event.ts,
				attachments: (event.attachments || []).map((a) => ({ local: a.local })),
			},
			channels: [],
			users: [],
			// `shouldLog: false` marks agent.ts's progress markers (`_→ running bash_`,
			// `_Compacting…_`, tool errors) rather than the turn's actual text. The
			// accumulator is the reply source for both the engine's post-run bridge
			// fallback and SESSION- requests, so keep the markers out of it.
			respond: async (text: string, shouldLog = true) => {
				if (!shouldLog) return;
				accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;
			},
			replaceMessage: async (text: string) => {
				await resolveIfBridgeChannel(event.channel, text);
			},
			respondInThread: async () => {},
			setTyping: async () => {},
			uploadFile: async () => {},
			setWorking: async () => {},
			deleteMessage: async () => {},
			getAccumulatedText: () => accumulatedText,
		};
	}

	// ==========================================================================
	// SessionInjector surface (required by api.ts)
	// ==========================================================================

	async injectSessionMessage(
		sessionId: string,
		user: string,
		text: string,
		attachments: Array<{ local: string }> = [],
	): Promise<string> {
		const channelId = `SESSION-${sessionId}`;
		// Same 5-message-per-channel convention as enqueueEvent above. Checked
		// before registerSessionRequest so a full queue fails fast (the HTTP
		// handler in api.ts maps the rejection to a 504) instead of registering a
		// promise that hangs until its 90s timeout while queued work waits.
		const queue = this.getQueue(channelId);
		if (queue.size() >= 5) {
			log.logWarning(`[bridge] Session message queue full for ${channelId}, rejecting: ${text.substring(0, 50)}`);
			throw new Error(`session message queue full for ${channelId}`);
		}
		const { registerSessionRequest } = await import("../../engine/sessions.js");
		const ts = (Date.now() / 1000).toFixed(6);
		const responsePromise = registerSessionRequest(sessionId, 90_000);
		const event = { channel: channelId, user, text, ts, attachments };
		queue.enqueue(async () => {
			await this.dispatch(event, this);
		});
		return responsePromise;
	}

	resetSessionContext(_sessionId: string): void {
		// File-based reset is handled directly in api.ts (context.jsonl wiped)
	}
}
