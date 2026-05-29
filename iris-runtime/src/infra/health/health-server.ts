/**
 * Health and readiness HTTP server.
 *
 * Kubernetes (and any decent load balancer) checks these endpoints:
 *   GET /health   — liveness probe: is the process alive?
 *   GET /ready    — readiness probe: can it serve traffic?
 *   GET /metrics  — Prometheus scrape endpoint
 *
 * Zero dependencies — built-in http module only.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { registry } from "../observability/metrics.js";
import { logger } from "../observability/logger.js";

const log = logger.child({ component: "health" });

// ============================================================================
// Types
// ============================================================================

export type HealthStatus = "ok" | "degraded" | "down";

export interface HealthCheck {
	name: string;
	check(): Promise<HealthCheckResult>;
}

export interface HealthCheckResult {
	status: HealthStatus;
	latencyMs?: number;
	message?: string;
}

export interface HealthReport {
	status: HealthStatus;
	uptime: number;
	version: string;
	checks: Record<string, HealthCheckResult>;
	ts: string;
}

// ============================================================================
// Built-in checks
// ============================================================================

export function redisCheck(getClient: () => { ping?: () => Promise<string> } | null): HealthCheck {
	return {
		name: "redis",
		async check(): Promise<HealthCheckResult> {
			const client = getClient();
			if (!client?.ping) return { status: "down", message: "client not initialised" };
			const start = Date.now();
			try {
				await client.ping();
				return { status: "ok", latencyMs: Date.now() - start };
			} catch (err) {
				return { status: "down", latencyMs: Date.now() - start, message: String(err) };
			}
		},
	};
}

export function postgresCheck(pool: { query: (sql: string) => Promise<unknown> } | null): HealthCheck {
	return {
		name: "postgres",
		async check(): Promise<HealthCheckResult> {
			if (!pool) return { status: "down", message: "pool not initialised" };
			const start = Date.now();
			try {
				await pool.query("SELECT 1");
				return { status: "ok", latencyMs: Date.now() - start };
			} catch (err) {
				return { status: "down", latencyMs: Date.now() - start, message: String(err) };
			}
		},
	};
}

export function slackCheck(getBot: () => { webClient?: { auth: { test: () => Promise<unknown> } } } | null): HealthCheck {
	return {
		name: "slack",
		async check(): Promise<HealthCheckResult> {
			const bot = getBot();
			if (!bot?.webClient) return { status: "down", message: "bot not initialised" };
			const start = Date.now();
			try {
				await bot.webClient.auth.test();
				return { status: "ok", latencyMs: Date.now() - start };
			} catch (err) {
				return { status: "degraded", latencyMs: Date.now() - start, message: String(err) };
			}
		},
	};
}

// ============================================================================
// Server
// ============================================================================

const START_TIME = Date.now();
const VERSION = process.env.npm_package_version ?? process.env.APP_VERSION ?? "unknown";

export class HealthServer {
	private checks: HealthCheck[] = [];
	private ready = false;

	register(check: HealthCheck): this {
		this.checks.push(check);
		return this;
	}

	markReady(): void {
		this.ready = true;
		log.info("health server: marked ready");
	}

	markNotReady(): void {
		this.ready = false;
	}

	start(port: number): void {
		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			void this.route(req, res);
		});

		server.listen(port, "0.0.0.0", () => {
			log.info(`health server listening on :${port}`);
		});

		server.on("error", (err) => {
			log.error("health server error", err);
		});
	}

	private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = req.url ?? "/";

		if (url === "/health" || url === "/healthz") {
			await this.handleLiveness(res);
		} else if (url === "/ready" || url === "/readyz") {
			await this.handleReadiness(res);
		} else if (url === "/metrics") {
			this.handleMetrics(res);
		} else {
			res.writeHead(404);
			res.end(`{"error":"not found"}`);
		}
	}

	/**
	 * Liveness — process is alive (not deadlocked/OOM).
	 * Kubernetes will restart the pod if this fails.
	 * Intentionally cheap: no external calls.
	 */
	private async handleLiveness(res: ServerResponse): Promise<void> {
		const report: HealthReport = {
			status: "ok",
			uptime: Math.floor((Date.now() - START_TIME) / 1000),
			version: VERSION,
			checks: { process: { status: "ok" } },
			ts: new Date().toISOString(),
		};
		json(res, 200, report);
	}

	/**
	 * Readiness — all dependencies are reachable.
	 * Kubernetes will stop routing traffic if this fails.
	 * Calls registered checks in parallel with a 5s timeout.
	 */
	private async handleReadiness(res: ServerResponse): Promise<void> {
		if (!this.ready) {
			json(res, 503, { status: "starting", ts: new Date().toISOString() });
			return;
		}

		const results = await Promise.all(
			this.checks.map(async (c) => {
				try {
					const result = await Promise.race([
						c.check(),
						timeout(5000, `${c.name} timed out`),
					]);
					return [c.name, result] as const;
				} catch (err) {
					return [c.name, { status: "down" as const, message: String(err) }] as const;
				}
			}),
		);

		const checks = Object.fromEntries(results);
		const overallStatus = results.some(([, r]) => r.status === "down")
			? "down"
			: results.some(([, r]) => r.status === "degraded")
				? "degraded"
				: "ok";

		const report: HealthReport = {
			status: overallStatus,
			uptime: Math.floor((Date.now() - START_TIME) / 1000),
			version: VERSION,
			checks,
			ts: new Date().toISOString(),
		};

		json(res, overallStatus === "down" ? 503 : 200, report);
	}

	/** Prometheus scrape — text/plain exposition format. */
	private handleMetrics(res: ServerResponse): void {
		const body = registry.render();
		res.writeHead(200, {
			"Content-Type": "text/plain; version=0.0.4; charset=utf-8",
			"Content-Length": Buffer.byteLength(body),
		});
		res.end(body);
	}
}

// ============================================================================
// Helpers
// ============================================================================

function json(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload),
	});
	res.end(payload);
}

function timeout(ms: number, message: string): Promise<never> {
	return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}
