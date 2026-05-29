/**
 * PostgreSQL connection pool.
 *
 * Thin wrapper around `pg` (npm install pg @types/pg) that:
 *  - Configures pool sizing based on env
 *  - Times every query for Prometheus
 *  - Surfaces errors to the logger
 *  - Provides a typed helper for transactions
 */

import { metrics } from "../observability/metrics.js";
import { logger } from "../observability/logger.js";

const log = logger.child({ component: "db" });

// ── Types (import from pg in real code) ──────────────────────────────────────

export interface Pool {
	query<R = Record<string, unknown>>(
		sql: string,
		params?: unknown[],
	): Promise<{ rows: R[]; rowCount: number | null }>;
	transaction<T>(fn: (client: QueryClient) => Promise<T>): Promise<T>;
	end(): Promise<void>;
}

export interface QueryClient {
	query<R = Record<string, unknown>>(
		sql: string,
		params?: unknown[],
	): Promise<{ rows: R[]; rowCount: number | null }>;
}

// ============================================================================
// PgPool implementation
// ============================================================================

export class PgPool implements Pool {
	private pool: import("pg").Pool;

	constructor(databaseUrl: string) {
		// Dynamic import — pg is optional at module load time
		// Resolved at runtime: const { Pool } = await import("pg")
		// For the implementation here we assume it's already loaded.
		const PgPoolCtor = (globalThis as any).__pg_Pool;
		if (!PgPoolCtor) {
			throw new Error("pg not available — call initPg() before constructing PgPool");
		}

		this.pool = new PgPoolCtor({
			connectionString: databaseUrl,
			max: parseInt(process.env.PG_POOL_MAX ?? "10", 10),
			idleTimeoutMillis: 30_000,
			connectionTimeoutMillis: 5_000,
			ssl: process.env.PG_SSL === "true" ? { rejectUnauthorized: true } : undefined,
		});

		this.pool.on("error", (err: Error) => {
			log.error("pg pool error", err);
		});

		this.pool.on("connect", () => {
			log.debug("pg new connection");
		});
	}

	async query<R = Record<string, unknown>>(
		sql: string,
		params: unknown[] = [],
	): Promise<{ rows: R[]; rowCount: number | null }> {
		const operation = operationName(sql);
		const done = metrics.dbQueryDuration.startTimer({ operation });
		try {
			const result = await this.pool.query(sql, params);
			done();
			return { rows: result.rows as R[], rowCount: result.rowCount };
		} catch (err) {
			done();
			log.error(`db query failed (${operation})`, err, { sql: sql.substring(0, 120) });
			throw err;
		}
	}

	async transaction<T>(fn: (client: QueryClient) => Promise<T>): Promise<T> {
		const client = await this.pool.connect();
		const done = metrics.dbQueryDuration.startTimer({ operation: "transaction" });
		try {
			await client.query("BEGIN");
			const result = await fn({
				query: async (sql, params) => client.query(sql, params),
			});
			await client.query("COMMIT");
			done();
			return result;
		} catch (err) {
			await client.query("ROLLBACK").catch(() => {});
			done();
			throw err;
		} finally {
			client.release();
		}
	}

	async end(): Promise<void> {
		await this.pool.end();
		log.info("pg pool closed");
	}
}

// ============================================================================
// Factory
// ============================================================================

export async function createPool(databaseUrl: string): Promise<Pool> {
	const pg = await import("pg");
	(globalThis as any).__pg_Pool = pg.Pool ?? (pg as any).default?.Pool;
	return new PgPool(databaseUrl);
}

// ============================================================================
// Helpers
// ============================================================================

function operationName(sql: string): string {
	const trimmed = sql.trimStart().toUpperCase();
	for (const op of ["SELECT", "INSERT", "UPDATE", "DELETE", "WITH", "BEGIN", "COMMIT", "ROLLBACK"]) {
		if (trimmed.startsWith(op)) return op.toLowerCase();
	}
	return "query";
}
