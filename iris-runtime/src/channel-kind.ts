/**
 * Discriminated union for all channel ID namespaces used internally.
 *
 * Real Slack channels and DMs use opaque IDs from the Slack API.
 * Virtual channels are synthetic routing keys that never touch the Slack API.
 *
 * Use parseChannelKind(id) instead of ad-hoc startsWith() checks.
 */

export type ChannelKind =
	| { kind: "slack" }                         // real Slack channel or DM — normal API calls
	| { kind: "session"; sessionId: string }    // SESSION-<uuid>
	| { kind: "bridge"; requestId: string }     // BRIDGE-<id> — resolves a waiting bridge request
	| { kind: "telegram" }                      // TELEGRAM — routes to Telegram bot bridge
	| { kind: "virtual" }                       // WEBUI*, ESCALATE-*, SELFHEAL-* — no outbound calls

export function parseChannelKind(id: string): ChannelKind {
	if (id.startsWith("SESSION-")) return { kind: "session", sessionId: id.slice(8) };
	if (id.startsWith("BRIDGE-")) return { kind: "bridge", requestId: id.slice(7) };
	if (id === "TELEGRAM") return { kind: "telegram" };
	if (id.startsWith("WEBUI") || id.startsWith("ESCALATE-") || id.startsWith("SELFHEAL-")) return { kind: "virtual" };
	return { kind: "slack" };
}
