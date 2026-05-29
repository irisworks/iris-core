/**
 * Prometheus-compatible metrics registry.
 *
 * Implements the text format spec (exposition format v0.0.4).
 * No external dependencies.
 *
 * Exposes via /metrics on the health server.
 */

// ============================================================================
// Types
// ============================================================================

type Labels = Record<string, string>;

interface MetricSample {
	labels: Labels;
	value: number;
}

// ============================================================================
// Counter
// ============================================================================

export class Counter {
	private samples = new Map<string, MetricSample>();

	constructor(
		private readonly name: string,
		private readonly help: string,
		private readonly labelNames: string[] = [],
	) {}

	inc(labels: Labels = {}, amount = 1): void {
		const key = labelKey(labels);
		const existing = this.samples.get(key);
		if (existing) {
			existing.value += amount;
		} else {
			this.samples.set(key, { labels, value: amount });
		}
	}

	render(): string {
		const lines = [
			`# HELP ${this.name} ${this.help}`,
			`# TYPE ${this.name} counter`,
		];
		for (const { labels, value } of this.samples.values()) {
			lines.push(`${this.name}${renderLabels(labels)} ${value}`);
		}
		return lines.join("\n");
	}
}

// ============================================================================
// Histogram (fixed buckets)
// ============================================================================

const DEFAULT_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

export class Histogram {
	private buckets: Map<string, { labels: Labels; counts: number[]; sum: number; total: number }> =
		new Map();

	constructor(
		private readonly name: string,
		private readonly help: string,
		private readonly labelNames: string[] = [],
		private readonly bucketBoundaries: number[] = DEFAULT_BUCKETS,
	) {}

	observe(labels: Labels = {}, valueSeconds: number): void {
		const key = labelKey(labels);
		let entry = this.buckets.get(key);
		if (!entry) {
			entry = { labels, counts: new Array(this.bucketBoundaries.length).fill(0), sum: 0, total: 0 };
			this.buckets.set(key, entry);
		}
		for (let i = 0; i < this.bucketBoundaries.length; i++) {
			if (valueSeconds <= this.bucketBoundaries[i]) entry.counts[i]++;
		}
		entry.sum += valueSeconds;
		entry.total++;
	}

	startTimer(labels: Labels = {}): () => void {
		const start = Date.now();
		return () => this.observe(labels, (Date.now() - start) / 1000);
	}

	render(): string {
		const lines = [
			`# HELP ${this.name} ${this.help}`,
			`# TYPE ${this.name} histogram`,
		];
		for (const { labels, counts, sum, total } of this.buckets.values()) {
			let cumulative = 0;
			for (let i = 0; i < this.bucketBoundaries.length; i++) {
				cumulative += counts[i];
				lines.push(
					`${this.name}_bucket${renderLabels({ ...labels, le: String(this.bucketBoundaries[i]) })} ${cumulative}`,
				);
			}
			lines.push(`${this.name}_bucket${renderLabels({ ...labels, le: "+Inf" })} ${total}`);
			lines.push(`${this.name}_sum${renderLabels(labels)} ${sum.toFixed(6)}`);
			lines.push(`${this.name}_count${renderLabels(labels)} ${total}`);
		}
		return lines.join("\n");
	}
}

// ============================================================================
// Gauge
// ============================================================================

export class Gauge {
	private samples = new Map<string, MetricSample>();

	constructor(
		private readonly name: string,
		private readonly help: string,
	) {}

	set(labels: Labels = {}, value: number): void {
		this.samples.set(labelKey(labels), { labels, value });
	}

	inc(labels: Labels = {}, amount = 1): void {
		const key = labelKey(labels);
		const s = this.samples.get(key);
		this.samples.set(key, { labels, value: (s?.value ?? 0) + amount });
	}

	dec(labels: Labels = {}, amount = 1): void { this.inc(labels, -amount); }

	render(): string {
		const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
		for (const { labels, value } of this.samples.values()) {
			lines.push(`${this.name}${renderLabels(labels)} ${value}`);
		}
		return lines.join("\n");
	}
}

// ============================================================================
// Registry
// ============================================================================

export class MetricsRegistry {
	private metrics: Array<{ render: () => string }> = [];

	register<T extends { render: () => string }>(metric: T): T {
		this.metrics.push(metric);
		return metric;
	}

	render(): string {
		return this.metrics.map((m) => m.render()).join("\n\n") + "\n";
	}
}

// ============================================================================
// Helpers
// ============================================================================

function labelKey(labels: Labels): string {
	return Object.entries(labels)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${k}="${v}"`)
		.join(",");
}

function renderLabels(labels: Labels): string {
	if (Object.keys(labels).length === 0) return "";
	return `{${labelKey(labels)}}`;
}

// ============================================================================
// Application metrics — single shared registry
// ============================================================================

export const registry = new MetricsRegistry();

export const metrics = {
	// Ingestion
	messagesReceived: registry.register(
		new Counter("iris_messages_received_total", "Total messages received", ["channel_mode", "source"]),
	),
	messagesQueued: registry.register(
		new Counter("iris_messages_queued_total", "Messages published to queue", ["channel_id"]),
	),
	messagesDropped: registry.register(
		new Counter("iris_messages_dropped_total", "Messages dropped (queue full, rate limit, etc.)", ["reason"]),
	),

	// Processing
	agentRunsTotal: registry.register(
		new Counter("iris_agent_runs_total", "Total agent runs", ["status", "model"]),
	),
	agentRunDuration: registry.register(
		new Histogram("iris_agent_run_duration_seconds", "Agent run duration in seconds", ["model"], [1, 5, 15, 30, 60, 120, 300]),
	),
	llmTokensTotal: registry.register(
		new Counter("iris_llm_tokens_total", "LLM tokens used", ["type", "model"]),
	),
	llmCostTotal: registry.register(
		new Counter("iris_llm_cost_usd_total", "LLM cost in USD (×10000)", ["model"]),
	),

	// Queue
	queueDepth: registry.register(
		new Gauge("iris_queue_depth", "Current message queue depth"),
	),
	queueProcessingLatency: registry.register(
		new Histogram("iris_queue_processing_latency_seconds", "Time message waited in queue", [], [0.1, 0.5, 1, 5, 15, 30, 60]),
	),

	// Sessions
	activeSessions: registry.register(
		new Gauge("iris_active_sessions_total", "Currently active sessions"),
	),
	sessionsCreated: registry.register(
		new Counter("iris_sessions_created_total", "Total sessions created", ["origin"]),
	),

	// Infrastructure
	dbQueryDuration: registry.register(
		new Histogram("iris_db_query_duration_seconds", "PostgreSQL query duration", ["operation"]),
	),
	cacheHits: registry.register(
		new Counter("iris_cache_hits_total", "Cache hits", ["key_prefix"]),
	),
	cacheMisses: registry.register(
		new Counter("iris_cache_misses_total", "Cache misses", ["key_prefix"]),
	),
	cacheErrors: registry.register(
		new Counter("iris_cache_errors_total", "Cache errors", ["operation"]),
	),
};
