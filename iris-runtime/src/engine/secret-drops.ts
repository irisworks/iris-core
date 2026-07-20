// ============================================================================
// Secret drops — one-time, expiring capability links for out-of-band secret
// submission (IRIS_SECRETS_MODE store/proxy).
//
// Iris requests a drop via POST /secret-drops (api.ts) and relays the link;
// the user opens /secret-drop/<token> on the web transport and pastes the
// value there, so plaintext never transits chat, LLM context, or transcripts.
//
// The registry is in-memory and shared between api.ts and web.ts (same
// process). Drops die on runtime restart — acceptable: ask Iris for a new
// link. The 48-hex-char random token is the capability; single-use + TTL
// bound its exposure.
// ============================================================================

import { randomBytes } from "crypto";

export interface SecretDrop {
	token: string;
	name: string;
	/** Channel to notify (name only, never the value) once the secret arrives. */
	channelId?: string;
	proxyOnlyDefault: boolean;
	expiresAt: number;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;

const drops = new Map<string, SecretDrop>();

function sweep(): void {
	const now = Date.now();
	for (const [token, drop] of drops) {
		if (drop.expiresAt <= now) drops.delete(token);
	}
}

export function createDrop(options: {
	name: string;
	channelId?: string;
	ttlMs?: number;
	proxyOnlyDefault?: boolean;
}): SecretDrop {
	sweep();
	const ttl = Math.min(Math.max(options.ttlMs ?? DEFAULT_TTL_MS, 60_000), MAX_TTL_MS);
	const drop: SecretDrop = {
		token: randomBytes(24).toString("hex"),
		name: options.name,
		channelId: options.channelId,
		proxyOnlyDefault: options.proxyOnlyDefault ?? false,
		expiresAt: Date.now() + ttl,
	};
	drops.set(drop.token, drop);
	return drop;
}

/** Look at a drop without consuming it (the GET that renders the form). */
export function peekDrop(token: string): SecretDrop | undefined {
	sweep();
	return drops.get(token);
}

/** Single-use claim — the POST that stores the value. */
export function consumeDrop(token: string): SecretDrop | undefined {
	sweep();
	const drop = drops.get(token);
	if (drop) drops.delete(token);
	return drop;
}
