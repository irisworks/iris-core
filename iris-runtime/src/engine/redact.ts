// ============================================================================
// Output redaction backstop (Tier 3 of the secrets design, docs/secrets.md).
//
// Every plaintext value the secrets provider resolves during this process's
// lifetime is registered here; sandbox output is masked before it reaches the
// LLM context or transcripts, so an agent that fetched a Tier-2 secret with
// get-secret and then echoes it doesn't leak it into chat. Best-effort by
// nature: transformed values (base64, split across lines) pass through.
// ============================================================================

const knownValues = new Set<string>();

// Values shorter than this are more likely to shred ordinary output than to
// be real credentials, so they're not tracked.
const MIN_VALUE_LENGTH = 8;

export const REDACTED_PLACEHOLDER = "[REDACTED-SECRET]";

export function registerSecretValue(value: string): void {
	if (value.length >= MIN_VALUE_LENGTH) knownValues.add(value);
}

export function redactKnownSecrets(text: string): string {
	let result = text;
	for (const value of knownValues) {
		if (result.includes(value)) result = result.split(value).join(REDACTED_PLACEHOLDER);
	}
	return result;
}
