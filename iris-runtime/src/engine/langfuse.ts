/**
 * Langfuse tracing — session-correlated traces for Pupil enrichment (#133).
 *
 * Every agent run emits one Langfuse trace stamped with `sessionId`, so Pupil
 * (IRIS-97) can read a run's cost/tokens/tool calls back out of
 * `GET /api/public/sessions/:sessionId` without any other correlation key.
 *
 * Design constraints:
 * - Dependency-free: talks to the OTel ingestion API over `fetch`, no SDK.
 * - Opt-in: unconfigured (missing keys) means every entry point is a no-op.
 * - Never fails a run: all public methods swallow their own errors. Tracing is
 *   observability, not business logic — a broken Langfuse must not surface to
 *   the user or abort a turn.
 *
 * Transport: OTLP/HTTP JSON → POST /api/public/otel/v1/traces. This is the
 * path the official langfuse-js SDK uses and the only one that accepts the
 * full observation type set (TOOL, AGENT, etc.). The deprecated REST batch
 * endpoint (/api/public/ingestion) is intentionally avoided.
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

// -- OTLP/HTTP JSON wire types -----------------------------------------------

interface OtelAttrValue {
	stringValue?: string;
	intValue?: string;
	doubleValue?: number;
	boolValue?: boolean;
	arrayValue?: { values: OtelAttrValue[] };
}

interface OtelAttr {
	key: string;
	value: OtelAttrValue;
}

interface OtelSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind: number;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	attributes: OtelAttr[];
	status: Record<string, unknown>;
}

// -- OTLP helpers ------------------------------------------------------------

/** Strip UUID hyphens → 32 lowercase hex chars for OTel traceId (16 bytes). */
function traceIdHex(uuid: string): string {
	return uuid.replace(/-/g, "");
}

/** First 16 hex chars of a stripped UUID → OTel spanId (8 bytes). */
function spanIdHex(uuid: string): string {
	return uuid.replace(/-/g, "").slice(0, 16);
}

/** Date → nanoseconds-since-epoch string (avoids Number precision loss). */
function toNano(date: Date): string {
	return (BigInt(date.getTime()) * 1_000_000n).toString();
}

function strAttr(key: string, value: string): OtelAttr {
	return { key, value: { stringValue: value } };
}

function arrAttr(key: string, values: string[]): OtelAttr {
	return { key, value: { arrayValue: { values: values.map((v) => ({ stringValue: v })) } } };
}

/**
 * Serialize a value to JSON, then wrap as a string OTel attribute.
 * Langfuse expects input/output/usage_details/cost_details as JSON strings.
 * Returns undefined if the value is undefined (so callers can skip the attr).
 */
function jsonStrAttr(key: string, value: unknown): OtelAttr | undefined {
	if (value === undefined) return undefined;
	try {
		return strAttr(key, JSON.stringify(value));
	} catch {
		return strAttr(key, '"[unserializable]"');
	}
}

// -- Payload clipping --------------------------------------------------------

/** Cap payload size — a 200k-char tool result has no business in a trace. */
const MAX_FIELD_CHARS = 20000;

function clipString(value: string): string {
	return value.length > MAX_FIELD_CHARS ? `${value.slice(0, MAX_FIELD_CHARS)}… (truncated)` : value;
}

/**
 * Cap a payload field. Strings truncate directly; anything structured is sized
 * by its serialized form, because tool arguments arrive as objects and a single
 * oversized member (a `Write` call's `content`, say) would otherwise sail past
 * the cap. Oversized structures degrade to a truncated JSON string rather than
 * being dropped — a clipped view beats none. Unserializable values (circular
 * references) are replaced with a marker.
 */
function clip(value: unknown): unknown {
	if (typeof value === "string") return clipString(value);
	if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
	let serialized: string;
	try {
		serialized = JSON.stringify(value) ?? "";
	} catch {
		return "[unserializable]";
	}
	return serialized.length > MAX_FIELD_CHARS ? clipString(serialized) : value;
}

// ---------------------------------------------------------------------------

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

/**
 * One in-flight run trace. Observations are buffered as OTel child spans and
 * shipped by `flush()`; the root span (representing the trace) is rebuilt on
 * each flush so the final output/stop reason land correctly (Langfuse upserts
 * by traceId).
 */
export class LangfuseTrace {
	readonly traceId = randomUUID();
	readonly sessionId: string;
	private readonly _traceIdHex: string;
	private readonly rootSpanId: string;
	private readonly startedAt = new Date();
	private readonly childSpans: OtelSpan[] = [];
	private ended?: TraceEnd;

	constructor(
		private readonly client: LangfuseClient,
		private readonly start: TraceStart,
	) {
		this.sessionId = start.sessionId;
		this._traceIdHex = traceIdHex(this.traceId);
		this.rootSpanId = spanIdHex(randomUUID());
	}

	/** Langfuse UI deep link for this trace (id-only route, resolves the project). */
	get url(): string {
		return `${this.client.config.baseUrl}/trace/${this.traceId}`;
	}

	recordGeneration(record: GenerationRecord): void {
		try {
			const attrs: OtelAttr[] = [
				strAttr("langfuse.observation.type", "generation"),
				strAttr("langfuse.observation.level", record.errorMessage ? "ERROR" : "DEFAULT"),
			];
			const model = record.model ?? this.start.model;
			if (model) attrs.push(strAttr("langfuse.observation.model.name", model));

			const ioInput = jsonStrAttr("langfuse.observation.input", this.io(record.input));
			if (ioInput) attrs.push(ioInput);
			const ioOutput = jsonStrAttr("langfuse.observation.output", this.io(record.output));
			if (ioOutput) attrs.push(ioOutput);

			if (record.usage) {
				attrs.push(
					strAttr(
						"langfuse.observation.usage_details",
						JSON.stringify({
							input: record.usage.input,
							output: record.usage.output,
							cache_read_input_tokens: record.usage.cacheRead,
							cache_creation_input_tokens: record.usage.cacheWrite,
							total: record.usage.input + record.usage.output + record.usage.cacheRead + record.usage.cacheWrite,
						}),
					),
				);
				attrs.push(
					strAttr(
						"langfuse.observation.cost_details",
						JSON.stringify({
							input: record.usage.cost.input + record.usage.cost.cacheRead + record.usage.cost.cacheWrite,
							output: record.usage.cost.output,
							total: record.usage.cost.total,
						}),
					),
				);
			}
			if (record.errorMessage) attrs.push(strAttr("langfuse.observation.status_message", record.errorMessage));
			if (this.client.config.environment) attrs.push(strAttr("langfuse.environment", this.client.config.environment));

			this.pushChild(record.name ?? "llm-call", record.startTime, record.endTime, attrs);
		} catch {
			// Tracing must never break a run.
		}
	}

	recordTool(record: ToolRecord): void {
		try {
			const attrs: OtelAttr[] = [
				strAttr("langfuse.observation.type", "tool"),
				strAttr("langfuse.observation.level", record.isError ? "ERROR" : "DEFAULT"),
			];
			const ioInput = jsonStrAttr("langfuse.observation.input", this.io(record.input));
			if (ioInput) attrs.push(ioInput);
			const ioOutput = jsonStrAttr("langfuse.observation.output", this.io(record.output));
			if (ioOutput) attrs.push(ioOutput);
			if (this.client.config.environment) attrs.push(strAttr("langfuse.environment", this.client.config.environment));

			this.pushChild(record.name, record.startTime, record.endTime, attrs);
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
			const spans = [this.rootSpan(), ...this.childSpans];
			this.childSpans.length = 0;
			await this.client.send(spans);
		} catch {
			// send() already logs; nothing here may throw.
		}
	}

	private rootSpan(): OtelSpan {
		const usage = this.ended?.usage;
		const tags = [
			"iris",
			...(this.start.transportId ? [`transport:${this.start.transportId}`] : []),
			...(this.start.tags ?? []),
		];

		const attrs: OtelAttr[] = [
			strAttr("langfuse.session.id", this.sessionId),
			strAttr("langfuse.trace.name", this.start.name ?? "iris-run"),
			arrAttr("langfuse.trace.tags", tags),
			strAttr("langfuse.trace.metadata.source", "iris-runtime"),
			strAttr("langfuse.trace.metadata.channelId", this.start.channelId),
			strAttr("langfuse.trace.metadata.sessionId", this.sessionId),
		];

		if (this.start.userId) attrs.push(strAttr("langfuse.user.id", this.start.userId));
		if (this.client.config.environment) attrs.push(strAttr("langfuse.environment", this.client.config.environment));
		if (this.client.config.release) attrs.push(strAttr("langfuse.release", this.client.config.release));
		if (this.start.provider) attrs.push(strAttr("langfuse.trace.metadata.provider", this.start.provider));
		if (this.start.model) attrs.push(strAttr("langfuse.trace.metadata.model", this.start.model));
		if (this.start.transportId) attrs.push(strAttr("langfuse.trace.metadata.transportId", this.start.transportId));
		if (this.ended?.stopReason) attrs.push(strAttr("langfuse.trace.metadata.stopReason", this.ended.stopReason));
		if (this.ended?.errorMessage) attrs.push(strAttr("langfuse.trace.metadata.errorMessage", this.ended.errorMessage));

		if (usage) {
			attrs.push(strAttr("langfuse.trace.metadata.totalCostUsd", String(usage.cost.total)));
			attrs.push(strAttr("langfuse.trace.metadata.inputTokens", String(usage.input)));
			attrs.push(strAttr("langfuse.trace.metadata.outputTokens", String(usage.output)));
			attrs.push(strAttr("langfuse.trace.metadata.cacheReadTokens", String(usage.cacheRead)));
			attrs.push(strAttr("langfuse.trace.metadata.cacheWriteTokens", String(usage.cacheWrite)));
		}

		for (const [k, v] of Object.entries(this.start.metadata ?? {})) {
			if (v !== undefined && v !== null) attrs.push(strAttr(`langfuse.trace.metadata.${k}`, String(v)));
		}
		for (const [k, v] of Object.entries(this.ended?.metadata ?? {})) {
			if (v !== undefined && v !== null) attrs.push(strAttr(`langfuse.trace.metadata.${k}`, String(v)));
		}

		const ioInput = jsonStrAttr("langfuse.trace.input", this.io(this.start.input));
		if (ioInput) attrs.push(ioInput);
		const ioOutput = jsonStrAttr("langfuse.trace.output", this.io(this.ended?.output));
		if (ioOutput) attrs.push(ioOutput);

		return {
			traceId: this._traceIdHex,
			spanId: this.rootSpanId,
			name: this.start.name ?? "iris-run",
			kind: 1,
			startTimeUnixNano: toNano(this.startedAt),
			endTimeUnixNano: toNano(new Date()),
			attributes: attrs,
			status: {},
		};
	}

	/**
	 * Every payload field is attached through here, so `LANGFUSE_CAPTURE_IO=false`
	 * drops prompts, replies, and tool arguments/results at a single choke point.
	 */
	private io(value: unknown): unknown {
		return this.client.config.captureIo ? clip(value) : undefined;
	}

	private pushChild(name: string, startTime: Date, endTime: Date, attributes: OtelAttr[]): void {
		this.childSpans.push({
			traceId: this._traceIdHex,
			spanId: spanIdHex(randomUUID()),
			parentSpanId: this.rootSpanId,
			name,
			kind: 1,
			startTimeUnixNano: toNano(startTime),
			endTimeUnixNano: toNano(endTime),
			attributes,
			status: {},
		});
	}
}

/**
 * Per-request body budget. The ingestion endpoint caps request size server-side,
 * so a turn with many tool calls has to be split — otherwise the single request
 * carrying the whole trace is rejected and nothing at all is recorded.
 */
const MAX_BATCH_BYTES = 2_500_000;

/**
 * Split spans into sub-budget chunks. The root span leads the batch so it
 * always lands in the first chunk. A span larger than the budget on its own
 * still ships alone — the server may reject that one, but it no longer takes
 * the rest of the trace with it.
 */
function chunkSpans(spans: OtelSpan[]): OtelSpan[][] {
	const chunks: OtelSpan[][] = [];
	let current: OtelSpan[] = [];
	let bytes = 0;
	for (const span of spans) {
		let size: number;
		try {
			size = Buffer.byteLength(JSON.stringify(span));
		} catch {
			continue; // unserializable span — skipping it beats failing the batch
		}
		if (current.length > 0 && bytes + size > MAX_BATCH_BYTES) {
			chunks.push(current);
			current = [];
			bytes = 0;
		}
		current.push(span);
		bytes += size;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

/** Thin OTel ingestion client. Failures are logged once per streak, never thrown. */
export class LangfuseClient {
	private failureStreak = 0;

	constructor(
		readonly config: LangfuseConfig,
		private readonly fetchImpl: FetchImpl = fetch,
	) {}

	startTrace(start: TraceStart): LangfuseTrace {
		return new LangfuseTrace(this, start);
	}

	/**
	 * Ship a batch of spans, split across as many requests as the size cap needs.
	 */
	async send(spans: OtelSpan[]): Promise<void> {
		for (const chunk of chunkSpans(spans)) {
			await this.post(chunk);
		}
	}

	private async post(spans: OtelSpan[]): Promise<void> {
		if (spans.length === 0) return;
		const auth = Buffer.from(`${this.config.publicKey}:${this.config.secretKey}`).toString("base64");
		const resourceAttrs: OtelAttr[] = [strAttr("service.name", "iris-runtime")];
		if (this.config.environment) resourceAttrs.push(strAttr("langfuse.environment", this.config.environment));
		if (this.config.release) resourceAttrs.push(strAttr("langfuse.release", this.config.release));

		const body = {
			resourceSpans: [
				{
					resource: { attributes: resourceAttrs },
					scopeSpans: [{ scope: { name: "iris-runtime" }, spans }],
				},
			],
		};
		try {
			const res = await this.fetchImpl(`${this.config.baseUrl}/api/public/otel/v1/traces`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Basic ${auth}`,
				},
				body: JSON.stringify(body),
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
