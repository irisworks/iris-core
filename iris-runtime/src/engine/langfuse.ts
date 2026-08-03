/**
 * Langfuse tracing — session-correlated traces for Pupil enrichment (#133).
 *
 * Every agent run emits one Langfuse trace stamped with `sessionId`, so Pupil
 * (IRIS-97) can read a run's cost/tokens/tool calls back out of
 * `GET /api/public/sessions/:sessionId` without any other correlation key.
 *
 * Design constraints:
 * - Dependency-free: talks to the public ingestion API over `fetch`, no SDK.
 * - Opt-in: unconfigured (missing keys) means every entry point is a no-op.
 * - Never fails a run: all public methods swallow their own errors. Tracing is
 *   observability, not business logic — a broken Langfuse must not surface to
 *   the user or abort a turn.
 */

import { randomUUID } from "crypto";
import * as log from "./log.js";

const DEFAULT_BASE_URL = "https://cloud.langfuse.com";
const DEFAULT_TIMEOUT_MS = 5000;

export interface LangfuseConfig {
	baseUrl: string;
	publicKey: string;
	secretKey: string;
	/** Langfuse environment bucket (e.g. "production", "staging"). */
	environment?: string;
	/** Release/version tag attached to traces. */
	release?: string;
	timeoutMs: number;
	/**
	 * Whether prompt/reply/tool payloads are sent. `false` keeps names, timings,
	 * tokens, and cost but omits every input/output field — for installs that
	 * want turn telemetry without shipping conversation content, command lines,
	 * or resolved secrets to the Langfuse host.
	 */
	captureIo: boolean;
}

/** Token/cost numbers as pi-ai reports them on an assistant message. */
export interface RunUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface TraceStart {
	/** The id Pupil correlates on — an Iris session UUID for SESSION- channels. */
	sessionId: string;
	channelId: string;
	name?: string;
	userId?: string;
	input?: unknown;
	model?: string;
	provider?: string;
	transportId?: string;
	tags?: string[];
	metadata?: Record<string, unknown>;
}

export interface GenerationRecord {
	name?: string;
	model?: string;
	startTime: Date;
	endTime: Date;
	input?: unknown;
	output?: unknown;
	usage?: RunUsage;
	errorMessage?: string;
}

export interface ToolRecord {
	name: string;
	startTime: Date;
	endTime: Date;
	input?: unknown;
	output?: unknown;
	isError?: boolean;
}

export interface TraceEnd {
	output?: unknown;
	stopReason?: string;
	errorMessage?: string;
	usage?: RunUsage;
	metadata?: Record<string, unknown>;
}

type FetchImpl = typeof fetch;

interface IngestionEvent {
	id: string;
	type: string;
	timestamp: string;
	body: Record<string, unknown>;
}

/**
 * Strip the `SESSION-` channel prefix so the Langfuse `sessionId` is the bare
 * Iris session UUID — the same value `POST /sessions` handed the caller.
 * Non-session channels trace under their channel id, which keeps every run
 * addressable by session even when there is no session record.
 */
export function langfuseSessionId(channelId: string): string {
	return channelId.startsWith("SESSION-") ? channelId.slice("SESSION-".length) : channelId;
}

function normalizeBaseUrl(raw: string): string {
	return raw.replace(/\/+$/, "");
}

export function langfuseConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LangfuseConfig | undefined {
	if (env.LANGFUSE_ENABLED === "false" || env.LANGFUSE_ENABLED === "0") return undefined;
	const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim();
	const secretKey = env.LANGFUSE_SECRET_KEY?.trim();
	if (!publicKey || !secretKey) return undefined;
	// LANGFUSE_HOST is the SDK-standard name; LANGFUSE_BASE_URL is accepted as an
	// alias because Pupil's own config reads either.
	const baseUrl = normalizeBaseUrl(env.LANGFUSE_HOST?.trim() || env.LANGFUSE_BASE_URL?.trim() || DEFAULT_BASE_URL);
	const timeout = Number(env.LANGFUSE_TIMEOUT_MS);
	return {
		baseUrl,
		publicKey,
		secretKey,
		environment: env.LANGFUSE_ENVIRONMENT?.trim() || undefined,
		release: env.LANGFUSE_RELEASE?.trim() || undefined,
		timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
		captureIo: env.LANGFUSE_CAPTURE_IO !== "false" && env.LANGFUSE_CAPTURE_IO !== "0",
	};
}

/** Cap payload strings — a 200k-char tool result has no business in a trace. */
const MAX_FIELD_CHARS = 20000;

function clip(value: unknown): unknown {
	if (typeof value === "string") {
		return value.length > MAX_FIELD_CHARS ? `${value.slice(0, MAX_FIELD_CHARS)}… (truncated)` : value;
	}
	return value;
}

/**
 * One in-flight run trace. Records are buffered and shipped by `flush()`; the
 * trace body itself is re-sent on flush (Langfuse upserts by id) so the final
 * output/stop reason land on the same trace the observations point at.
 */
export class LangfuseTrace {
	readonly traceId = randomUUID();
	readonly sessionId: string;
	private readonly startedAt = new Date();
	private readonly events: IngestionEvent[] = [];
	private ended?: TraceEnd;

	constructor(
		private readonly client: LangfuseClient,
		private readonly start: TraceStart,
	) {
		this.sessionId = start.sessionId;
	}

	/** Langfuse UI deep link for this trace (id-only route, resolves the project). */
	get url(): string {
		return `${this.client.config.baseUrl}/trace/${this.traceId}`;
	}

	recordGeneration(record: GenerationRecord): void {
		try {
			const usageDetails: Record<string, number> | undefined = record.usage
				? {
						input: record.usage.input,
						output: record.usage.output,
						cache_read_input_tokens: record.usage.cacheRead,
						cache_creation_input_tokens: record.usage.cacheWrite,
						total: record.usage.input + record.usage.output + record.usage.cacheRead + record.usage.cacheWrite,
					}
				: undefined;
			const costDetails: Record<string, number> | undefined = record.usage
				? {
						input: record.usage.cost.input + record.usage.cost.cacheRead + record.usage.cost.cacheWrite,
						output: record.usage.cost.output,
						total: record.usage.cost.total,
					}
				: undefined;
			this.push("generation-create", {
				id: randomUUID(),
				traceId: this.traceId,
				name: record.name ?? "llm-call",
				model: record.model ?? this.start.model,
				startTime: record.startTime.toISOString(),
				endTime: record.endTime.toISOString(),
				input: this.io(record.input),
				output: this.io(record.output),
				usageDetails,
				costDetails,
				level: record.errorMessage ? "ERROR" : "DEFAULT",
				statusMessage: record.errorMessage,
				environment: this.client.config.environment,
			});
		} catch {
			// Tracing must never break a run.
		}
	}

	recordTool(record: ToolRecord): void {
		try {
			this.push("observation-create", {
				id: randomUUID(),
				traceId: this.traceId,
				type: "TOOL",
				name: record.name,
				startTime: record.startTime.toISOString(),
				endTime: record.endTime.toISOString(),
				input: this.io(record.input),
				output: this.io(record.output),
				level: record.isError ? "ERROR" : "DEFAULT",
				environment: this.client.config.environment,
			});
		} catch {
			// Tracing must never break a run.
		}
	}

	end(end: TraceEnd = {}): void {
		this.ended = end;
	}

	/** Ship everything buffered so far. Resolves even when Langfuse is down. */
	async flush(): Promise<void> {
		try {
			const batch = [this.traceEvent(), ...this.events];
			this.events.length = 0;
			await this.client.send(batch);
		} catch {
			// send() already logs; nothing here may throw.
		}
	}

	private traceEvent(): IngestionEvent {
		const usage = this.ended?.usage;
		return {
			id: randomUUID(),
			type: "trace-create",
			timestamp: new Date().toISOString(),
			body: {
				id: this.traceId,
				name: this.start.name ?? "iris-run",
				sessionId: this.sessionId,
				userId: this.start.userId,
				timestamp: this.startedAt.toISOString(),
				input: this.io(this.start.input),
				output: this.io(this.ended?.output),
				release: this.client.config.release,
				environment: this.client.config.environment,
				tags: [
					"iris",
					...(this.start.transportId ? [`transport:${this.start.transportId}`] : []),
					...(this.start.tags ?? []),
				],
				metadata: {
					source: "iris-runtime",
					channelId: this.start.channelId,
					sessionId: this.sessionId,
					provider: this.start.provider,
					model: this.start.model,
					transportId: this.start.transportId,
					stopReason: this.ended?.stopReason,
					errorMessage: this.ended?.errorMessage,
					...(usage
						? {
								totalCostUsd: usage.cost.total,
								inputTokens: usage.input,
								outputTokens: usage.output,
								cacheReadTokens: usage.cacheRead,
								cacheWriteTokens: usage.cacheWrite,
							}
						: {}),
					...this.start.metadata,
					...this.ended?.metadata,
				},
			},
		};
	}

	/**
	 * Every payload field is attached through here, so `LANGFUSE_CAPTURE_IO=false`
	 * drops prompts, replies, and tool arguments/results at a single choke point.
	 */
	private io(value: unknown): unknown {
		return this.client.config.captureIo ? clip(value) : undefined;
	}

	private push(type: string, body: Record<string, unknown>): void {
		this.events.push({ id: randomUUID(), type, timestamp: new Date().toISOString(), body });
	}
}

/** Thin ingestion-API client. Failures are logged once per streak, never thrown. */
export class LangfuseClient {
	private failureStreak = 0;

	constructor(
		readonly config: LangfuseConfig,
		private readonly fetchImpl: FetchImpl = fetch,
	) {}

	startTrace(start: TraceStart): LangfuseTrace {
		return new LangfuseTrace(this, start);
	}

	async send(batch: IngestionEvent[]): Promise<void> {
		if (batch.length === 0) return;
		const auth = Buffer.from(`${this.config.publicKey}:${this.config.secretKey}`).toString("base64");
		try {
			const res = await this.fetchImpl(`${this.config.baseUrl}/api/public/ingestion`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Basic ${auth}`,
				},
				body: JSON.stringify({ batch }),
				signal: AbortSignal.timeout(this.config.timeoutMs),
			});
			if (!res.ok) {
				this.noteFailure(`HTTP ${res.status}`);
				return;
			}
			this.failureStreak = 0;
		} catch (err) {
			this.noteFailure(err instanceof Error ? err.message : String(err));
		}
	}

	/** Warn on the first failure of a streak only — a dead Langfuse shouldn't spam logs. */
	private noteFailure(reason: string): void {
		this.failureStreak++;
		if (this.failureStreak === 1) {
			log.logWarning("Langfuse ingestion failed (tracing only, run unaffected)", reason);
		}
	}
}

let cached: LangfuseClient | null | undefined;

/**
 * Process-wide client built from env on first use. Returns undefined when
 * Langfuse isn't configured, which makes every call site a cheap no-op.
 */
export function getLangfuseClient(): LangfuseClient | undefined {
	if (cached === undefined) {
		const config = langfuseConfigFromEnv();
		cached = config ? new LangfuseClient(config) : null;
		if (config) {
			log.logInfo(`Langfuse tracing enabled → ${config.baseUrl}${config.captureIo ? "" : " (payload capture off)"}`);
		}
	}
	return cached ?? undefined;
}

/** Test seam: force a client (or clear the cache with `undefined`). */
export function setLangfuseClient(client: LangfuseClient | null | undefined): void {
	cached = client === undefined ? undefined : client;
}
