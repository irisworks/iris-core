/**
 * Image detection by magic bytes, not filename.
 *
 * agent.ts and the read tool both used to decide "is this an image" from the
 * file extension. That breaks whenever the name lies: a Telegram document
 * with no filename downloads as a bare "file", and any transport can hand
 * over a mislabeled or extensionless attachment. Sniffing the actual bytes
 * (same approach pi-coding-agent's own read tool uses upstream, via the
 * `file-type` package) is strictly more reliable and costs one small read.
 */
import { fileTypeFromBuffer, fileTypeFromFile } from "file-type";

/** MIME types pi-ai's ImageContent (and every provider module that consumes it) accepts. */
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Bytes needed for file-type's magic-byte sniffing; matches its own recommended sniff window. */
export const MIME_SNIFF_BYTES = 4100;

/**
 * Detect a supported image MIME type from a buffer's magic bytes.
 * Returns undefined for non-images and for image formats no provider accepts
 * (e.g. bmp, tiff, svg) — callers should treat those as non-image attachments.
 */
export async function detectImageMimeType(buffer: Buffer): Promise<string | undefined> {
	const fileType = await fileTypeFromBuffer(buffer);
	if (!fileType || !SUPPORTED_IMAGE_MIME_TYPES.has(fileType.mime)) return undefined;
	return fileType.mime;
}

/**
 * Same detection as detectImageMimeType, but sniffs a file directly on the
 * host filesystem via file-type's own fromFile() — which handles the
 * open/read-header/close lifecycle internally. Only valid when `path` is
 * reachable from the host (unlike the executor-based sniffing read.ts needs
 * for sandboxed paths). Returns undefined on any read failure (e.g. ENOENT).
 */
export async function detectImageMimeTypeFromFile(path: string): Promise<string | undefined> {
	try {
		const fileType = await fileTypeFromFile(path);
		if (!fileType || !SUPPORTED_IMAGE_MIME_TYPES.has(fileType.mime)) return undefined;
		return fileType.mime;
	} catch {
		return undefined;
	}
}
