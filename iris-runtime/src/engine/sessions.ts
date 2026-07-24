/**
 * Generic session registry.
 *
 * Sessions are keyed by UUID and link Slack threads (and optionally email) to
 * a persistent agent context directory (SESSION-<uuid>/).
 *
 * sessions.json lives at workingDir/meta/sessions.json.
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
	return join(workingDir, "meta", "sessions.json");
}

export function loadSessions(workingDir: string): Map<string, Session> {
	const path = getSessionsPath(workingDir);
	if (!existsSync(path)) return new Map();
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Session[];
		return new Map(raw.map((s) => [s.sessionId, s]));
	} catch {
		return new Map();
	}
}

function saveSessions(workingDir: string, sessions: Map<string, Session>): void {
	const metaDir = join(workingDir, "meta");
	if (!existsSync(metaDir)) mkdirSync(metaDir, { recursive: true });
	writeFileSync(getSessionsPath(workingDir), JSON.stringify(Array.from(sessions.values()), null, 2));
}

// ============================================================================
// CRUD
// ============================================================================

export function findByThread(
	sessions: Map<string, Session>,
	channel: string,
	threadTs: string,
): Session | undefined {
	for (const session of sessions.values()) {
		const slack = session.integrations.slack;
		if (
			(slack.originChannel === channel && slack.originThreadTs === threadTs) ||
			(slack.workingChannel === channel && slack.workingThreadTs === threadTs)
		) {
			return session;
		}
	}
	return undefined;
}

export function findByEmail(sessions: Map<string, Session>, email: string): Session | undefined {
	for (const session of sessions.values()) {
		if (session.integrations.email.clientEmail === email) return session;
	}
	return undefined;
}

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
	const sessions = loadSessions(workingDir);
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
	sessions.set(session.sessionId, session);
	saveSessions(workingDir, sessions);
	return session;
}

export function updateSession(
	workingDir: string,
	sessionId: string,
	patch: Partial<Session>,
): Session {
	const sessions = loadSessions(workingDir);
	const existing = sessions.get(sessionId);
	if (!existing) throw new Error(`Session not found: ${sessionId}`);
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
	sessions.set(sessionId, updated);
	saveSessions(workingDir, sessions);
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
