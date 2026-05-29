/**
 * Stateless agent worker.
 *
 * Pull model: reads from Redis Streams, acquires a per-channel distributed
 * lock, processes one message through the LLM agent, posts the response,
 * then ACKs. Completely stateless between messages — safe to run N copies.
 *
 * Scaling strategy:
 *   • 1 worker  → single VM, current behaviour
 *   • N workers → each handles different channels concurrently
 *   • The Redis lock on channelId ensures serial ordering per channel
 *     across any number of worker instances
 */

import { randomUUID } from "crypto";
import type { CacheClient } from "../infra/cache/cache-client.js";
import { CacheKey, TTL } from "../infra/cache/cache-client.js";
import type { MessageQueue, QueueMessage } from "../infra/queue/message-queue.js";
import type { SessionRepository } from "../infra/db/repositories/session-repo.js";
import { logger } from "../infra/observability/logger.js";
import { metrics } from "../infra/observability/metrics.js";

const CONSUMER_GROUP = "iris-workers";
// Max time a channel lock is held (safety net — normal run releases it)
const CHANNEL_LOCK_TTL_MS = 300_000;
// Stale message reclaim interval (messages stuck in PEL > this are reclaimed)
const STALE_MESSAGE_THRESHOLD_MS = 60_000;

// ============================================================================
// Types
// ============================================================================

export interface WorkerDependencies {
	queue: MessageQueue;
	cache: CacheClient;
	sessions: SessionRepository;
	/** Callback to actually run the LLM agent. Injected so the worker
	 *  stays infrastructure-only and the LLM logic lives in agent.ts. */
	runAgent: RunAgentFn;
}

export type RunAgentFn = (job: AgentJob) => Promise<AgentResult>;

export interface AgentJob {
	workerId: string;
	channelId: string;
	sessionId?: string;
	userId: string;
	userName?: string;
	text: string;
	attachments: string[];
	source: QueueMessage["source"];
}

export interface AgentResult {
	text: string;
	stopReason: string;
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		costUsd: number;
		model: string;
	};
}

// ============================================================================
// AgentWorker
// ============================================================================

export class AgentWorker {
	private readonly workerId: string;
	private readonly log;
	private stopped = false;

	constructor(
		private readonly deps: WorkerDependencies,
		workerIdOverride?: string,
	) {
		this.workerId = workerIdOverride ?? `worker-${randomUUID().substring(0, 8)}`;
		this.log = logger.child({ component: "worker", workerId: this.workerId });
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	async start(): Promise<void> {
		this.log.info("worker starting");

		// Periodically reclaim stale messages from crashed workers
		const reclaimInterval = setInterval(
			() => void this.reclaimStalePending(),
			STALE_MESSAGE_THRESHOLD_MS,
		);
		reclaimInterval.unref();

		// Update queue depth gauge
		const depthInterval = setInterval(async () => {
			const depth = await this.deps.queue.depth(CONSUMER_GROUP);
			metrics.queueDepth.set({}, depth);
		}, 15_000);
		depthInterval.unref();

		await this.deps.queue.consume(
			CONSUMER_GROUP,
			this.workerId,
			(msg) => this.processMessage(msg),
			{
				batchSize: 5,
				blockMs: 2000,
				maxDeliveries: 3,
			},
		);
	}

	stop(): void {
		this.stopped = true;
		this.deps.queue.stop();
		this.log.info("worker stopped");
	}

	// ── Message processing ────────────────────────────────────────────────────

	private async processMessage(msg: QueueMessage): Promise<void> {
		if (this.stopped) return;

		const msgLog = this.log.child({
			channelId: msg.channelId,
			sessionId: msg.sessionId,
			messageId: msg.id,
		});

		// Measure queue wait latency
		const receivedMs = new Date(msg.receivedAt).getTime();
		metrics.queueProcessingLatency.observe({}, (Date.now() - receivedMs) / 1000);

		msgLog.info("processing message");

		// ── Acquire per-channel lock ─────────────────────────────────────────
		// Ensures only one worker processes a given channel at a time,
		// regardless of how many worker instances are running.
		let unlock: () => Promise<void>;
		try {
			unlock = await this.deps.cache.lock(
				CacheKey.workerLock(msg.channelId),
				CHANNEL_LOCK_TTL_MS,
				10_000, // timeout: wait up to 10s to acquire
			);
		} catch (err) {
			msgLog.warn("could not acquire channel lock — will retry", { err });
			throw err; // leave in PEL for retry
		}

		const runTimer = metrics.agentRunDuration.startTimer();

		try {
			// ── Session context ──────────────────────────────────────────────
			const session = msg.sessionId
				? await this.deps.sessions.findById(msg.sessionId)
				: null;

			// ── Run the agent ────────────────────────────────────────────────
			const result = await this.deps.runAgent({
				workerId: this.workerId,
				channelId: msg.channelId,
				sessionId: msg.sessionId,
				userId: msg.userId,
				userName: msg.userName,
				text: msg.text,
				attachments: msg.attachments,
				source: msg.source,
			});

			runTimer({ model: result.usage.model });
			metrics.agentRunsTotal.inc({ status: result.stopReason, model: result.usage.model });

			// ── Record usage ─────────────────────────────────────────────────
			metrics.llmTokensTotal.inc({ type: "input",       model: result.usage.model }, result.usage.inputTokens);
			metrics.llmTokensTotal.inc({ type: "output",      model: result.usage.model }, result.usage.outputTokens);
			metrics.llmTokensTotal.inc({ type: "cache_read",  model: result.usage.model }, result.usage.cacheReadTokens);
			metrics.llmTokensTotal.inc({ type: "cache_write", model: result.usage.model }, result.usage.cacheWriteTokens);
			metrics.llmCostTotal.inc({ model: result.usage.model }, Math.round(result.usage.costUsd * 10_000));

			msgLog.info("message processed", {
				stopReason: result.stopReason,
				model: result.usage.model,
				costUsd: result.usage.costUsd,
			});
		} catch (err) {
			runTimer({});
			msgLog.error("agent run failed", err);
			throw err; // re-throw so the queue leaves the message in PEL
		} finally {
			await unlock().catch((e: unknown) =>
				msgLog.warn("failed to release channel lock", { err: e }),
			);
		}
	}

	// ── Stale pending message recovery ────────────────────────────────────────

	private async reclaimStalePending(): Promise<void> {
		if (this.stopped) return;
		try {
			const reclaimed = await this.deps.queue.claimStale(
				CONSUMER_GROUP,
				this.workerId,
				STALE_MESSAGE_THRESHOLD_MS,
			);
			if (reclaimed > 0) {
				this.log.info("reclaimed stale messages", { count: reclaimed });
			}
		} catch (err) {
			this.log.warn("stale reclaim failed", { err });
		}
	}
}

// ============================================================================
// Factory
// ============================================================================

export function createWorker(deps: WorkerDependencies, workerCount = 1): AgentWorker[] {
	return Array.from(
		{ length: workerCount },
		(_, i) => new AgentWorker(deps, `worker-${i + 1}`),
	);
}
