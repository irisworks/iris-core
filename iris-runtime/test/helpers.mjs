// Test helpers: build a SlackBot against the compiled dist/ with a fake socket
// client, a recording handler, and stubbed outbound Slack calls. This is the
// committed port of the synthetic-event harness that verified PR #37 — it
// drives the real compiled handlers, no source-level mocking.
//
// Requires `npm run build` first (tests import ../dist/*.js).

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlackBot } from "../dist/slack.js";
import { ChannelStore } from "../dist/store.js";

/** Wait for queued microtask/timeout work (ChannelQueue, fire-and-forget forwards). */
export function settle(ms = 25) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Construct a SlackBot wired for synthetic dispatch:
 * - channels.json written from `channels`
 * - recording IrisHandler (calls.events / stops / compacts / resets)
 * - postMessage/postInThread stubbed and recorded (calls.posted / calls.threads)
 * - fake socket client capturing the app_mention/message handlers
 */
export function makeBot({ channels = {}, isRunning = () => false, botUserId = "UBOT", botId = "BBOT" } = {}) {
	const workingDir = mkdtempSync(join(tmpdir(), "iris-dispatch-test-"));
	mkdirSync(join(workingDir, "data"), { recursive: true });
	writeFileSync(join(workingDir, "data", "channels.json"), JSON.stringify(channels));

	const calls = { events: [], stops: [], compacts: [], resets: [], posted: [], threads: [] };
	const handler = {
		isRunning,
		handleEvent: async (event, _bot, isEvent) => {
			calls.events.push({ event, isEvent });
		},
		handleStop: async (channelId) => {
			calls.stops.push(channelId);
		},
		handleCompact: async (channelId) => {
			calls.compacts.push(channelId);
		},
		handleReset: async (channelId) => {
			calls.resets.push(channelId);
		},
	};

	const store = new ChannelStore({ workingDir, botToken: "xoxb-test" });
	const bot = new SlackBot(handler, {
		appToken: "xapp-test",
		botToken: "xoxb-test",
		workingDir,
		store,
	});

	// State normally populated by start(): bot identity + channel modes.
	bot.botUserId = botUserId;
	bot.botId = botId;
	bot.loadChannelModes();

	// Capture outbound Slack calls instead of hitting the API.
	bot.postMessage = async (channel, text) => {
		calls.posted.push({ channel, text });
		return "111.111";
	};
	bot.postInThread = async (channel, threadTs, text) => {
		calls.threads.push({ channel, threadTs, text });
		return "112.112";
	};

	// Fake socket client: capture the handlers setupEventHandlers registers.
	const handlers = new Map();
	bot.socketClient = { on: (name, fn) => handlers.set(name, fn) };
	bot.setupEventHandlers();

	/** Fire a socket envelope at a captured handler; returns an ack counter. */
	const fire = (name, event) => {
		const ack = { count: 0 };
		handlers.get(name)({ event, ack: async () => { ack.count++; } });
		return ack;
	};

	return {
		bot,
		calls,
		workingDir,
		mention: (event) => fire("app_mention", event),
		message: (event) => fire("message", event),
	};
}

/** Fill a channel's queue so the next dispatch sees size >= 5 (one in-flight + 5 queued). */
export function fillQueue(bot, channelId) {
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	const queue = bot.getQueue(channelId);
	for (let i = 0; i < 6; i++) queue.enqueue(() => gate);
	return release;
}
