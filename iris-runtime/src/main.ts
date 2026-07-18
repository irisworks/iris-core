#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, renameSync } from "fs";
import { join, resolve } from "path";
import { startApiServer, type SessionInjector } from "./engine/api.js";
import { startBridgeServer } from "./engine/bridge.js";
import { downloadChannel } from "./transports/slack/download.js";
import { createEngine } from "./engine/index.js";
import { createEventsWatcher } from "./engine/events.js";
import * as log from "./engine/log.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./engine/sandbox.js";
import { type IrisHandler, SlackBot as SlackBotClass, slackPromptProfile } from "./transports/slack/slack.js";
import { TelegramBot, type IrisTelegramHandler } from "./transports/telegram/telegram.js";
import { ChannelStore } from "./engine/store.js";
import { BridgeTransport } from "./transports/bridge/bridge.js";
import { WebTransport } from "./transports/web/web.js";
import type { ChannelTransport, TransportEvent } from "./transport/types.js";

// ============================================================================
// Config
// ============================================================================

const IRIS_SLACK_APP_TOKEN = process.env.IRIS_SLACK_APP_TOKEN ?? process.env.IRIS_SLACK_APP_TOKEN;
const IRIS_SLACK_BOT_TOKEN = process.env.IRIS_SLACK_BOT_TOKEN ?? process.env.IRIS_SLACK_BOT_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

interface ParsedArgs {
	workingDir?: string;
	sandbox: SandboxConfig;
	downloadChannel?: string;
	// Iris extensions
	provider: string;
	model: string;
	environment: "preview" | "prod";
	apiPort: number;
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;
	let downloadChannelId: string | undefined;

	// Iris: provider/model from env first, CLI flags override
	let provider = process.env.IRIS_PROVIDER ?? "anthropic";
	let model = process.env.IRIS_MODEL ?? "claude-sonnet-4-5";
	let environment: "preview" | "prod" = (process.env.IRIS_ENV as "preview" | "prod") ?? "prod";
	let apiPort = parseInt(process.env.IRIS_API_PORT ?? "0", 10);

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--sandbox=")) {
			sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
		} else if (arg === "--sandbox") {
			sandbox = parseSandboxArg(args[++i] || "");
		} else if (arg.startsWith("--download=")) {
			downloadChannelId = arg.slice("--download=".length);
		} else if (arg === "--download") {
			downloadChannelId = args[++i];
		} else if (arg.startsWith("--provider=")) {
			provider = arg.slice("--provider=".length);
		} else if (arg === "--provider") {
			provider = args[++i] || provider;
		} else if (arg.startsWith("--model=")) {
			model = arg.slice("--model=".length);
		} else if (arg === "--model") {
			model = args[++i] || model;
		} else if (arg.startsWith("--environment=")) {
			const env = arg.slice("--environment=".length);
			environment = env === "preview" ? "preview" : "prod";
		} else if (arg === "--environment") {
			const env = args[++i] || "prod";
			environment = env === "preview" ? "preview" : "prod";
		} else if (arg.startsWith("--api-port=")) {
			apiPort = parseInt(arg.slice("--api-port=".length), 10);
		} else if (arg === "--api-port") {
			apiPort = parseInt(args[++i] || "0", 10);
		} else if (!arg.startsWith("-")) {
			workingDir = arg;
		}
	}

	return {
		workingDir: workingDir ? resolve(workingDir) : undefined,
		sandbox,
		downloadChannel: downloadChannelId,
		provider,
		model,
		environment,
		apiPort,
	};
}

const parsedArgs = parseArgs();

// Handle --download mode
if (parsedArgs.downloadChannel) {
	if (!IRIS_SLACK_BOT_TOKEN) {
		console.error("Missing env: IRIS_SLACK_BOT_TOKEN");
		process.exit(1);
	}
	await downloadChannel(parsedArgs.downloadChannel, IRIS_SLACK_BOT_TOKEN);
	process.exit(0);
}

// Normal bot mode - require working dir
if (!parsedArgs.workingDir) {
	console.error("Usage: iris-runtime [--sandbox=host|docker:<name>] [--provider <p>] [--model <m>] [--environment preview|prod] [--api-port <port>] <working-directory>");
	console.error("       iris-runtime --download <channel-id>");
	console.error("Env vars: IRIS_PROVIDER, IRIS_MODEL, IRIS_ENV, IRIS_API_PORT, TELEGRAM_BOT_TOKEN, IRIS_SLACK_APP_TOKEN, IRIS_SLACK_BOT_TOKEN");
	process.exit(1);
}

const { workingDir, sandbox, provider, model, environment, apiPort } = {
	workingDir: parsedArgs.workingDir,
	sandbox: parsedArgs.sandbox,
	provider: parsedArgs.provider,
	model: parsedArgs.model,
	environment: parsedArgs.environment,
	apiPort: parsedArgs.apiPort,
};

// Slack is optional — sub-agents run bridge-only (no Slack connection needed)
const SLACK_ENABLED = !!(IRIS_SLACK_APP_TOKEN && IRIS_SLACK_BOT_TOKEN);

await validateSandbox(sandbox);

// ============================================================================
// Engine (per-channel state + run/stop/compact/reset flows)
// ============================================================================

const engine = createEngine({ workingDir, sandbox, provider, model, botToken: IRIS_SLACK_BOT_TOKEN });

// ============================================================================
// Migration — move flat channel dirs into slack/ and telegram/ subdirectories
// ============================================================================

function migrateChannelDirs(dir: string): void {
	if (!existsSync(dir)) return;
	const entries = readdirSync(dir, { withFileTypes: true });
	let migrated = 0;

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const name = entry.name;

		// Skip already-structured dirs and special dirs
		if (
			name === "slack" || name === "telegram" || name === "data" ||
			name === "events" || name === "sessions" ||
			name.startsWith("SESSION-") || name.startsWith("BRIDGE-") ||
			name.startsWith("ESCALATE-") || name.startsWith("SELFHEAL-") ||
			name.startsWith("WEBUI")
		) continue;

		let destSubdir: string | null = null;
		if (name.startsWith("tg-")) destSubdir = "telegram";
		else if (/^[CDGW]/.test(name)) destSubdir = "slack";

		if (!destSubdir) continue;

		const src = join(dir, name);
		const destDir = join(dir, destSubdir);
		const dest = join(destDir, name);

		if (!existsSync(dest)) {
			if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
			renameSync(src, dest);
			log.logInfo(`[migrate] ${name} → ${destSubdir}/${name}`);
			migrated++;
		}
	}

	if (migrated > 0) log.logInfo(`[migrate] Moved ${migrated} channel director${migrated === 1 ? "y" : "ies"} to transport subdirectories`);
}

// ============================================================================
// Handler
// ============================================================================

// SlackBot and TelegramBot implement ChannelTransport, which is a superset of
// the engine's transport surface — the bots plug straight into the engine.
const handler: IrisHandler = {
	isRunning: (channelId) => engine.isRunning(channelId),
	handleStop: (channelId, slack) => engine.handleStop(channelId, slack),
	handleCompact: (channelId, slack) => engine.handleCompact(channelId, slack),
	handleReset: (channelId, slack) => engine.handleReset(channelId, slack),
	handleEvent: (event, slack, isEvent) => engine.handleEvent(event, slack, isEvent),
};

// ============================================================================
// Telegram handler
// ============================================================================

const telegramHandler: IrisTelegramHandler = {
	isRunning: (channelId) => engine.isRunning(channelId),
	handleStop: (channelId, bot) => engine.handleStop(channelId, bot),
	handleCompact: (channelId, bot) => engine.handleCompact(channelId, bot),
	handleReset: (channelId, bot) => engine.handleReset(channelId, bot),
	handleEvent: (event, bot, isEvent) => engine.handleEvent(event, bot, isEvent),
};

// ============================================================================
// Start
// ============================================================================

let sandboxLabel: string;
if (sandbox.type === "host") {
	sandboxLabel = "host";
} else if (sandbox.type === "docker") {
	sandboxLabel = `docker:${sandbox.container}`;
} else if (sandbox.type === "firecracker") {
	sandboxLabel = `firecracker:${sandbox.agentIp}`;
} else {
	sandboxLabel = "firecracker-pool";
}
log.logStartup(workingDir, sandboxLabel);
log.logInfo(`iris-runtime: provider=${provider} model=${model} environment=${environment}`);

// Migrate flat channel dirs to slack/ and telegram/ subdirectories
migrateChannelDirs(workingDir);

// ============================================================================
// Transports — constructed from env: Slack if tokens, Telegram if token,
// Bridge always. Registry order is the preference order for session
// operations (Slack, then Telegram, then Bridge).
// ============================================================================

const transports: (ChannelTransport & SessionInjector)[] = [];

const slackBot = SLACK_ENABLED
	? new SlackBotClass(handler, {
		appToken: IRIS_SLACK_APP_TOKEN,
		botToken: IRIS_SLACK_BOT_TOKEN,
		workingDir,
		store: new ChannelStore({ workingDir, botToken: IRIS_SLACK_BOT_TOKEN! }),
	})
	: null;
if (slackBot) transports.push(slackBot);

const tgBot = TELEGRAM_BOT_TOKEN ? new TelegramBot(telegramHandler, { token: TELEGRAM_BOT_TOKEN, workingDir }) : null;
if (tgBot) transports.push(tgBot);

// Bridge is always available — sub-agents and the internal API can drive runs
// without any chat tokens. Reuses the Slack prompt fragments (status quo
// before profiles existed); a bridge-specific prompt is a decision for later.
const bridge = new BridgeTransport({
	promptProfile: { ...slackPromptProfile, transportId: "bridge" },
	dispatch: (event, transport, isEvent) => void engine.handleEvent(event, transport, isEvent),
});
transports.push(bridge);

// Web UI is optional — set IRIS_WEBUI_PORT to enable. Off by default, zero
// cost for chat-only installs.
const webuiPort = parseInt(process.env.IRIS_WEBUI_PORT ?? "0", 10);
const webTransport = webuiPort > 0
	? new WebTransport({
		port: webuiPort,
		workingDir,
		dispatch: (event, transport, isEvent) => void engine.handleEvent(event, transport, isEvent),
		commands: {
			stop: (channelId, transport) => engine.handleStop(channelId, transport),
			compact: (channelId, transport) => engine.handleCompact(channelId, transport),
			reset: (channelId, transport) => engine.handleReset(channelId, transport),
		},
	})
	: null;
if (webTransport) transports.push(webTransport);

// ============================================================================
// Wiring — API server, bridge server, transport startup, events watchers
// ============================================================================

// Start internal API server (default port 3000, always-on for sub-agent escalation)
const effectiveApiPort = apiPort > 0 ? apiPort : 3000;
startApiServer(effectiveApiPort, workingDir, engine.channelStates, () => transports);

// Start bridge server if requested (sub-agents only — set IRIS_BRIDGE_PORT)
const bridgePort = parseInt(process.env.IRIS_BRIDGE_PORT ?? "0", 10);
if (bridgePort > 0) {
	startBridgeServer(bridgePort, workingDir);
}

if (slackBot) {
	slackBot.start();
} else {
	log.logInfo("Slack tokens not set — running in bridge-only mode");
}

if (webTransport) {
	webTransport.start();
	process.on("SIGINT", () => { webTransport.stop(); });
	process.on("SIGTERM", () => { webTransport.stop(); });
}

if (tgBot) {
	await tgBot.start();

	// Force reclaim — reset owner so a new user can claim
	if (process.env.IRIS_TELEGRAM_FORCE_RECLAIM === "true") {
		tgBot.claim.reset();
		log.logInfo("[telegram] Force reclaim — previous owner cleared.");
	}

	// If bot is unclaimed, generate a claim token and print it to the terminal
	if (!tgBot.claim.isClaimed()) {
		const token = tgBot.claim.generateToken();
		log.logInfo("[telegram] Bot is unclaimed. Send this token to your bot on Telegram to claim it:");
		log.logInfo("");
		log.logInfo(`    ${token}`);
		log.logInfo("");
		log.logInfo("[telegram] Token expires in 10 minutes. Restart Iris to generate a new one.");
		log.logInfo("[telegram] To force re-claim later, set IRIS_TELEGRAM_FORCE_RECLAIM=true and restart.");
	}

	process.on("SIGINT", () => { tgBot.stop(); });
	process.on("SIGTERM", () => { tgBot.stop(); });
} else {
	log.logInfo("Telegram token not set — Telegram transport disabled");
}

if (!slackBot && !tgBot) {
	log.logInfo("⚡️ Bridge-only mode active");
}

// Route synthetic events to the transport that owns the channel
// (tg-* → Telegram; Slack, then Bridge, is the fallback owner)
const routeEvent = (event: TransportEvent & { type: "mention" }): boolean => {
	const transport = transports.find((t) => t.ownsChannel(event.channel));
	return transport ? transport.enqueueEvent(event) : false;
};

// Watch slack/events/, telegram/events/, and root events/ for backward compat
const watchDirs = ["slack/events", "telegram/events", "events"];
const watchers = watchDirs.map(sub => {
	const w = createEventsWatcher(workingDir, { enqueueEvent: routeEvent }, sub === "events" ? undefined : sub.split("/")[0]);
	w.start();
	return w;
});

process.on("SIGINT", () => { log.logInfo("Shutting down..."); watchers.forEach(w => w.stop()); process.exit(0); });
process.on("SIGTERM", () => { log.logInfo("Shutting down..."); watchers.forEach(w => w.stop()); process.exit(0); });
