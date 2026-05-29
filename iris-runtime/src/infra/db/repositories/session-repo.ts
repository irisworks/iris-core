/**
 * Session repository.
 *
 * Single source of truth for session persistence.
 * Reads are served from Redis cache; writes go to PostgreSQL then invalidate.
 *
 * Interface mirrors the existing in-memory sessions.ts API so the rest
 * of the codebase can adopt it incrementally.
 */

import type { Pool } from "../pool.js";
import type { CacheClient } from "../../cache/cache-client.js";
import { CacheKey, TTL } from "../../cache/cache-client.js";
import { metrics } from "../../observability/metrics.js";
import { logger } from "../../observability/logger.js";

const log = logger.child({ component: "session-repo" });

// ============================================================================
// Types
// ============================================================================

export interface Session {
	id: string;                 // UUID
	createdAt: Date;
	updatedAt: Date;
	originChannel: string;
	originThread: string;
	workingChannel?: string;
	workingThread?: string;
	clientEmail?: string;
	metadata: Record<string, unknown>;
	status: "active" | "archived" | "deleted";
}

export interface CreateSessionInput {
	originChannel: string;
	originThread: string;
	workingChannel?: string;
	workingThread?: string;
	clientEmail?: string;
	metadata?: Record<string, unknown>;
}

export interface UpdateSessionInput {
	workingChannel?: string;
	workingThread?: string;
	clientEmail?: string;
	metadata?: Record<string, unknown>;
	status?: Session["status"];
}

// ============================================================================
// Repository
// ============================================================================

export class SessionRepository {
	constructor(
		private readonly db: Pool,
		private readonly cache: CacheClient,
	) {}

	// ── Create ────────────────────────────────────────────────────────────────

	async create(input: CreateSessionInput): Promise<Session> {
		const { rows } = await this.db.query<DbSession>(
			`INSERT INTO sessions
				(origin_channel, origin_thread, working_channel, working_thread, client_email, metadata)
			 VALUES ($1, $2, $3, $4, $5, $6)
			 ON CONFLICT (origin_channel, origin_thread) DO UPDATE
			   SET updated_at = NOW()
			 RETURNING *`,
			[
				input.originChannel,
				input.originThread,
				input.workingChannel ?? null,
				input.workingThread ?? null,
				input.clientEmail ?? null,
				JSON.stringify(input.metadata ?? {}),
			],
		);

		const session = fromDb(rows[0]);
		await this.cacheSession(session);
		metrics.sessionsCreated.inc({ origin: input.originChannel });
		log.info("session created", { sessionId: session.id });
		return session;
	}

	// ── Read ──────────────────────────────────────────────────────────────────

	async findById(id: string): Promise<Session | null> {
		const cached = await this.cache.get<Session>(CacheKey.session(id));
		if (cached) return cached;

		const { rows } = await this.db.query<DbSession>(
			"SELECT * FROM sessions WHERE id = $1 AND status != 'deleted'",
			[id],
		);
		if (rows.length === 0) return null;

		const session = fromDb(rows[0]);
		await this.cacheSession(session);
		return session;
	}

	async findByThread(channel: string, threadTs: string): Promise<Session | null> {
		// Check both origin and working thread
		const { rows } = await this.db.query<DbSession>(
			`SELECT * FROM sessions
			 WHERE status = 'active' AND (
				 (origin_channel = $1 AND origin_thread = $2) OR
				 (working_channel = $1 AND working_thread = $2)
			 )
			 LIMIT 1`,
			[channel, threadTs],
		);
		if (rows.length === 0) return null;

		const session = fromDb(rows[0]);
		await this.cacheSession(session);
		return session;
	}

	async findByEmail(email: string): Promise<Session | null> {
		const { rows } = await this.db.query<DbSession>(
			"SELECT * FROM sessions WHERE client_email = $1 AND status = 'active' LIMIT 1",
			[email],
		);
		if (rows.length === 0) return null;
		return fromDb(rows[0]);
	}

	async list(options: {
		limit?: number;
		offset?: number;
		status?: Session["status"];
	} = {}): Promise<{ sessions: Session[]; total: number }> {
		const { limit = 50, offset = 0, status = "active" } = options;

		const [{ rows: sessions }, { rows: count }] = await Promise.all([
			this.db.query<DbSession>(
				"SELECT * FROM sessions WHERE status = $1 ORDER BY updated_at DESC LIMIT $2 OFFSET $3",
				[status, limit, offset],
			),
			this.db.query<{ count: string }>(
				"SELECT COUNT(*) AS count FROM sessions WHERE status = $1",
				[status],
			),
		]);

		return {
			sessions: sessions.map(fromDb),
			total: parseInt(count[0].count, 10),
		};
	}

	// ── Update ────────────────────────────────────────────────────────────────

	async update(id: string, patch: UpdateSessionInput): Promise<Session> {
		const sets: string[] = [];
		const values: unknown[] = [];
		let idx = 1;

		if (patch.workingChannel !== undefined) { sets.push(`working_channel = $${idx++}`); values.push(patch.workingChannel); }
		if (patch.workingThread !== undefined)  { sets.push(`working_thread = $${idx++}`);  values.push(patch.workingThread); }
		if (patch.clientEmail !== undefined)    { sets.push(`client_email = $${idx++}`);    values.push(patch.clientEmail); }
		if (patch.status !== undefined)         { sets.push(`status = $${idx++}`);          values.push(patch.status); }
		if (patch.metadata !== undefined) {
			sets.push(`metadata = metadata || $${idx++}::jsonb`);
			values.push(JSON.stringify(patch.metadata));
		}

		if (sets.length === 0) return (await this.findById(id))!;

		values.push(id);
		const { rows } = await this.db.query<DbSession>(
			`UPDATE sessions SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
			values,
		);

		if (rows.length === 0) throw new Error(`Session not found: ${id}`);
		const session = fromDb(rows[0]);
		await this.cacheSession(session);
		return session;
	}

	async delete(id: string): Promise<void> {
		await this.db.query(
			"UPDATE sessions SET status = 'deleted', updated_at = NOW() WHERE id = $1",
			[id],
		);
		await this.cache.del(CacheKey.session(id));
	}

	// ── Stats ─────────────────────────────────────────────────────────────────

	async countActive(): Promise<number> {
		const { rows } = await this.db.query<{ count: string }>(
			"SELECT COUNT(*) AS count FROM sessions WHERE status = 'active'",
		);
		return parseInt(rows[0].count, 10);
	}

	// ── Cache management ──────────────────────────────────────────────────────

	private async cacheSession(session: Session): Promise<void> {
		await this.cache.set(CacheKey.session(session.id), session, TTL.session);
	}

	async warmCache(limit = 500): Promise<void> {
		const { rows } = await this.db.query<DbSession>(
			"SELECT * FROM sessions WHERE status = 'active' ORDER BY updated_at DESC LIMIT $1",
			[limit],
		);
		await Promise.all(rows.map((row) => this.cacheSession(fromDb(row))));
		log.info("session cache warmed", { count: rows.length });
	}
}

// ============================================================================
// DB row → domain model
// ============================================================================

interface DbSession {
	id: string;
	created_at: Date;
	updated_at: Date;
	origin_channel: string;
	origin_thread: string;
	working_channel: string | null;
	working_thread: string | null;
	client_email: string | null;
	metadata: string | Record<string, unknown>;
	status: "active" | "archived" | "deleted";
}

function fromDb(row: DbSession): Session {
	return {
		id: row.id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		originChannel: row.origin_channel,
		originThread: row.origin_thread,
		workingChannel: row.working_channel ?? undefined,
		workingThread: row.working_thread ?? undefined,
		clientEmail: row.client_email ?? undefined,
		metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
		status: row.status,
	};
}
