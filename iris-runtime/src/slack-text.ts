// Canonical Slack text limits and splitting utilities.
// Single source of truth — import from here, never redefine locally.

// Slack's hard per-message character limit.
export const SLACK_MAX_CHARS = 40_000;

// Recommended split point for multi-chunk responses (chat.update safe limit).
export const SLACK_SPLIT_CHARS = 4_000;

/**
 * Truncate text to fit within Slack's per-message limit.
 * Appends "[message truncated]" when cutting.
 */
export function truncateForSlack(text: string): string {
	if (text.length <= SLACK_MAX_CHARS) return text;
	const suffix = "\n\n[message truncated]";
	return text.slice(0, SLACK_MAX_CHARS - suffix.length) + suffix;
}

/**
 * Split text into chunks at natural newline boundaries near maxChars.
 * Chunk 1 replaces the thinking message; chunks 2+ are thread replies.
 */
export function splitIntoChunks(text: string, maxChars = SLACK_SPLIT_CHARS): string[] {
	if (text.length <= maxChars) return [text];
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (remaining.length <= maxChars) {
			chunks.push(remaining);
			break;
		}
		const searchFrom = Math.floor(maxChars * 0.8);
		const newlineIdx = remaining.lastIndexOf("\n", maxChars);
		const cut = newlineIdx >= searchFrom ? newlineIdx + 1 : maxChars;
		chunks.push(remaining.slice(0, cut).trimEnd());
		remaining = remaining.slice(cut).trimStart();
	}
	return chunks;
}
