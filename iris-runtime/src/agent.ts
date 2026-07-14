import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import { getModel, type ImageContent } from "@mariozechner/pi-ai";
import {
	AgentSession,
	AuthStorage,
	convertToLlm,
	createExtensionRuntime,
	formatSkillsForPrompt,
	loadSkillsFromDir,
	ModelRegistry,
	type ResourceLoader,
	SessionManager,
	type Skill,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { loadAgentRegistry, type AgentRegistry } from "./bridge.js";
import { createIrisSettingsManager, syncLogToSessionManager } from "./context.js";
import * as log from "./log.js";
import { createExecutor, releaseExecutor, type SandboxConfig } from "./sandbox.js";
import {
	getPromptProfile,
	type ChannelInfo,
	type MessageContext,
	type TransportPromptProfile,
	type UserInfo,
} from "./transport/types.js";
import type { ChannelStore } from "./store.js";
import { createIrisTools, setUploadFunction } from "./tools/index.js";

// Model is now configurable via getOrCreateRunner() — no longer hardcoded here.

export interface PendingMessage {
	userName: string;
	text: string;
	attachments: { local: string }[];
	timestamp: number;
}

export interface AgentRunner {
	run(
		ctx: MessageContext,
		store: ChannelStore,
		pendingMessages?: PendingMessage[],
	): Promise<{ stopReason: string; errorMessage?: string }>;
	abort(): void;
	/** Summarise old messages into a single compaction entry and replace in-context */
	compact(): Promise<{ tokensBefore: number } | null>;
	/** Wipe all message history so the next prompt starts with a blank slate */
	reset(): void;
}

async function getAnthropicApiKey(authStorage: AuthStorage): Promise<string> {
	const key = await authStorage.getApiKey("anthropic");
	if (!key) {
		throw new Error(
			"No API key found for anthropic.\n\n" +
				"Set an API key environment variable, or use /login with Anthropic and link to auth.json from " +
				join(homedir(), ".pi", "iris", "auth.json"),
		);
	}
	return key;
}

const IMAGE_MIME_TYPES: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
};

function getImageMimeType(filename: string): string | undefined {
	return IMAGE_MIME_TYPES[filename.toLowerCase().split(".").pop() || ""];
}

/**
 * Load the Iris constitution from CONSTITUTION.md in the workspace.
 * This is a read-only, append-only system prompt section that Iris cannot overwrite.
 * Returns empty string if no constitution file exists.
 */
function loadConstitution(workspaceDir: string): string {
	const constitutionPath = join(workspaceDir, "CONSTITUTION.md");
	if (!existsSync(constitutionPath)) return "";
	try {
		const content = readFileSync(constitutionPath, "utf-8").trim();
		if (!content) return "";
		// Inject today's date so agents can reason about relative dates
		const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const today = new Date().toLocaleDateString(undefined, {
			weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: tz
		});
		const dateInjection = `\n\n> **Today's date:** ${today}`;
		return `## Constitution (read-only — set by operators, not editable by Iris)\n${content}${dateInjection}`;
	} catch (error) {
		log.logWarning("Failed to read CONSTITUTION.md", `${constitutionPath}: ${error}`);
		return "";
	}
}

function getMemory(channelDir: string, workingDir: string): string {
	const parts: string[] = [];

	// Read workspace-level memory (shared across all channels)
	const workspaceMemoryPath = join(workingDir, "MEMORY.md");
	if (existsSync(workspaceMemoryPath)) {
		try {
			const content = readFileSync(workspaceMemoryPath, "utf-8").trim();
			if (content) {
				parts.push(`### Global Workspace Memory\n${content}`);
			}
		} catch (error) {
			log.logWarning("Failed to read workspace memory", `${workspaceMemoryPath}: ${error}`);
		}
	}

	// Read channel-specific memory
	const channelMemoryPath = join(channelDir, "MEMORY.md");
	if (existsSync(channelMemoryPath)) {
		try {
			const content = readFileSync(channelMemoryPath, "utf-8").trim();
			if (content) {
				parts.push(`### Channel-Specific Memory\n${content}`);
			}
		} catch (error) {
			log.logWarning("Failed to read channel memory", `${channelMemoryPath}: ${error}`);
		}
	}

	if (parts.length === 0) {
		return "(no working memory yet)";
	}

	return parts.join("\n\n");
}

function loadIrisSkills(channelDir: string, workspacePath: string, workingDir: string): Skill[] {
	const skillMap = new Map<string, Skill>();

	// channelDir is the host path (e.g., /Users/.../data/telegram/tg-XXX)
	// hostWorkspacePath is the workspace root on host
	// workspacePath is the container path (e.g., /workspace)
	const hostWorkspacePath = workingDir;

	// Helper to translate host paths to container paths
	const translatePath = (hostPath: string): string => {
		if (hostPath.startsWith(hostWorkspacePath)) {
			return workspacePath + hostPath.slice(hostWorkspacePath.length);
		}
		return hostPath;
	};

	// Load workspace-level skills (global)
	const workspaceSkillsDir = join(hostWorkspacePath, "skills");
	for (const skill of loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" }).skills) {
		// Translate paths to container paths for system prompt
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	// Load channel-specific skills (override workspace skills on collision)
	const channelSkillsDir = join(channelDir, "skills");
	for (const skill of loadSkillsFromDir({ dir: channelSkillsDir, source: "channel" }).skills) {
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	return Array.from(skillMap.values());
}

export function buildSystemPrompt(
	workspacePath: string,
	channelId: string,
	memory: string,
	constitution: string,
	sandboxConfig: SandboxConfig,
	channels: ChannelInfo[],
	users: UserInfo[],
	skills: Skill[],
	agents: AgentRegistry = {},
	profile: TransportPromptProfile,
): string {
	const channelPath = `${workspacePath}/${channelId}`;
	const isDocker = sandboxConfig.type === "docker";

	const envDescription = isDocker
		? `You are running inside a Docker container (Alpine Linux).
- Bash working directory: / (use cd or absolute paths)
- Install tools with: apk add <package>
- Your changes persist across sessions`
		: `You are running directly on the host machine.
- Bash working directory: ${process.cwd()}
- Be careful with system modifications`;

	const constitutionSection = constitution ? `\n\n${constitution}` : "";

	return `${profile.identityLine} Be concise. No emojis.${constitutionSection}

## Context
- For the current date/time, use: date
- You have access to previous conversation context including tool results from prior turns.
- For older history beyond your context, search log.jsonl (contains user messages and your final responses, but not tool results).

${profile.formattingSection}

${profile.directorySection(channels, users)}

## Environment
${envDescription}

## Workspace Layout
${workspacePath}/
├── MEMORY.md                    # Global memory (all channels)
├── skills/                      # Global CLI tools you create
└── ${channelId}/                # This channel
    ├── MEMORY.md                # Channel-specific memory
    ├── log.jsonl                # Message history (no tool results)
    ├── attachments/             # User-shared files
    ├── scratch/                 # Your working directory
    └── skills/                  # Channel-specific tools

## Skills (Custom CLI Tools)
You can create reusable CLI tools for recurring tasks (email, APIs, data processing, etc.).

### Creating Skills
Store in \`${workspacePath}/skills/<name>/\` (global) or \`${channelPath}/skills/<name>/\` (channel-specific).
Each skill directory needs a \`SKILL.md\` with YAML frontmatter:

\`\`\`markdown
---
name: skill-name
description: Short description of what this skill does
---

# Skill Name

Usage instructions, examples, etc.
Scripts are in: {baseDir}/
\`\`\`

\`name\` and \`description\` are required. Use \`{baseDir}\` as placeholder for the skill's directory path.

### Available Skills
${skills.length > 0 ? formatSkillsForPrompt(skills) : "(no skills installed yet)"}

## Sub-Agents
${Object.keys(agents).length > 0
	? `Specialized sub-agents you can delegate to via their bridge HTTP API. Route requests based on *intent* — no @mention required from the user. When a user's message clearly matches a sub-agent's domain, call its bridge via bash and return its response.

${Object.entries(agents).map(([name, entry]) => `### ${name}
Description: ${entry.description ?? "(no description)"}
Bridge: \`curl -s -X POST ${entry.bridge_url}/bridge -H 'Content-Type: application/json' -d '{"text":"<query>","user":"<username>"}'  | jq -r '.text'\``).join("\n\n")}

Only delegate when the user's intent clearly matches a sub-agent's domain. Handle general questions yourself.`
	: "(no sub-agents configured)"}

## Events
You can schedule events that wake you up at specific times or when external things happen. Events are JSON files in \`${workspacePath}/events/\`.

### Event Types

**Immediate** - Triggers as soon as harness sees the file. Use in scripts/webhooks to signal external events.
\`\`\`json
{"type": "immediate", "channelId": "${channelId}", "text": "New GitHub issue opened"}
\`\`\`

**One-shot** - Triggers once at a specific time. Use for reminders.
\`\`\`json
{"type": "one-shot", "channelId": "${channelId}", "text": "Remind Mario about dentist", "at": "2025-12-15T09:00:00+01:00"}
\`\`\`

**Periodic** - Triggers on a cron schedule. Use for recurring tasks.
\`\`\`json
{"type": "periodic", "channelId": "${channelId}", "text": "Check inbox and summarize", "schedule": "0 9 * * 1-5", "timezone": "${Intl.DateTimeFormat().resolvedOptions().timeZone}"}
\`\`\`

### Cron Format
\`minute hour day-of-month month day-of-week\`
- \`0 9 * * *\` = daily at 9:00
- \`0 9 * * 1-5\` = weekdays at 9:00
- \`30 14 * * 1\` = Mondays at 14:30
- \`0 0 1 * *\` = first of each month at midnight

### Timezones
All \`at\` timestamps must include offset (e.g., \`+01:00\`). Periodic events use IANA timezone names. The harness runs in ${Intl.DateTimeFormat().resolvedOptions().timeZone}. When users mention times without timezone, assume ${Intl.DateTimeFormat().resolvedOptions().timeZone}.

### Creating Events
Use unique filenames to avoid overwriting existing events. Include a timestamp or random suffix:
\`\`\`bash
cat > ${workspacePath}/events/dentist-reminder-$(date +%s).json << 'EOF'
{"type": "one-shot", "channelId": "${channelId}", "text": "Dentist tomorrow", "at": "2025-12-14T09:00:00+01:00"}
EOF
\`\`\`
Or check if file exists first before creating.

### Managing Events
- List: \`ls ${workspacePath}/events/\`
- View: \`cat ${workspacePath}/events/foo.json\`
- Delete/cancel: \`rm ${workspacePath}/events/foo.json\`

### When Events Trigger
You receive a message like:
\`\`\`
[EVENT:dentist-reminder.json:one-shot:2025-12-14T09:00:00+01:00] Dentist tomorrow
\`\`\`
Immediate and one-shot events auto-delete after triggering. Periodic events persist until you delete them.

### Silent Completion
For periodic events where there's nothing to report, respond with just \`[SILENT]\` (no other text). ${profile.silentNote} Use this to avoid spamming the channel when periodic checks find nothing actionable.

### Debouncing
When writing programs that create immediate events (email watchers, webhook handlers, etc.), always debounce. If 50 emails arrive in a minute, don't create 50 immediate events. Instead collect events over a window and create ONE immediate event summarizing what happened, or just signal "new activity, check inbox" rather than per-item events. Or simpler: use a periodic event to check for new items every N minutes instead of immediate events.

### Limits
Maximum 5 events can be queued. Don't create excessive immediate or periodic events.

## Memory
Write to MEMORY.md files to persist context across conversations.
- Global (${workspacePath}/MEMORY.md): skills, preferences, project info
- Channel (${channelPath}/MEMORY.md): channel-specific decisions, ongoing work
Update when you learn something important or when asked to remember something.

### Current Memory
${memory}

## System Configuration Log
Maintain ${workspacePath}/SYSTEM.md to log all environment modifications:
- Installed packages (apk add, npm install, pip install)
- Environment variables set
- Config files modified (~/.gitconfig, cron jobs, etc.)
- Skill dependencies installed

Update this file whenever you modify the environment. On fresh container, read it first to restore your setup.

## Log Queries (for older history)
Format: \`{"date":"...","ts":"...","user":"...","userName":"...","text":"...","isBot":false}\`
The log contains user messages and your final responses (not tool calls/results).
${isDocker ? "Install jq: apk add jq" : ""}

\`\`\`bash
# Recent messages
tail -30 log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Search for specific topic
grep -i "topic" log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Messages from specific user
grep '"userName":"mario"' log.jsonl | tail -20 | jq -c '{date: .date[0:19], text}'
\`\`\`

## Tools
- bash: Run shell commands (primary tool). Install packages as needed.
- read: Read files
- write: Create/overwrite files
- edit: Surgical file edits
- attach: ${profile.attachNote}

Each tool requires a "label" parameter (shown to user).
`;
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.substring(0, maxLen - 3)}...`;
}

function extractToolResultText(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}

	if (
		result &&
		typeof result === "object" &&
		"content" in result &&
		Array.isArray((result as { content: unknown }).content)
	) {
		const content = (result as { content: Array<{ type: string; text?: string }> }).content;
		const textParts: string[] = [];
		for (const part of content) {
			if (part.type === "text" && part.text) {
				textParts.push(part.text);
			}
		}
		if (textParts.length > 0) {
			return textParts.join("\n");
		}
	}

	return JSON.stringify(result);
}

function formatToolArgs(_toolName: string, args: Record<string, unknown>): string {
	const lines: string[] = [];

	for (const [key, value] of Object.entries(args)) {
		if (key === "label") continue;

		if (key === "path" && typeof value === "string") {
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined && limit !== undefined) {
				lines.push(`${value}:${offset}-${offset + limit}`);
			} else {
				lines.push(value);
			}
			continue;
		}

		if (key === "offset" || key === "limit") continue;

		if (typeof value === "string") {
			lines.push(value);
		} else {
			lines.push(JSON.stringify(value));
		}
	}

	return lines.join("\n");
}

// Cache runners per channel
const channelRunners = new Map<string, AgentRunner>();

/**
 * Get or create an AgentRunner for a channel.
 * Runners are cached - one per channel, persistent across messages.
 */
export function getOrCreateRunner(
	sandboxConfig: SandboxConfig,
	channelId: string,
	channelDir: string,
	provider: string,
	modelId: string,
	workingDir: string,
): AgentRunner {
	const existing = channelRunners.get(channelId);
	if (existing) return existing;

	const runner = createRunner(sandboxConfig, channelId, channelDir, provider, modelId, workingDir);
	channelRunners.set(channelId, runner);
	return runner;
}

/**
 * Create a new AgentRunner for a channel.
 * Sets up the session and subscribes to events once.
 */
function createRunner(
	sandboxConfig: SandboxConfig,
	channelId: string,
	channelDir: string,
	provider: string,
	modelId: string,
	workingDir: string,
): AgentRunner {
	const executor = createExecutor(sandboxConfig, channelId);
	const workspaceDir = workingDir;
	const workspacePath = executor.getWorkspacePath(workspaceDir);

	// Create tools
	const tools = createIrisTools(executor);

	// Create AuthStorage and ModelRegistry early so we can resolve custom providers.
	// models.json from the workspace is passed so Foundry/custom providers are loaded.
	// Auth stored outside workspace so agent can't access it.
	const authStorage = AuthStorage.create(join(homedir(), ".pi", "iris", "auth.json"));
	const workspaceModelsJson = join(workspaceDir, "models.json");
	const modelRegistry = ModelRegistry.create(
		authStorage,
		existsSync(workspaceModelsJson) ? workspaceModelsJson : undefined,
	);

	// Resolve model from registry (handles built-in providers and custom providers from models.json).
	// Fall back to getModel() for built-in-only providers if registry doesn't find it.
	const model = (() => {
		const found = modelRegistry.find(provider, modelId);
		if (found) {
			log.logInfo(`[${channelId}] Using model from registry: ${provider}/${modelId}`);
			return found;
		}
		log.logWarning(`[${channelId}] Model ${provider}/${modelId} not in registry, trying built-in getModel()`);
		try {
			return getModel(provider as Parameters<typeof getModel>[0], modelId as Parameters<typeof getModel>[1]);
		} catch {
			throw new Error(
				`Model '${provider}/${modelId}' not found in registry or built-ins. ` +
					`Check models.json at ${workspaceModelsJson} or use a known provider.`,
			);
		}
	})();

	// getApiKey: ModelRegistry handles env var lookup + auth storage for any provider
	const getApiKey = async (): Promise<string> => {
		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (auth.ok && auth.apiKey) return auth.apiKey;
		// Fallback env var: FOUNDRY_E2_KEY, ANTHROPIC_API_KEY, etc.
		const envFallback = process.env[`${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`];
		if (envFallback) return envFallback;
		throw new Error(
			`No API key found for provider '${provider}'. ` +
				`Set ${provider.toUpperCase().replace(/-/g, "_")}_API_KEY env var or configure auth.`,
		);
	};

	// Initial system prompt (will be updated each run with fresh memory/channels/users/skills
	// and the real transport profile — this placeholder is never sent to the LLM)
	const placeholderProfile: TransportPromptProfile = {
		transportId: "placeholder",
		identityLine: "You are Iris, an orchestrator for specialized sub-agents.",
		formattingSection: "## Formatting\nPlain text.",
		directorySection: () => "## Channels\n(no channels loaded)",
		silentNote: "This deletes the status message and posts nothing to the channel.",
		attachNote: "Share files to the channel",
		attachmentsTagName: "attachments",
		maxMessageChars: 30000,
	};
	const memory = getMemory(channelDir, workingDir);
	const constitution = loadConstitution(workspaceDir);
	const skills = loadIrisSkills(channelDir, workspacePath, workingDir);
	const agents = loadAgentRegistry(workspaceDir);
	const systemPrompt = buildSystemPrompt(workspacePath, channelId, memory, constitution, sandboxConfig, [], [], skills, agents, placeholderProfile);

	// Create session manager and settings manager
	// Use a fixed context.jsonl file per channel (not timestamped like coding-agent)
	const contextFile = join(channelDir, "context.jsonl");
	const sessionManager = SessionManager.open(contextFile, channelDir);
	const settingsManager = createIrisSettingsManager(workingDir);

	// Create agent
	const agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			thinkingLevel: "off",
			tools,
		},
		convertToLlm,
		getApiKey,
	});

	// Load existing messages
	const loadedSession = sessionManager.buildSessionContext();
	if (loadedSession.messages.length > 0) {
		agent.state.messages = loadedSession.messages;
		log.logInfo(`[${channelId}] Loaded ${loadedSession.messages.length} messages from context.jsonl`);
	}

	const resourceLoader: ResourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};

	const baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

	// Create AgentSession wrapper
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		modelRegistry,
		resourceLoader,
		baseToolsOverride,
	});

	// Mutable per-run state - event handler references this
	const runState = {
		ctx: null as MessageContext | null,
		logCtx: null as { channelId: string; userName?: string; channelName?: string } | null,
		queue: null as {
			enqueue(fn: () => Promise<void>, errorContext: string): void;
			enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog?: boolean): void;
		} | null,
		pendingTools: new Map<string, { toolName: string; args: unknown; startTime: number }>(),
		totalUsage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		errorMessage: undefined as string | undefined,
	};

	// Subscribe to events ONCE
	session.subscribe(async (event) => {
		// Skip if no active run
		if (!runState.ctx || !runState.logCtx || !runState.queue) return;

		const { ctx, logCtx, queue, pendingTools } = runState;
		const isSessionChannel = channelId.startsWith("SESSION-");

		if (event.type === "tool_execution_start") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_start" };
			const args = agentEvent.args as { label?: string };
			const label = args.label || agentEvent.toolName;

			pendingTools.set(agentEvent.toolCallId, {
				toolName: agentEvent.toolName,
				args: agentEvent.args,
				startTime: Date.now(),
			});

			log.logToolStart(logCtx, agentEvent.toolName, label, agentEvent.args as Record<string, unknown>);
			ctx.onToolEvent?.({
				id: agentEvent.toolCallId,
				toolName: agentEvent.toolName,
				label,
				args: agentEvent.args,
				phase: "start",
			});
			if (!isSessionChannel) {
				queue.enqueue(() => ctx.respond(`_→ ${label}_`, false), "tool label");
			}
		} else if (event.type === "tool_execution_end") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_end" };
			const resultStr = extractToolResultText(agentEvent.result);
			const pending = pendingTools.get(agentEvent.toolCallId);
			pendingTools.delete(agentEvent.toolCallId);

			const durationMs = pending ? Date.now() - pending.startTime : 0;

			if (agentEvent.isError) {
				log.logToolError(logCtx, agentEvent.toolName, durationMs, resultStr);
			} else {
				log.logToolSuccess(logCtx, agentEvent.toolName, durationMs, resultStr);
			}

			// Post args + result to thread
			const label = pending?.args ? (pending.args as { label?: string }).label : undefined;
			const argsFormatted = pending
				? formatToolArgs(agentEvent.toolName, pending.args as Record<string, unknown>)
				: "(args not found)";
			const duration = (durationMs / 1000).toFixed(1);
			let threadMessage = `*${agentEvent.isError ? "✗" : "✓"} ${agentEvent.toolName}*`;
			if (label) threadMessage += `: ${label}`;
			threadMessage += ` (${duration}s)\n`;
			if (argsFormatted) threadMessage += `\`\`\`\n${argsFormatted}\n\`\`\`\n`;
			threadMessage += `*Result:*\n\`\`\`\n${resultStr}\n\`\`\``;

			queue.enqueueMessage(threadMessage, "thread", "tool result thread", false);
			ctx.onToolEvent?.({
				id: agentEvent.toolCallId,
				toolName: agentEvent.toolName,
				label,
				args: pending?.args,
				result: resultStr,
				isError: agentEvent.isError,
				durationMs,
				phase: "end",
			});

			if (agentEvent.isError && !isSessionChannel) {
				queue.enqueue(() => ctx.respond(`_Error: ${truncate(resultStr, 200)}_`, false), "tool error");
			}
		} else if (event.type === "message_start") {
			const agentEvent = event as AgentEvent & { type: "message_start" };
			if (agentEvent.message.role === "assistant") {
				log.logResponseStart(logCtx);
			}
		} else if (event.type === "message_end") {
			const agentEvent = event as AgentEvent & { type: "message_end" };
			if (agentEvent.message.role === "assistant") {
				const assistantMsg = agentEvent.message as any;

				if (assistantMsg.stopReason) {
					runState.stopReason = assistantMsg.stopReason;
				}
				if (assistantMsg.errorMessage) {
					runState.errorMessage = assistantMsg.errorMessage;
				}

				if (assistantMsg.usage) {
					runState.totalUsage.input += assistantMsg.usage.input;
					runState.totalUsage.output += assistantMsg.usage.output;
					runState.totalUsage.cacheRead += assistantMsg.usage.cacheRead;
					runState.totalUsage.cacheWrite += assistantMsg.usage.cacheWrite;
					runState.totalUsage.cost.input += assistantMsg.usage.cost.input;
					runState.totalUsage.cost.output += assistantMsg.usage.cost.output;
					runState.totalUsage.cost.cacheRead += assistantMsg.usage.cost.cacheRead;
					runState.totalUsage.cost.cacheWrite += assistantMsg.usage.cost.cacheWrite;
					runState.totalUsage.cost.total += assistantMsg.usage.cost.total;
				}

				const content = agentEvent.message.content;
				const thinkingParts: string[] = [];
				const textParts: string[] = [];
				for (const part of content) {
					if (part.type === "thinking") {
						thinkingParts.push((part as any).thinking);
					} else if (part.type === "text") {
						textParts.push((part as any).text);
					}
				}

				const text = textParts.join("\n");

				const MAX_THINKING = 2900;
				for (const thinking of thinkingParts) {
					log.logThinking(logCtx, thinking);
					const truncated =
						thinking.length > MAX_THINKING
							? thinking.substring(0, MAX_THINKING) + "\n\n_(thinking truncated)_"
							: thinking;
					queue.enqueueMessage(`_${truncated}_`, "thread", "thinking thread", false);
				}

				if (text.trim()) {
					log.logResponse(logCtx, text);
					queue.enqueueMessage(text, "main", "response main");
					// Thread posting handled by replaceMessage() at end of generation
				}
			}
		} else if (event.type === "compaction_start") {
			log.logInfo(`Compaction started (reason: ${event.reason})`);
			if (!isSessionChannel) {
				queue.enqueue(() => ctx.respond("_Compacting context..._", false), "compaction start");
			}
		} else if (event.type === "compaction_end") {
			if (event.result) {
				log.logInfo(`Compaction complete: ${event.result.tokensBefore} tokens compacted`);
			} else if (event.aborted) {
				log.logInfo("Compaction aborted");
			}
		} else if (event.type === "auto_retry_start") {
			const retryEvent = event as any;
			log.logWarning(`Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})`, retryEvent.errorMessage);
			if (!isSessionChannel) {
				queue.enqueue(
					() => ctx.respond(`_Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})..._`, false),
					"retry",
				);
			}
		}
	});

	// Message-length limit comes from the transport's prompt profile (maxMessageChars)
	const splitMessage = (text: string, maxChars: number): string[] => {
		if (text.length <= maxChars) return [text];
		const parts: string[] = [];
		let remaining = text;
		let partNum = 1;
		while (remaining.length > 0) {
			const chunk = remaining.substring(0, maxChars - 50);
			remaining = remaining.substring(maxChars - 50);
			const suffix = remaining.length > 0 ? `\n_(continued ${partNum}...)_` : "";
			parts.push(chunk + suffix);
			partNum++;
		}
		return parts;
	};

	async function doCompact(): Promise<{ tokensBefore: number } | null> {
		try {
			const result = await session.compact();
			const reloaded = sessionManager.buildSessionContext();
			if (reloaded.messages.length > 0) {
				agent.state.messages = reloaded.messages;
			}
			return result ? { tokensBefore: result.tokensBefore } : null;
		} catch (err) {
			log.logWarning(`[${channelId}] compact() failed`, err instanceof Error ? err.message : String(err));
			return null;
		}
	}

	return {
		async run(
			ctx: MessageContext,
			_store: ChannelStore,
			_pendingMessages?: PendingMessage[],
		): Promise<{ stopReason: string; errorMessage?: string }> {
			// Resolve the transport's prompt profile — registered by the transport module
			const profile = getPromptProfile(ctx.transportId);
			if (!profile) {
				throw new Error(`No prompt profile registered for transport "${ctx.transportId}"`);
			}

			// Ensure channel directory exists
			await mkdir(channelDir, { recursive: true });

			// Sync messages from log.jsonl that arrived while we were offline or busy
			// Exclude the current message (it will be added via prompt())
			const syncedCount = syncLogToSessionManager(sessionManager, channelDir, ctx.message.ts);
			if (syncedCount > 0) {
				log.logInfo(`[${channelId}] Synced ${syncedCount} messages from log.jsonl`);
			}

			// Reload messages from context.jsonl
			// This picks up any messages synced above
			const reloadedSession = sessionManager.buildSessionContext();
			if (reloadedSession.messages.length > 0) {
				agent.state.messages = reloadedSession.messages;
				log.logInfo(`[${channelId}] Reloaded ${reloadedSession.messages.length} messages from context`);
			}

			// Update system prompt with fresh memory, constitution, channel/user info, and skills
			const memory = getMemory(channelDir, workingDir);
			const constitution = loadConstitution(workspaceDir);
			let skills = loadIrisSkills(channelDir, workspacePath, workingDir);
			// SESSION- channels are non-admin (thread mode) — no agent spawning allowed
			if (channelId.startsWith("SESSION-")) {
				skills = skills.filter((s) => s.name !== "spawn-agent");
			}
			const agents = loadAgentRegistry(workspaceDir);
			const systemPrompt = buildSystemPrompt(
				workspacePath,
				channelId,
				memory,
				constitution,
				sandboxConfig,
				ctx.channels,
				ctx.users,
				skills,
				agents,
				profile,
			);
			session.agent.state.systemPrompt = systemPrompt;

			// Set up file upload function
			setUploadFunction(async (filePath: string, title?: string) => {
				const hostPath = translateToHostPath(filePath, channelDir, workspacePath, channelId, workingDir);
				await ctx.uploadFile(hostPath, title);
			});

			// Reset per-run state
			runState.ctx = ctx;
			runState.logCtx = {
				channelId: ctx.message.channel,
				userName: ctx.message.userName,
				channelName: ctx.channelName,
			};
			runState.pendingTools.clear();
			runState.totalUsage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			runState.stopReason = "stop";
			runState.errorMessage = undefined;

			// Create queue for this run
			let queueChain = Promise.resolve();
			runState.queue = {
				enqueue(fn: () => Promise<void>, errorContext: string): void {
					queueChain = queueChain.then(async () => {
						try {
							await fn();
						} catch (err) {
							const errMsg = err instanceof Error ? err.message : String(err);
							log.logWarning(`Transport API error (${errorContext})`, errMsg);
							try {
								await ctx.respondInThread(`_Error: ${errMsg}_`);
							} catch {
								// Ignore
							}
						}
					});
				},
				enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog = true): void {
					const parts = splitMessage(text, profile.maxMessageChars);
					for (const part of parts) {
						this.enqueue(
							() => (target === "main" ? ctx.respond(part, doLog) : ctx.respondInThread(part)),
							errorContext,
						);
					}
				},
			};

			// Log context info
			log.logInfo(`Context sizes - system: ${systemPrompt.length} chars, memory: ${memory.length} chars`);
			log.logInfo(`Channels: ${ctx.channels.length}, Users: ${ctx.users.length}`);

			// Build user message with timestamp and username prefix
			// Format: "[YYYY-MM-DD HH:MM:SS+HH:MM] [username]: message" so LLM knows when and who
			const now = new Date();
			const pad = (n: number) => n.toString().padStart(2, "0");
			const offset = -now.getTimezoneOffset();
			const offsetSign = offset >= 0 ? "+" : "-";
			const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
			const offsetMins = pad(Math.abs(offset) % 60);
			const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetSign}${offsetHours}:${offsetMins}`;
			let userMessage = `[${timestamp}] [${ctx.message.userName || "unknown"}]: ${ctx.message.text}`;

			const imageAttachments: ImageContent[] = [];
			const nonImagePaths: string[] = [];

			for (const a of ctx.message.attachments || []) {
				const fullPath = `${workspacePath}/${a.local}`;
				const mimeType = getImageMimeType(a.local);

				if (mimeType && existsSync(fullPath)) {
					try {
						imageAttachments.push({
							type: "image",
							mimeType,
							data: readFileSync(fullPath).toString("base64"),
						});
					} catch {
						nonImagePaths.push(fullPath);
					}
				} else {
					nonImagePaths.push(fullPath);
				}
			}

			if (nonImagePaths.length > 0) {
				userMessage += `\n\n<${profile.attachmentsTagName}>\n${nonImagePaths.join("\n")}\n</${profile.attachmentsTagName}>`;
			}

			// Debug: write context to last_prompt.jsonl
			const debugContext = {
				systemPrompt,
				messages: session.messages,
				newUserMessage: userMessage,
				imageAttachmentCount: imageAttachments.length,
			};
			await writeFile(join(channelDir, "last_prompt.jsonl"), JSON.stringify(debugContext, null, 2));

			// Pre-run auto-compaction: if the estimated context exceeds IRIS_COMPACT_THRESHOLD
			// (default 60%) of the model window, compact down toward IRIS_COMPACT_TARGET
			// (default 10%) before prompting — prevents mid-run context overflow.
			// The post-run >=70% check below remains as a backstop using real usage numbers.
			const windowTokens = model.contextWindow || 200000;
			const compactThreshold = (Number(process.env.IRIS_COMPACT_THRESHOLD) || 0.6) * windowTokens;
			const compactTarget = (Number(process.env.IRIS_COMPACT_TARGET) || 0.1) * windowTokens;
			// Rough token estimate: chars / 4 (good enough for cl100k/tiktoken-like encodings)
			const estimateTokens = () =>
				Math.round((systemPrompt.length + JSON.stringify(session.messages).length) / 4);
			const estimatedTokens = estimateTokens();
			if (estimatedTokens > compactThreshold) {
				log.logInfo(
					`[${channelId}] Pre-run auto-compact: ~${estimatedTokens.toLocaleString()} est. tokens > ${Math.round(compactThreshold).toLocaleString()} threshold`,
				);
				const notifyCompact = !channelId.startsWith("SESSION-");
				if (notifyCompact) {
					runState.queue.enqueue(
						() => ctx.respond(`_Auto-compacting context (~${estimatedTokens.toLocaleString()} tokens)..._`, false),
						"auto-compact start",
					);
				}
				for (let attempt = 1; attempt <= 3; attempt++) {
					const result = await doCompact();
					if (!result) break;
					const newTokens = estimateTokens();
					log.logInfo(
						`[${channelId}] Compact attempt ${attempt}: ${result.tokensBefore.toLocaleString()} → ~${newTokens.toLocaleString()} est. tokens`,
					);
					if (newTokens <= compactTarget) break;
				}
				if (notifyCompact) {
					runState.queue.enqueue(() => ctx.respond("_Context compacted_", false), "auto-compact end");
				}
			}

			// Retry loop with per-call timeout and exponential backoff for rate-limit / transient errors
			const LLM_TIMEOUT_MS = (Number(process.env.IRIS_LLM_TIMEOUT_SECS) || 90) * 1000;
			const MAX_RETRIES = Number(process.env.IRIS_LLM_MAX_RETRIES) || 3;
			const RETRY_BASE_MS = Number(process.env.IRIS_LLM_RETRY_BASE_MS) || 2000;
			const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

			let lastError: Error | undefined;
			for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
				let llmTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
				const llmTimeout = new Promise<never>((_, reject) => {
					llmTimeoutHandle = setTimeout(() => {
						log.logWarning(`[${channelId}] LLM timeout after ${LLM_TIMEOUT_MS / 1000}s (attempt ${attempt}/${MAX_RETRIES})`);
						session.agent.abort();
						reject(new Error(`LLM response timeout after ${LLM_TIMEOUT_MS / 1000}s`));
					}, LLM_TIMEOUT_MS);
				});
				try {
					await Promise.race([
						session.prompt(userMessage, imageAttachments.length > 0 ? { images: imageAttachments } : undefined),
						llmTimeout,
					]);
					lastError = undefined;
					break; // success
				} catch (err) {
					lastError = err instanceof Error ? err : new Error(String(err));
					const msg = lastError.message.toLowerCase();
					const isRetryable = msg.includes("timeout") || msg.includes("429") || msg.includes("econnreset") || msg.includes("fetch failed") || msg.includes("rate limit") || msg.includes("throttled");
					if (!isRetryable || attempt === MAX_RETRIES) {
						throw lastError; // final failure — will be caught below
					}
					const delay = RETRY_BASE_MS * (2 ** (attempt - 1)) + Math.random() * 1000;
					log.logWarning(`[${channelId}] LLM attempt ${attempt} failed, retrying in ${Math.round(delay)}ms: ${lastError.message}`);
					if (!channelId.startsWith("SESSION-")) {
						await ctx.replaceMessage(`_Retrying (${attempt}/${MAX_RETRIES})..._`);
					}
					await sleep(delay);
				} finally {
					clearTimeout(llmTimeoutHandle);
				}
			}
			if (lastError) {
				throw lastError;
			}

			// Wait for queued messages
			await queueChain;

			// Handle error case - update main message and post error to thread
			if (runState.stopReason === "error" && runState.errorMessage) {
				try {
					await ctx.replaceMessage("_Sorry, something went wrong_");
					await ctx.respondInThread(`_Error: ${runState.errorMessage}_`);
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					log.logWarning("Failed to post error message", errMsg);
				}
			} else {
				// Final message update
				const messages = session.messages;
				const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
				const finalText =
					lastAssistant?.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n") || "";

				// Check for [SILENT] marker - delete message and thread instead of posting
				if (finalText.trim() === "[SILENT]" || finalText.trim().startsWith("[SILENT]")) {
					try {
						await ctx.deleteMessage();
						log.logInfo("Silent response - deleted message and thread");
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning("Failed to delete message for silent response", errMsg);
					}
				} else if (finalText.trim()) {
					try {
						// Pass full text — replaceMessage() handles splitting into chunks
						await ctx.replaceMessage(finalText);
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning("Failed to replace message with final text", errMsg);
					}
				}
			}

			// Log usage summary with context info
			const contextWindow = model.contextWindow || 200000;
			const messages = session.messages;
			const lastAssistantMessage = messages
				.slice()
				.reverse()
				.find((m) => m.role === "assistant" && (m as any).stopReason !== "aborted") as any;
			const contextTokens = lastAssistantMessage
				? (lastAssistantMessage.usage.input ?? 0) +
					(lastAssistantMessage.usage.output ?? 0) +
					(lastAssistantMessage.usage.cacheRead ?? 0) +
					(lastAssistantMessage.usage.cacheWrite ?? 0)
				: 0;

			if (runState.totalUsage.cost.total > 0) {
				const summary = log.logUsageSummary(runState.logCtx!, runState.totalUsage, contextTokens, contextWindow);
				runState.queue.enqueue(() => ctx.respondInThread(summary), "usage summary");
				await queueChain;
			}

			// Auto-compact if context is >= 70% full and run completed normally
			if (
				contextTokens > 0 &&
				contextTokens / contextWindow >= 0.7 &&
				runState.stopReason !== "aborted" &&
				runState.stopReason !== "error"
			) {
				const pct = Math.round((contextTokens / contextWindow) * 100);
				log.logInfo(`[${channelId}] Auto-compacting: ${contextTokens}/${contextWindow} tokens (${pct}%)`);
				const compactResult = await doCompact();
				if (compactResult) {
					await ctx.respondInThread(
						`_Context auto-compacted (${pct}% full — ${compactResult.tokensBefore.toLocaleString()} tokens summarised)_`
					);
				}
			}

			// Clear run state
			runState.ctx = null;
			runState.logCtx = null;
			runState.queue = null;

			return { stopReason: runState.stopReason, errorMessage: runState.errorMessage };
		},

		abort(): void {
			session.abort();
		},

		async compact(): Promise<{ tokensBefore: number } | null> {
			return doCompact();
		},

		reset(): void {
			agent.reset();
			// Release VM if this is a pool-mode session (next exec will boot a fresh one)
			void releaseExecutor(executor);
			// Truncate the context file so future loads start fresh
			try {
				writeFileSync(contextFile, "");
				log.logInfo(`[${channelId}] Context reset — cleared ${contextFile}`);
			} catch (err) {
				log.logWarning(`[${channelId}] Failed to clear context file`, err instanceof Error ? err.message : String(err));
			}
		},
	};
}

/**
 * Translate container path back to host path for file operations
 */
function translateToHostPath(
	containerPath: string,
	channelDir: string,
	workspacePath: string,
	channelId: string,
	workingDir: string,
): string {
	if (workspacePath === "/workspace") {
		const prefix = `/workspace/${channelId}/`;
		if (containerPath.startsWith(prefix)) {
			return join(channelDir, containerPath.slice(prefix.length));
		}
		if (containerPath.startsWith("/workspace/")) {
			return join(workingDir, containerPath.slice("/workspace/".length));
		}
	}
	return containerPath;
}
