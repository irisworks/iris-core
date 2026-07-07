// ============================================================================
// Shared transport types
//
// The engine (agent.ts and friends) imports ONLY from this module — never from
// a concrete transport like slack.ts or telegram.ts. Concrete transports
// implement these shapes and re-export them for backward compatibility.
// ============================================================================

// Engine-owned per-channel state; type-only import so this module stays runtime-free
// of engine dependencies (the engine imports this module at runtime, not vice versa).
import type { ChannelState } from "../engine.js";

export interface ChannelInfo {
	id: string;
	name: string;
}

export interface UserInfo {
	id: string;
	userName: string;
	displayName: string;
}

/** A normalized inbound message event, independent of the transport it came from. */
export interface TransportEvent {
	channel: string;
	ts: string;
	user: string;
	text: string;
	/** Processed attachments with local paths (populated after the transport logs the user message) */
	attachments?: Array<{ local: string }>;
}

/**
 * Per-run context handed to the engine. Renamed from the old SlackContext —
 * same shape, plus transportId. respond/replaceMessage/respondInThread own
 * message chunking; the engine never splits text itself.
 */
export interface MessageContext {
	/** Which transport produced this context: "slack" | "telegram" | "bridge" */
	transportId: string;
	message: {
		text: string;
		rawText: string;
		user: string;
		userName?: string;
		channel: string;
		ts: string;
		attachments: Array<{ local: string }>;
	};
	channelName?: string;
	channels: ChannelInfo[];
	users: UserInfo[];
	respond: (text: string, shouldLog?: boolean) => Promise<void>;
	replaceMessage: (text: string) => Promise<void>;
	respondInThread: (text: string) => Promise<void>;
	setTyping: (isTyping: boolean) => Promise<void>;
	uploadFile: (filePath: string, title?: string) => Promise<void>;
	setWorking: (working: boolean) => Promise<void>;
	deleteMessage: () => Promise<void>;
	getAccumulatedText: () => string;
}

/**
 * Transport-specific fragments of the system prompt. The engine composes the
 * prompt from these so it never hardcodes platform text (Slack mrkdwn rules,
 * mention syntax, ...). Registered at transport construction time.
 */
export interface TransportPromptProfile {
	transportId: string;
	/** Identity line, e.g. "You are Iris, a Slack-connected orchestrator for specialized sub-agents." */
	identityLine: string;
	/** Formatting rules section, e.g. "## Slack Formatting (mrkdwn, NOT Markdown)..." */
	formattingSection: string;
	/** Channel/user directory section (ID↔name mappings and mention guidance) */
	directorySection: (channels: ChannelInfo[], users: UserInfo[]) => string;
	/** What [SILENT] does on this transport */
	silentNote: string;
	/** What the attach tool does on this transport */
	attachNote: string;
	/** Tag name wrapping non-image attachment paths in the user prompt, e.g. "slack_attachments" */
	attachmentsTagName: string;
	/** Chunking limit for a single outbound message on this transport */
	maxMessageChars: number;
}

/**
 * A chat platform plugged into the engine. Implementations: SlackBot,
 * TelegramBot, BridgeTransport. Structurally a superset of the engine's
 * EngineTransport surface, so any ChannelTransport plugs straight into
 * engine dispatch. Adding a transport must require ZERO engine edits.
 */
export interface ChannelTransport {
	transportId: string;
	/** Prompt fragments for this transport; also registered in the profile registry */
	promptProfile: TransportPromptProfile;
	/** How the user stops a run, e.g. "say `stop` first" — used in engine status messages */
	stopCommandHint: string;
	start(): Promise<void> | void;
	stop(): Promise<void> | void;
	/** Whether this transport owns the given channel id (e.g. "tg-*" → telegram) */
	ownsChannel(channelId: string): boolean;
	getChannels(): ChannelInfo[];
	getUsers(): UserInfo[];
	postMessage(channelId: string, text: string): Promise<string>;
	updateMessage(channelId: string, messageId: string, text: string): Promise<void>;
	/** Queue an inbound event for processing; false when the channel queue is full */
	enqueueEvent(event: TransportEvent): boolean;
	createContext(event: TransportEvent, state: ChannelState, isEvent?: boolean): MessageContext;
}

const promptProfiles = new Map<string, TransportPromptProfile>();

export function registerPromptProfile(profile: TransportPromptProfile): void {
	promptProfiles.set(profile.transportId, profile);
}

export function getPromptProfile(transportId: string): TransportPromptProfile | undefined {
	return promptProfiles.get(transportId);
}
