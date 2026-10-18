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
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

export interface SecretDrop {
	token: string;
	name: string;
	/** Channel to notify (name only, never the value) once the secret arrives. */
	channelId?: string;
	proxyOnlyDefault: boolean;
	expiresAt: number;
	/** Called once when the drop is consumed or expires (e.g. closes its tunnel). */
	teardown?: () => void;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;

const drops = new Map<string, SecretDrop>();

function sweep(): void {
	const now = Date.now();
	for (const [token, drop] of drops) {
		if (drop.expiresAt <= now) {
			drops.delete(token);
			drop.teardown?.();
		}
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
	// Expiry must fire teardown even if nothing calls into the registry again.
	setTimeout(sweep, ttl + 1000).unref();
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
	if (drop) {
		drops.delete(token);
		drop.teardown?.();
	}
	return drop;
}

/**
 * A transport that can collect the value in-app (e.g. a Slack modal) without
 * the web transport. Returns true when it took the drop.
 */
export type DropPrompter = (drop: SecretDrop) => Promise<boolean>;

const prompters: DropPrompter[] = [];

export function registerDropPrompter(prompter: DropPrompter): void {
	prompters.push(prompter);
}

export async function promptDrop(drop: SecretDrop): Promise<boolean> {
	for (const prompter of prompters) {
		if (await prompter(drop)) return true;
	}
	return false;
}

/**
 * Name-only notification back into the conversation that requested the drop —
 * the root events watcher (main.ts) routes it to the owning transport. The
 * value itself never appears in any event or log.
 */
export function notifyDropStored(workingDir: string, drop: SecretDrop, via: string): void {
	if (!drop.channelId) return;
	const eventsDir = join(workingDir, "events");
	mkdirSync(eventsDir, { recursive: true });
	const eventId = `drop-${Date.now()}-${randomBytes(4).toString("hex")}`;
	writeFileSync(
		join(eventsDir, `${eventId}.json`),
		JSON.stringify({
			type: "immediate",
			channelId: drop.channelId,
			user: "secret-drop",
			text: `Secret '${drop.name}' was submitted via ${via} and stored.`,
		}),
	);
}
