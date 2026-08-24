// ============================================================================
// ChannelQueue — per-channel FIFO that runs enqueued work one at a time.
//
// Every transport (Slack, Telegram, Bridge) keeps one of these per channel so
// two events on the same channel never dispatch concurrently against one
// ChannelState. Callers enforce the shared 5-message-per-channel overflow
// convention via isFull() before enqueueing — see
// docs/channel-modes.md#queueing-and-overflow.
// ============================================================================

import * as log from "./log.js";

export type QueuedWork = () => Promise<void>;

/** Shared per-channel queue depth cap (docs/channel-modes.md#queueing-and-overflow). */
export const CHANNEL_QUEUE_LIMIT = 5;

export class ChannelQueue {
	private queue: QueuedWork[] = [];
	private processing = false;

	enqueue(work: QueuedWork): void {
		this.queue.push(work);
		this.processNext();
	}

	size(): number {
		return this.queue.length;
	}

	/** True when a new event would exceed CHANNEL_QUEUE_LIMIT and should be dropped/rejected. */
	isFull(): boolean {
		return this.queue.length >= CHANNEL_QUEUE_LIMIT;
	}

	private async processNext(): Promise<void> {
		if (this.processing || this.queue.length === 0) return;
		this.processing = true;
		const work = this.queue.shift()!;
		try {
			await work();
		} catch (err) {
			log.logWarning("Queue error", err instanceof Error ? err.message : String(err));
		}
		this.processing = false;
		this.processNext();
	}
}
