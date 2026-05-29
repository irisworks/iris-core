/**
 * Structured JSON logger.
 *
 * Writes newline-delimited JSON to stdout so any log aggregator
 * (Datadog, CloudWatch, Loki, etc.) can consume it without parsing.
 *
 * Zero dependencies — no pino, no winston.
 * Each write is a single process.stdout.write() call (atomic on Linux).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
	level: LogLevel;
	ts: string;       // ISO 8601
	msg: string;
	[key: string]: unknown;
}

export interface LogContext {
	channelId?: string;
	sessionId?: string;
	requestId?: string;
	workerId?: string;
	[key: string]: unknown;
}

// ============================================================================
// Level filtering
// ============================================================================

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function parseLevel(raw: string | undefined): LogLevel {
	if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
	return "info";
}

const MIN_LEVEL = parseLevel(process.env.LOG_LEVEL);

// ============================================================================
// Core write
// ============================================================================

function write(level: LogLevel, msg: string, extra: Record<string, unknown>): void {
	if (LEVELS[level] < LEVELS[MIN_LEVEL]) return;

	const record: LogRecord = {
		level,
		ts: new Date().toISOString(),
		msg,
		...extra,
	};

	// Serialise errors so they appear as structured objects
	for (const [k, v] of Object.entries(record)) {
		if (v instanceof Error) {
			record[k] = {
				name: v.name,
				message: v.message,
				stack: v.stack,
			};
		}
	}

	// Single write call — atomic, no interleaving on Linux
	process.stdout.write(JSON.stringify(record) + "\n");
}

// ============================================================================
// Logger interface + factory
// ============================================================================

export interface Logger {
	debug(msg: string, ctx?: LogContext | Record<string, unknown>): void;
	info(msg: string, ctx?: LogContext | Record<string, unknown>): void;
	warn(msg: string, ctx?: LogContext | Record<string, unknown>): void;
	error(msg: string, errOrCtx?: unknown, ctx?: LogContext | Record<string, unknown>): void;
	/** Return a child logger with inherited context merged on every call. */
	child(ctx: LogContext): Logger;
}

class JsonLogger implements Logger {
	constructor(private readonly ctx: Record<string, unknown> = {}) {}

	debug(msg: string, extra?: Record<string, unknown>): void {
		write("debug", msg, { ...this.ctx, ...extra });
	}

	info(msg: string, extra?: Record<string, unknown>): void {
		write("info", msg, { ...this.ctx, ...extra });
	}

	warn(msg: string, extra?: Record<string, unknown>): void {
		write("warn", msg, { ...this.ctx, ...extra });
	}

	error(msg: string, errOrCtx?: unknown, extra?: Record<string, unknown>): void {
		const errField: Record<string, unknown> =
			errOrCtx instanceof Error
				? { err: errOrCtx }
				: errOrCtx && typeof errOrCtx === "object"
					? (errOrCtx as Record<string, unknown>)
					: {};
		write("error", msg, { ...this.ctx, ...errField, ...extra });
	}

	child(ctx: LogContext): Logger {
		return new JsonLogger({ ...this.ctx, ...ctx });
	}
}

// ============================================================================
// Exports
// ============================================================================

/** Root logger — use as-is or call .child({ channelId }) for scoped loggers. */
export const logger: Logger = new JsonLogger({
	service: process.env.SERVICE_NAME ?? "iris-runtime",
	env: process.env.NODE_ENV ?? "production",
});

/** Create a request-scoped child logger with a generated request ID. */
export function requestLogger(overrides?: LogContext): Logger {
	return logger.child({
		requestId: crypto.randomUUID(),
		...overrides,
	});
}
