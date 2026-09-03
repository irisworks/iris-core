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
	/** Inner agent's tool array — Iris's own tools minus `task` (structurally, not via a runtime guard). */
	tools: AgentTool<any>[];
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

/**
 * Run one isolated, fresh-context task to completion and return the inner
 * agent's final assistant text. This is the whole isolation guarantee the
 * task primitive depends on: the inner Agent gets its OWN event subscription
 * here, wired only to local logs (log.logToolStart/Success/Error) — it never
 * touches ctx.respond, ctx.onToolEvent, queue.enqueueMessage, or
 * runState.trace.recordTool, all of which belong to the outer channel
 * session. Only the string this function returns crosses back into the
 * caller's context, as the `task` tool's own result (or, for scheduled
 * tasks, as the text posted into the channel).
 */
export async function runIsolatedTask(options: TaskRunnerOptions, prompt: string, label: string): Promise<string> {
	const taskId = `task-${randomUUID()}`;
	const systemPrompt = options.buildSystemPrompt();

	const innerAgent = new Agent({
		initialState: {
			systemPrompt,
			model: options.model,
			thinkingLevel: "off",
			tools: options.tools,
		},
		convertToLlm: options.convertToLlm,
		getApiKey: options.getApiKey,
		sessionId: taskId,
		streamFn: options.streamFn,
	});

	// Local-logs-only subscription — deliberately separate from the outer
	// session's session.subscribe() in agent.ts. See module doc comment.
	const logCtx = { channelId: taskId };
	const pendingTools = new Map<string, { toolName: string; args: unknown; startTime: number }>();
	innerAgent.subscribe((event: AgentEvent) => {
		if (event.type === "tool_execution_start") {
			const args = event.args as { label?: string };
			const toolLabel = args?.label || event.toolName;
			pendingTools.set(event.toolCallId, { toolName: event.toolName, args: event.args, startTime: Date.now() });
			log.logToolStart(logCtx, event.toolName, toolLabel, event.args as Record<string, unknown>);
		} else if (event.type === "tool_execution_end") {
			const pending = pendingTools.get(event.toolCallId);
			pendingTools.delete(event.toolCallId);
			const durationMs = pending ? Date.now() - pending.startTime : 0;
			const resultStr = extractToolResultText(event.result);
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

	try {
		await Promise.race([innerAgent.prompt(prompt), timeout]);
	} catch (err) {
		throw new Error(`task failed: ${err instanceof Error ? err.message : String(err)}`);
	} finally {
		clearTimeout(timeoutHandle);
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
			`task failed: ${lastAssistant.errorMessage ?? `inner run stopped with reason "${lastAssistant.stopReason}"`}`,
		);
	}

	const finalText = lastAssistant
		? lastAssistant.content
				.filter((part) => part.type === "text" && part.text)
				.map((part) => part.text as string)
				.join("\n")
		: "";

	log.logInfo(`[${taskId}] Task complete: ${label}`);
	return finalText.trim() || "(task completed with no output)";
}

export function createTaskTool(options: TaskRunnerOptions): AgentTool<typeof taskSchema> {
	return {
		name: "task",
		label: "task",
		description:
			"Run an isolated, fresh-context sub-agent to completion and return only its final summary. " +
			"Use this for noisy multi-step investigation (log digging, terraform plan, diagnostics) that " +
			"would otherwise permanently bloat this channel's context — every intermediate tool call and " +
			"reasoning turn inside the task is discarded; only the final text comes back.",
		parameters: taskSchema,
		execute: async (_toolCallId: string, { label, prompt }: { label: string; prompt: string }) => {
			const text = await runIsolatedTask(options, prompt, label);
			return { content: [{ type: "text", text }], details: undefined };
		},
	};
}
