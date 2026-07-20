// ============================================================================
// Output redaction backstop (Tier 3 of the secrets design, docs/secrets.md).
//
// Every plaintext value the secrets provider resolves during this process's
// lifetime is registered here; sandbox output is masked before it reaches the
// LLM context or transcripts, so an agent that fetched a Tier-2 secret with
// get-secret and then echoes it doesn't leak it into chat. Best-effort by
// nature: transformed values (base64, split across lines) pass through.
// ============================================================================

// Map (not Set) so re-registering a value bumps it to most-recently-used —
// insertion order is deletion+re-add order, which Map iteration honors.
const knownValues = new Map<string, true>();

// Values shorter than this are more likely to shred ordinary output than to
// be real credentials, so they're not tracked.
const MIN_VALUE_LENGTH = 8;

// A long-running process can resolve many distinct/rotated secret values
// over its lifetime; without a cap this set (and the per-output redaction
// pass over it) would grow unbounded. LRU-evict past this size — a process
// juggling more than this many live credentials is not the common case, and
// the oldest entries are the ones least likely to still appear in output.
const MAX_TRACKED_VALUES = 256;

export const REDACTED_PLACEHOLDER = "[REDACTED-SECRET]";

export function registerSecretValue(value: string): void {
	if (value.length < MIN_VALUE_LENGTH) return;
	knownValues.delete(value);
	knownValues.set(value, true);
	if (knownValues.size > MAX_TRACKED_VALUES) {
		const oldest = knownValues.keys().next().value;
		if (oldest !== undefined) knownValues.delete(oldest);
	}
}

export function redactKnownSecrets(text: string): string {
	let result = text;
	for (const value of knownValues.keys()) {
		if (result.includes(value)) result = result.split(value).join(REDACTED_PLACEHOLDER);
	}
	return result;
}
