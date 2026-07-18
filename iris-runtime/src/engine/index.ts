// ============================================================================
// Engine — one run/stop/compact/reset implementation shared by all transports.
//
// Replaces the near-identical `handler` (Slack) and `telegramHandler` objects
// that previously lived in main.ts. The engine owns per-channel run state and
// dispatch; transports adapt into it via EngineTransport. Per-channel event
// queueing stays inside the transports until the full ChannelTransport
// interface lands.
// ============================================================================

import { getOrCreateRunner, type AgentRunner } from "./agent.js";
import * as log from "./log.js";
import type { SandboxConfig } from "./sandbox.js";
import { ChannelStore, resolveChannelDir } from "./store.js";
import type { MessageContext, TransportEvent } from "../transport/types.js";

export interface ChannelState {
	running: boolean;
	runner: AgentRunner;
	store: ChannelStore;
	stopRequested: boolean;
	stopMessageTs?: string;
}

/**
 * Minimal surface the engine needs from a transport. The full ChannelTransport
 * interface (start/stop, ownsChannel, getChannels/getUsers, ...) is a separate
 * step; keep this to exactly what the run flows use.
 */
export interface EngineTransport {
	postMessage(channelId: string, text: string): Promise<string>;
	updateMessage(channelId: string, messageId: string, text: string): Promise<void>;
	/** How the user stops a run on this transport, e.g. "say \`stop\` first" / "send /stop first" */
	stopCommandHint: string;
	createContext(event: TransportEvent, state: ChannelState, isEvent?: boolean): MessageContext;
}

export interface EngineConfig {
	workingDir: string;
	sandbox: SandboxConfig;
	provider: string;
	model: string;
	botToken?: string;
}

export interface Engine {
	channelStates: Map<string, ChannelState>;
	getState(channelId: string): ChannelState;
	isRunning(channelId: string): boolean;
	handleEvent(event: TransportEvent, transport: EngineTransport, isEvent?: boolean): Promise<void>;
	handleStop(channelId: string, transport: EngineTransport): Promise<void>;
	handleCompact(channelId: string, transport: EngineTransport): Promise<void>;
	handleReset(channelId: string, transport: EngineTransport): Promise<void>;
}

export function createEngine(config: EngineConfig): Engine {
	const { workingDir, sandbox, provider, model, botToken } = config;
	const channelStates = new Map<string, ChannelState>();

	function getState(channelId: string): ChannelState {
		let state = channelStates.get(channelId);
		if (!state) {
			const channelDir = resolveChannelDir(workingDir, channelId);
			state = {
				running: false,
				runner: getOrCreateRunner(sandbox, channelId, channelDir, provider, model, workingDir),
				store: new ChannelStore({ workingDir, botToken: botToken as string }),
				stopRequested: false,
			};
			channelStates.set(channelId, state);
		}
		return state;
	}

	function isRunning(channelId: string): boolean {
		return channelStates.get(channelId)?.running ?? false;
	}

	return {
		channelStates,
		getState,
		isRunning,

		async handleStop(channelId: string, transport: EngineTransport): Promise<void> {
			const state = channelStates.get(channelId);
			if (state?.running) {
				state.stopRequested = true;
				state.runner.abort();
				const ts = await transport.postMessage(channelId, "_Stopping..._");
				state.stopMessageTs = ts; // Updated to "_Stopped_" when the run aborts
			} else {
				await transport.postMessage(channelId, "_Nothing running_");
			}
		},

		async handleCompact(channelId: string, transport: EngineTransport): Promise<void> {
			if (isRunning(channelId)) {
				await transport.postMessage(channelId, `_Can't compact while running — ${transport.stopCommandHint}_`);
				return;
			}
			const state = getState(channelId);
			const ts = await transport.postMessage(channelId, "_Compacting context..._");
			try {
				const result = await state.runner.compact();
				if (result) {
					await transport.updateMessage(channelId, ts, `_Compacted: ${result.tokensBefore.toLocaleString()} tokens summarised_`);
				} else {
					await transport.updateMessage(channelId, ts, "_Compaction complete_");
				}
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				await transport.updateMessage(channelId, ts, `_Compaction failed: ${errMsg}_`);
			}
		},

		async handleReset(channelId: string, transport: EngineTransport): Promise<void> {
			const state = getState(channelId);
			// Abort any in-progress run first, then reset — works even when stuck
			if (state.running) {
				state.stopRequested = true;
				state.runner.abort();
			}
			state.runner.reset();
			state.running = false;
			await transport.postMessage(channelId, "_Context cleared — starting fresh_");
		},

		async handleEvent(event: TransportEvent, transport: EngineTransport, isEvent?: boolean): Promise<void> {
			const state = getState(event.channel);

			// Start run
			state.running = true;
			state.stopRequested = false;

			log.logInfo(`[${event.channel}] Starting run: ${event.text.substring(0, 50)}`);

			try {
				// Create context adapter
				const ctx = transport.createContext(event, state, isEvent);

				// Run the agent
				await ctx.setTyping(true);
				await ctx.setWorking(true);
				const result = await state.runner.run(ctx, state.store);
				await ctx.setWorking(false);

				// Resolve pending session API request (POST /sessions/:id/message bridge pattern)
				if (event.channel.startsWith("SESSION-")) {
					const sessionId = event.channel.slice("SESSION-".length);
					const { resolveSessionRequest } = await import("./sessions.js");
					resolveSessionRequest(sessionId, ctx.getAccumulatedText());
				}

				if (result.stopReason === "aborted" && state.stopRequested) {
					if (state.stopMessageTs) {
						await transport.updateMessage(event.channel, state.stopMessageTs, "_Stopped_");
						state.stopMessageTs = undefined;
					} else {
						await transport.postMessage(event.channel, "_Stopped_");
					}
				}
			} catch (err) {
				log.logWarning(`[${event.channel}] Run error`, err instanceof Error ? err.message : String(err));
			} finally {
				state.running = false;
			}
		},
	};
}
