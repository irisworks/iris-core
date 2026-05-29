/**
 * Generic session registry.
 *
 * Sessions are keyed by UUID and link Slack threads (and optionally email) to
 * a persistent agent context directory (SESSION-<uuid>/).
 *
 * sessions.json lives at workingDir/data/sessions.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

// ============================================================================
// Types
// ============================================================================

export interface Session {
	sessionId: string; // UUID
	createdAt: string; // ISO timestamp

	integrations: {
		slack: {
			originChannel: string; // channel where session was created
			originThreadTs: string; // thread_ts of the originating message
			workingChannel?: string; // optional separate channel for work threads
			workingThreadTs?: string; // thread_ts of the working thread
		};
		email: {
			clientEmail?: string; // inbound email routing key
		};
	};

	metadata: Record<string, unknown>; // workspace-defined (trips, tickets, etc.)
}

// ============================================================================
// Storage
// ============================================================================

function getSessionsPath(workingDir: string): string {
	return join(workingDir, "data", "sessions.json");
}

// ============================================================================
// In-memory cache with O(1) indices.
//
// threadIndex: "channel:threadTs" → sessionId  — used by findByThread (hot path)
// emailIndex:  email              → sessionId  — used by findByEmail
//
// Both indices are kept in sync with the sessions Map on every mutation.
// Mutations write through to the cache immediately and flush to disk
// asynchronously (coalesced over 500 ms) to avoid blocking the event loop.
// ============================================================================

interface SessionCache {
	sessions: Map<string, Session>;
	// "channel:threadTs" → sessionId — covers both originThread and workingThread
	threadIndex: Map<string, string>;
	// clientEmail → sessionId
	emailIndex: Map<string, string>;
	flushTimer: ReturnType<typeof setTimeout> | null;
}

const caches = new Map<string, SessionCache>();

function threadKey(channel: string, threadTs: string): string {
	return `${channel}:${threadTs}`;
}

function addToIndices(cache: SessionCache, session: Session): void {
	const s = session.integrations.slack;
	cache.threadIndex.set(threadKey(s.originChannel, s.originThreadTs), session.sessionId);
	if (s.workingChannel && s.workingThreadTs) {
		cache.threadIndex.set(threadKey(s.workingChannel, s.workingThreadTs), session.sessionId);
	}
	if (session.integrations.email.clientEmail) {
		cache.emailIndex.set(session.integrations.email.clientEmail, session.sessionId);
	}
}

function removeFromIndices(cache: SessionCache, session: Session): void {
	const s = session.integrations.slack;
	cache.threadIndex.delete(threadKey(s.originChannel, s.originThreadTs));
	if (s.workingChannel && s.workingThreadTs) {
		cache.threadIndex.delete(threadKey(s.workingChannel, s.workingThreadTs));
	}
	if (session.integrations.email.clientEmail) {
		cache.emailIndex.delete(session.integrations.email.clientEmail);
	}
}

function buildIndices(sessions: Map<string, Session>): Pick<SessionCache, "threadIndex" | "emailIndex"> {
	const threadIndex = new Map<string, string>();
	const emailIndex = new Map<string, string>();
	for (const session of sessions.values()) {
		const s = session.integrations.slack;
		threadIndex.set(threadKey(s.originChannel, s.originThreadTs), session.sessionId);
		if (s.workingChannel && s.workingThreadTs) {
			threadIndex.set(threadKey(s.workingChannel, s.workingThreadTs), session.sessionId);
		}
		if (session.integrations.email.clientEmail) {
			emailIndex.set(session.integrations.email.clientEmail, session.sessionId);
		}
	}
	return { threadIndex, emailIndex };
}

function getCache(workingDir: string): SessionCache {
	let cache = caches.get(workingDir);
	if (!cache) {
		const path = getSessionsPath(workingDir);
		let sessions: Map<string, Session>;
		if (existsSync(path)) {
			try {
				const raw = JSON.parse(readFileSync(path, "utf-8")) as Session[];
				sessions = new Map(raw.map((s) => [s.sessionId, s]));
			} catch {
				sessions = new Map();
			}
		} else {
			sessions = new Map();
		}
		const { threadIndex, emailIndex } = buildIndices(sessions);
		cache = { sessions, threadIndex, emailIndex, flushTimer: null };
		caches.set(workingDir, cache);
	}
	return cache;
}

function scheduleFlush(workingDir: string, cache: SessionCache): void {
	if (cache.flushTimer !== null) return;
	const timer = setTimeout(() => {
		cache.flushTimer = null;
		const dataDir = join(workingDir, "data");
		if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
		writeFileSync(
			getSessionsPath(workingDir),
			JSON.stringify(Array.from(cache.sessions.values()), null, 2),
		);
	}, 500);
	timer.unref?.();
	cache.flushTimer = timer;
}

export function loadSessions(workingDir: string): Map<string, Session> {
	return getCache(workingDir).sessions;
}

// ============================================================================
// O(1) lookups via index
// ============================================================================

/**
 * Find a session by its originating or working Slack thread. O(1).
 * Previously O(n) — critical hot path called on every thread message.
 */
export function findByThread(
	workingDir: string,
	channel: string,
	threadTs: string,
): Session | undefined {
	const cache = getCache(workingDir);
	const sessionId = cache.threadIndex.get(threadKey(channel, threadTs));
	return sessionId ? cache.sessions.get(sessionId) : undefined;
}

/**
 * Find a session by inbound email address. O(1).
 */
export function findByEmail(workingDir: string, email: string): Session | undefined {
	const cache = getCache(workingDir);
	const sessionId = cache.emailIndex.get(email);
	return sessionId ? cache.sessions.get(sessionId) : undefined;
}

// ============================================================================
// CRUD — all mutations keep indices in sync
// ============================================================================

export function createSession(
	workingDir: string,
	fields: {
		originChannel: string;
		originThreadTs: string;
		workingChannel?: string;
		workingThreadTs?: string;
		clientEmail?: string;
		metadata?: Record<string, unknown>;
	},
): Session {
	const cache = getCache(workingDir);
	const session: Session = {
		sessionId: randomUUID(),
		createdAt: new Date().toISOString(),
		integrations: {
			slack: {
				originChannel: fields.originChannel,
				originThreadTs: fields.originThreadTs,
				...(fields.workingChannel !== undefined && { workingChannel: fields.workingChannel }),
				...(fields.workingThreadTs !== undefined && { workingThreadTs: fields.workingThreadTs }),
			},
			email: {
				...(fields.clientEmail !== undefined && { clientEmail: fields.clientEmail }),
			},
		},
		metadata: fields.metadata ?? {},
	};
	cache.sessions.set(session.sessionId, session);
	addToIndices(cache, session);
	scheduleFlush(workingDir, cache);
	return session;
}

export function updateSession(
	workingDir: string,
	sessionId: string,
	patch: Partial<Session>,
): Session {
	const cache = getCache(workingDir);
	const existing = cache.sessions.get(sessionId);
	if (!existing) throw new Error(`Session not found: ${sessionId}`);
	// Remove stale index entries before updating
	removeFromIndices(cache, existing);
	const updated: Session = {
		...existing,
		...(patch.metadata !== undefined && { metadata: { ...existing.metadata, ...patch.metadata } }),
		...(patch.integrations !== undefined && {
			integrations: {
				slack: { ...existing.integrations.slack, ...patch.integrations.slack },
				email: { ...existing.integrations.email, ...patch.integrations.email },
			},
		}),
		sessionId: existing.sessionId,
		createdAt: existing.createdAt,
	};
	cache.sessions.set(sessionId, updated);
	addToIndices(cache, updated);
	scheduleFlush(workingDir, cache);
	return updated;
}

// ============================================================================
// Pending request registry (for POST /sessions/:id/message bridge pattern)
// ============================================================================

interface PendingSessionRequest {
	resolve: (text: string) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

const pendingRequests = new Map<string, PendingSessionRequest>();

/**
 * Register a pending response for a session message injection.
 * Returns a promise that resolves with the agent's response text.
 */
export function registerSessionRequest(sessionId: string, timeoutMs = 120_000): Promise<string> {
	return new Promise((resolve, reject) => {
		// Cancel any existing pending request for this session
		const existing = pendingRequests.get(sessionId);
		if (existing) {
			clearTimeout(existing.timer);
			existing.reject(new Error("superseded by new request"));
		}
		const timer = setTimeout(() => {
			pendingRequests.delete(sessionId);
			reject(new Error(`Session ${sessionId} request timed out after ${timeoutMs / 1000}s`));
		}, timeoutMs);
		pendingRequests.set(sessionId, { resolve, reject, timer });
	});
}

/**
 * Resolve a pending session request with the agent's final response.
 * Returns true if a pending request was found and resolved.
 */
export function resolveSessionRequest(sessionId: string, text: string): boolean {
	const pending = pendingRequests.get(sessionId);
	if (!pending) return false;
	clearTimeout(pending.timer);
	pendingRequests.delete(sessionId);
	pending.resolve(text);
	return true;
}
