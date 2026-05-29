/**
 * Slack user and channel registry.
 *
 * Owns the in-memory user/channel caches and all API pagination.
 * Previously embedded in SlackBot — extracted so the connection layer
 * does not conflate identity management with socket plumbing.
 */

import type { WebClient } from "@slack/web-api";
import * as log from "../../log.js";

export interface SlackUser {
	id: string;
	userName: string;
	displayName: string;
}

export interface SlackChannel {
	id: string;
	name: string;
}

export class SlackRegistry {
	private users = new Map<string, SlackUser>();
	private channels = new Map<string, SlackChannel>();

	constructor(private readonly webClient: WebClient) {}

	// ── Read API ──────────────────────────────────────────────────────────────

	getUser(userId: string): SlackUser | undefined {
		return this.users.get(userId);
	}

	getChannel(channelId: string): SlackChannel | undefined {
		return this.channels.get(channelId);
	}

	getAllUsers(): SlackUser[] {
		return Array.from(this.users.values());
	}

	getAllChannels(): SlackChannel[] {
		return Array.from(this.channels.values());
	}

	get userCount(): number { return this.users.size; }
	get channelCount(): number { return this.channels.size; }

	// ── Bootstrap ─────────────────────────────────────────────────────────────

	async fetchAll(): Promise<void> {
		await Promise.all([this.fetchUsers(), this.fetchChannels()]);
		log.logInfo(`Registry: ${this.channelCount} channels, ${this.userCount} users`);
	}

	private async fetchUsers(): Promise<void> {
		let cursor: string | undefined;
		do {
			const result = await this.webClient.users.list({ limit: 200, cursor });
			const members = result.members as
				| Array<{ id?: string; name?: string; real_name?: string; deleted?: boolean }>
				| undefined;
			if (members) {
				for (const u of members) {
					if (u.id && u.name && !u.deleted) {
						this.users.set(u.id, {
							id: u.id,
							userName: u.name,
							displayName: u.real_name || u.name,
						});
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);
	}

	private async fetchChannels(): Promise<void> {
		// Public + private channels
		let cursor: string | undefined;
		do {
			const result = await this.webClient.conversations.list({
				types: "public_channel,private_channel",
				exclude_archived: true,
				limit: 200,
				cursor,
			});
			const channels = result.channels as
				| Array<{ id?: string; name?: string; is_member?: boolean }>
				| undefined;
			if (channels) {
				for (const c of channels) {
					if (c.id && c.name && c.is_member) {
						this.channels.set(c.id, { id: c.id, name: c.name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);

		// DM channels
		cursor = undefined;
		do {
			const result = await this.webClient.conversations.list({
				types: "im",
				limit: 200,
				cursor,
			});
			const ims = result.channels as Array<{ id?: string; user?: string }> | undefined;
			if (ims) {
				for (const im of ims) {
					if (im.id) {
						const user = im.user ? this.users.get(im.user) : undefined;
						const name = user ? `DM:${user.userName}` : `DM:${im.id}`;
						this.channels.set(im.id, { id: im.id, name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);
	}
}
