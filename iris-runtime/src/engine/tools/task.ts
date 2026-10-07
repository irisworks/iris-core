import { randomUUID } from "node:crypto";
import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Message, Model } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import * as log from "../log.js";

const taskSchema = Type.Object({
	label: Type.String({ description: "Brief description of this task (shown to user)" }),
	prompt: Type.String({ description: "The instructions for the isolated sub-agent to carry out" }),
});

/**
 * Everything the `task` tool needs to spin up its own fresh-context inner
 * `Agent`, borrowed from the caller's own already-constructed runner rather
 * than re-resolved here: same model, same API key resolution, same
 * convertToLlm, same tool array (minus `task` itself — no recursion).
 */
export interface TaskRunnerOptions {
	model: Model<any>;
	getApiKey: (provider: string) => Promise<string | undefined> | string | undefined;
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	/** Inner agent's tool array — Iris's own tools minus `task` (structurally, not via a runtime
	 * guard). Called fresh on every task invocation (not read once at construction) so a task
	 * sees whatever MCP tools are currently connected, the same as a normal turn's per-turn
	 * `agent.state.tools = [...tools, ...mcpManager.getTools()]` merge in agent.ts's run(). */
	getTools: () => AgentTool<any>[];
	/** Constitution + skills index, no MEMORY.md, no channel/user lists. Recomputed
	 * per call (cheap file reads) so a task always sees current skills/constitution. */
	buildSystemPrompt: () => string;
	/** Hard ceiling on the inner run, ms. Defaults to IRIS_TASK_MAX_MS (300000). */
	maxMs?: number;
	/** Mandatory as of pi-agent-core 0.84 (Agent no longer defaults this itself).
	 * Production callers (agent.ts) pass the same ModelRuntime-backed streamFn
	 * their own outer Agent uses; unit tests pass a scripted/fake one to drive
	 * the inner agent deterministically without a real model/network call. */
	streamFn: StreamFn;
}

export function isTasksEnabled(): boolean {
	return process.env.IRIS_TASKS_ENABLED === "true";
}

export function getTaskMaxMs(): number {
	const raw = Number(process.env.IRIS_TASK_MAX_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 300000;
}

export function getTaskMaxConcurrent(): number {
	const raw = Number(process.env.IRIS_TASK_MAX_CONCURRENT);
	return Number.isFinite(raw) && raw > 0 ? raw : 3;
}

/** Process-wide in-flight count — every `task` call and every `--as-task`
 * scheduled event goes through runIsolatedTask, so gating here (rather than
 * per-channel) caps total concurrent LLM spend regardless of which channel
 * triggered it. Nothing previously stopped a single turn from firing off
 * several investigative tasks at once (pi-agent-core can execute a turn's
 * tool calls in parallel) — each one a full second Agent with its own LLM
 * calls and its own up-to-5-minute ceiling, with no circuit breaker. */
let activeTaskCount = 0;

/** Same shape as agent.ts's private extractToolResultText — kept as a small,
 * separately-owned copy here so tools/task.ts never has to import from
 * agent.ts (agent.ts imports tools/index.ts, which imports this file). */
function extractToolResultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (result && typeof result === "object" && "content" in result && Array.isArray((result as { content: unknown }).content)) {
		const content = (result as { content: Array<{ type: string; text?: string }> }).content;
		const textParts = content.filter((part) => part.type === "text" && part.text).map((part) => part.text as string);
		if (textParts.length > 0) return textParts.join("\n");
	}
	return JSON.stringify(result);
}

/** Inner tool calls left out of a task's visible trail: they don't change
 * state (`read`, `read_full`) or already post into the channel (`attach`).
 * Everything else — bash/edit/write and any MCP tool — is recorded (#261). */
const UNRECORDED_TOOLS = new Set(["read", "read_full", "attach"]);

function describeToolCall(toolName: string, args: unknown): string {
	const a = (args ?? {}) as { command?: unknown; path?: unknown; label?: unknown };
	const detail =
		toolName === "bash" && typeof a.command === "string"
			? a.command
			: typeof a.path === "string"
				? a.path
				: typeof a.label === "string"
					? a.label
					: "";
	const oneLine = detail.replace(/\s+/g, " ").replace(/`/g, "'").trim();
	const shown = oneLine.length > 150 ? `${oneLine.slice(0, 147)}...` : oneLine;
	return shown ? `${toolName} \`${shown}\`` : toolName;
}

const TRAIL_HEADER = "_↳ task ran:_";
const MAX_TRAIL_LINES = 30;

/** Visible record of a task's mutating tool calls, one line each — or "" if none ran. */
export function formatTaskTrail(ran: string[]): string {
	if (ran.length === 0) return "";
	const lines = ran.slice(0, MAX_TRAIL_LINES).map((line) => `• ${line}`);
	if (ran.length > MAX_TRAIL_LINES) lines.push(`• …and ${ran.length - MAX_TRAIL_LINES} more (see logs)`);
	return `${TRAIL_HEADER}\n${lines.join("\n")}`;
}

/** Split a failed task's error message (see withTrail) back into the error
 * itself and its trail, so callers can truncate/italicize the error without
 * cutting off or mangling the record of what ran. */
export function splitTaskTrail(message: string): { error: string; trail: string } {
	const at = message.indexOf(`\n${TRAIL_HEADER}\n`);
	return at === -1 ? { error: message, trail: "" } : { error: message.slice(0, at), trail: message.slice(at + 1) };
}

export interface TaskResult {
	text: string;
	/** One line per non-read-only inner tool call, in start order; failed calls prefixed "✗ ". */
	ran: string[];
}

/**
 * Run one isolated, fresh-context task to completion and return the inner
 * agent's final assistant text, plus the trail of mutating tool calls it made
 * so callers can post a visible record of them (#261). This is the whole
 * isolation guarantee the task primitive depends on: the inner Agent gets its OWN event subscription
 * here, wired only to local logs (log.logToolStart/Success/Error) — it never
 * touches ctx.respond, ctx.onToolEvent, queue.enqueueMessage, or
 * runState.trace.recordTool, all of which belong to the outer channel
 * session. Only the string this function returns crosses back into the
 * caller's context, as the `task` tool's own result (or, for scheduled
 * tasks, as the text posted into the channel).
 */
export async function runIsolatedTask(
	options: TaskRunnerOptions,
	prompt: string,
	label: string,
	signal?: AbortSignal,
): Promise<TaskResult> {
	const maxConcurrent = getTaskMaxConcurrent();
	if (activeTaskCount >= maxConcurrent) {
		throw new Error(
			`task failed: ${activeTaskCount} tasks are already running (max ${maxConcurrent}) — wait for one to finish before starting another`,
		);
	}
	activeTaskCount++;
	try {
		return await runIsolatedTaskInner(options, prompt, label, signal);
	} finally {
		activeTaskCount--;
	}
}

async function runIsolatedTaskInner(
	options: TaskRunnerOptions,
	prompt: string,
	label: string,
	signal?: AbortSignal,
): Promise<TaskResult> {
	const taskId = `task-${randomUUID()}`;
	const systemPrompt = options.buildSystemPrompt();

	const innerAgent = new Agent({
		initialState: {
			systemPrompt,
			model: options.model,
			thinkingLevel: "off",
			tools: options.getTools(),
		},
		convertToLlm: options.convertToLlm,
		getApiKey: options.getApiKey,
		sessionId: taskId,
		streamFn: options.streamFn,
	});

	// Local-logs-only subscription — deliberately separate from the outer
	// session's session.subscribe() in agent.ts. See module doc comment.
	const logCtx = { channelId: taskId };
	const pendingTools = new Map<string, { toolName: string; args: unknown; startTime: number; ranIndex?: number }>();
	const ran: string[] = [];
	innerAgent.subscribe((event: AgentEvent) => {
		if (event.type === "tool_execution_start") {
			const args = event.args as { label?: string };
			const toolLabel = args?.label || event.toolName;
			const ranIndex = UNRECORDED_TOOLS.has(event.toolName)
				? undefined
				: ran.push(describeToolCall(event.toolName, event.args)) - 1;
			pendingTools.set(event.toolCallId, { toolName: event.toolName, args: event.args, startTime: Date.now(), ranIndex });
			log.logToolStart(logCtx, event.toolName, toolLabel, event.args as Record<string, unknown>);
		} else if (event.type === "tool_execution_end") {
			const pending = pendingTools.get(event.toolCallId);
			pendingTools.delete(event.toolCallId);
			const durationMs = pending ? Date.now() - pending.startTime : 0;
			const resultStr = extractToolResultText(event.result);
			if (event.isError && pending?.ranIndex !== undefined) {
				ran[pending.ranIndex] = `✗ ${ran[pending.ranIndex]}`;
			}
			if (event.isError) {
				log.logToolError(logCtx, event.toolName, durationMs, resultStr);
			} else {
				log.logToolSuccess(logCtx, event.toolName, durationMs, resultStr);
			}
		}
	});

	const maxMs = options.maxMs ?? getTaskMaxMs();
	log.logInfo(`[${taskId}] Starting task: ${label}`);

	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timeoutHandle = setTimeout(() => {
			innerAgent.abort();
			reject(new Error(`exceeded ${maxMs}ms limit`));
		}, maxMs);
	});

	// Forward the outer run's abort (e.g. a user's stop command) to the inner
	// agent — without this, stopping the outer channel only ever raced the
	// IRIS_TASK_MAX_MS timer, leaving the task running (and billing) for up to
	// 5 more minutes regardless of the stop.
	const onAbort = () => innerAgent.abort();
	if (signal?.aborted) {
		innerAgent.abort();
	} else {
		signal?.addEventListener("abort", onAbort);
	}

	try {
		await Promise.race([innerAgent.prompt(prompt), timeout]);
	} catch (err) {
		throw new Error(withTrail(`task failed: ${err instanceof Error ? err.message : String(err)}`, ran));
	} finally {
		clearTimeout(timeoutHandle);
		signal?.removeEventListener("abort", onAbort);
	}

	const lastAssistant = innerAgent.state.messages.filter((m) => m.role === "assistant").pop() as
		| { content: Array<{ type: string; text?: string }>; stopReason?: string; errorMessage?: string }
		| undefined;

	// pi-agent-core's Agent.prompt() swallows a thrown/aborted run internally
	// (handleRunFailure) rather than rejecting — it appends an empty-content
	// assistant message with stopReason "error"/"aborted" and resolves
	// normally. Surface that as a thrown error here so it flows through the
	// same "task failed: ..." path as the timeout case above and, from there,
	// through the existing isError tool-result path (task.ts's own
	// AgentTool.execute just lets this propagate; bash.ts's nonzero-exit
	// throw is the precedent).
	if (lastAssistant?.stopReason === "error" || lastAssistant?.stopReason === "aborted") {
		throw new Error(
			withTrail(
				`task failed: ${lastAssistant.errorMessage ?? `inner run stopped with reason "${lastAssistant.stopReason}"`}`,
				ran,
			),
		);
	}

	const finalText = lastAssistant
		? lastAssistant.content
				.filter((part) => part.type === "text" && part.text)
				.map((part) => part.text as string)
				.join("\n")
		: "";

	log.logInfo(`[${taskId}] Task complete: ${label}`);
	return { text: finalText.trim() || "(task completed with no output)", ran };
}

/** A failed task's error message still carries what it ran before failing. */
function withTrail(message: string, ran: string[]): string {
	const trail = formatTaskTrail(ran);
	return trail ? `${message}\n${trail}` : message;
}

export function createTaskTool(options: TaskRunnerOptions): AgentTool<typeof taskSchema> {
	return {
		name: "task",
		label: "task",
		description:
			"Run an isolated, fresh-context sub-agent to completion and return only its final summary. " +
			"Use this for noisy multi-step investigation (log digging, terraform plan, diagnostics) that " +
			"would otherwise permanently bloat this channel's context — every intermediate tool call and " +
			"reasoning turn inside the task is discarded; only the final text comes back, plus a one-line " +
			"record of each state-changing tool call (bash/edit/write/MCP) it made, which is also posted to the channel.",
		parameters: taskSchema,
		execute: async (
			_toolCallId: string,
			{ label, prompt }: { label: string; prompt: string },
			signal?: AbortSignal,
		) => {
			const { text, ran } = await runIsolatedTask(options, prompt, label, signal);
			// The trail rides along in the result so the calling agent knows what
			// ran; agent.ts posts details.ran into the channel as a visible record.
			const trail = formatTaskTrail(ran);
			return { content: [{ type: "text", text: trail ? `${text}\n\n${trail}` : text }], details: { ran } };
		},
	};
}
