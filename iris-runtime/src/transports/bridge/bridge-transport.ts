// ============================================================================
// BridgeTransport — headless transport for bridge-only mode (sub-agents and
// installs without chat tokens). Replaces the ad-hoc stub bot that previously
// lived in main.ts, and is the proof the ChannelTransport interface isn't
// Slack-shaped: posting is a no-op, responses accumulate in the context and
// are consumed by session requests (POST /sessions/:id/message).
// ============================================================================

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
	/** Dispatch an event into the engine (wired in main.ts to engine.handleEvent) */
	dispatch: (event: TransportEvent, transport: ChannelTransport, isEvent?: boolean) => void;
}

export class BridgeTransport implements ChannelTransport {
	readonly transportId = "bridge";
	readonly promptProfile: TransportPromptProfile;
	readonly stopCommandHint = "say `stop` first";
	private readonly dispatch: BridgeTransportOptions["dispatch"];

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

	async postMessage(_channelId: string, _text: string): Promise<string> {
		return Date.now().toString();
	}

	async updateMessage(_channelId: string, _messageId: string, _text: string): Promise<void> {}

	enqueueEvent(event: TransportEvent): boolean {
		this.dispatch(event, this);
		return true;
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
			respond: async (text: string) => {
				accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;
			},
			replaceMessage: async () => {},
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

	async injectSessionMessage(sessionId: string, user: string, text: string): Promise<string> {
		const { registerSessionRequest } = await import("../../engine/sessions.js");
		const channelId = `SESSION-${sessionId}`;
		const ts = (Date.now() / 1000).toFixed(6);
		const responsePromise = registerSessionRequest(sessionId, 90_000);
		this.dispatch({ channel: channelId, user, text, ts, attachments: [] }, this);
		return responsePromise;
	}

	resetSessionContext(_sessionId: string): void {
		// File-based reset is handled directly in api.ts (context.jsonl wiped)
	}
}
