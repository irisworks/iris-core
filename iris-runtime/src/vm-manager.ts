/**
 * VmManager — on-demand Firecracker microVM pool.
 *
 * Each call to acquire() boots a fresh microVM for the given session
 * (identified by channelId). The VM is destroyed when release() is called,
 * or automatically after IDLE_TTL_MS of inactivity.
 *
 * Slots 1-254 map to the network 172.20.<slot>.0/30:
 *   host tap: 172.20.<slot>.1   guest: 172.20.<slot>.2
 *
 * Requires fc-up.sh and fc-down.sh scripts in the repo's scripts/ directory.
 */

import { spawn } from "child_process";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts");
const MAX_SLOT = 254;
const IDLE_TTL_MS = 30 * 60 * 1000; // release VM after 30 min of no exec calls
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // check for idle VMs every 5 min

interface VmEntry {
	slot: number;
	guestIp: string;
	lastActiveAt: number;
}

class VmManager {
	private sessions = new Map<string, VmEntry>();
	private usedSlots = new Set<number>();
	private cleanupTimer: ReturnType<typeof setInterval> | undefined;

	constructor() {
		// Periodic idle cleanup
		this.cleanupTimer = setInterval(() => void this.cleanupIdle(), CLEANUP_INTERVAL_MS);
		// Don't keep the process alive just for this timer
		this.cleanupTimer.unref?.();
	}

	/**
	 * Acquire a microVM for the given session. If the session already has a VM,
	 * returns its IP immediately. Otherwise boots a new one.
	 */
	async acquire(sessionId: string): Promise<string> {
		const existing = this.sessions.get(sessionId);
		if (existing) {
			existing.lastActiveAt = Date.now();
			return existing.guestIp;
		}

		const slot = this.allocateSlot();
		const guestIp = `172.20.${slot}.2`;

		try {
			await this.runScript("fc-up.sh", [String(slot)]);
		} catch (err) {
			this.usedSlots.delete(slot);
			throw new Error(`Failed to boot VM for session ${sessionId} (slot ${slot}): ${err}`);
		}

		this.sessions.set(sessionId, { slot, guestIp, lastActiveAt: Date.now() });
		return guestIp;
	}

	/**
	 * Release the VM for the given session. Safe to call even if no VM exists.
	 */
	async release(sessionId: string): Promise<void> {
		const entry = this.sessions.get(sessionId);
		if (!entry) return;

		this.sessions.delete(sessionId);
		this.usedSlots.delete(entry.slot);

		try {
			await this.runScript("fc-down.sh", [String(entry.slot)]);
		} catch (err) {
			// Log but don't throw — the session is already cleaned up in memory
			console.error(`[vm-manager] Warning: fc-down.sh slot=${entry.slot} failed: ${err}`);
		}
	}

	/** Touch last-active timestamp when a command is executed. */
	touch(sessionId: string): void {
		const entry = this.sessions.get(sessionId);
		if (entry) entry.lastActiveAt = Date.now();
	}

	/** Release all VMs (called on process exit). */
	async releaseAll(): Promise<void> {
		const ids = Array.from(this.sessions.keys());
		await Promise.allSettled(ids.map((id) => this.release(id)));
	}

	private allocateSlot(): number {
		for (let s = 1; s <= MAX_SLOT; s++) {
			if (!this.usedSlots.has(s)) {
				this.usedSlots.add(s);
				return s;
			}
		}
		throw new Error(`No free VM slots (all ${MAX_SLOT} slots in use)`);
	}

	private async cleanupIdle(): Promise<void> {
		const now = Date.now();
		for (const [sessionId, entry] of this.sessions) {
			if (now - entry.lastActiveAt > IDLE_TTL_MS) {
				console.log(`[vm-manager] Releasing idle VM for session ${sessionId} (slot ${entry.slot})`);
				await this.release(sessionId);
			}
		}
	}

	private runScript(script: string, args: string[]): Promise<void> {
		return new Promise((resolve, reject) => {
			const scriptPath = `${SCRIPTS_DIR}/${script}`;
			const child = spawn("bash", [scriptPath, ...args], {
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stderr = "";
			child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
			child.stdout?.on("data", () => {
				// fc-up.sh prints the guest IP to stdout — ignore it here since
				// we derive the IP from the slot number directly
			});

			child.on("close", (code) => {
				if (code === 0) resolve();
				else reject(new Error(stderr.trim() || `${script} exited with code ${code}`));
			});
		});
	}
}

// Module-level singleton — shared across all runners in the same process
export const vmManager = new VmManager();

// Clean up all VMs on process exit
process.on("exit", () => {
	void vmManager.releaseAll();
});
process.on("SIGTERM", () => {
	void vmManager.releaseAll().then(() => process.exit(0));
});
process.on("SIGINT", () => {
	void vmManager.releaseAll().then(() => process.exit(0));
});
