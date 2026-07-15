import { spawn } from "child_process";

export type SandboxConfig =
	| { type: "host" }
	| { type: "docker"; container: string }
	| { type: "firecracker"; agentIp: string }
	| { type: "firecracker-pool"; sessionId: string };

export function parseSandboxArg(value: string): SandboxConfig {
	if (value === "host") {
		return { type: "host" };
	}
	if (value.startsWith("docker:")) {
		const container = value.slice("docker:".length);
		if (!container) {
			console.error("Error: docker sandbox requires container name (e.g., docker:iris-sandbox)");
			process.exit(1);
		}
		return { type: "docker", container };
	}
	if (value.startsWith("firecracker:")) {
		const agentIp = value.slice("firecracker:".length);
		if (!agentIp) {
			console.error("Error: firecracker sandbox requires agent IP (e.g., firecracker:172.20.1.2)");
			process.exit(1);
		}
		return { type: "firecracker", agentIp };
	}
	if (value === "firecracker-pool") {
		// sessionId is assigned later by createExecutor when the channelId is known
		return { type: "firecracker-pool", sessionId: "" };
	}
	console.error(`Error: Invalid sandbox type '${value}'. Use 'host', 'docker:<container>', 'firecracker:<ip>', or 'firecracker-pool'`);
	process.exit(1);
}

export async function validateSandbox(config: SandboxConfig): Promise<void> {
	if (config.type === "host") {
		return;
	}

	if (config.type === "firecracker") {
		try {
			const res = await fetch(`http://${config.agentIp}:8080/health`, { signal: AbortSignal.timeout(5000) });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			console.log(`  Firecracker VM at ${config.agentIp} is healthy.`);
		} catch (err) {
			console.error(`Error: Firecracker VM at ${config.agentIp} is not reachable: ${err}`);
			console.error("Check that the VM is booted: systemctl status iris-fc-<name>");
			process.exit(1);
		}
		return;
	}

	if (config.type === "firecracker-pool") {
		// Pool VMs are acquired lazily per session — nothing to validate upfront
		console.log("  Firecracker pool mode: VMs will be spawned on demand per session.");
		return;
	}

	// Check if Docker is available
	try {
		await execSimple("docker", ["--version"]);
	} catch {
		console.error("Error: Docker is not installed or not in PATH");
		process.exit(1);
	}

	// Check if container exists and is running
	try {
		const result = await execSimple("docker", ["inspect", "-f", "{{.State.Running}}", config.container]);
		if (result.trim() !== "true") {
			console.error(`Error: Container '${config.container}' is not running.`);
			console.error(`Start it with: docker start ${config.container}`);
			process.exit(1);
		}
	} catch {
		console.error(`Error: Container '${config.container}' does not exist.`);
		console.error(`Create it with: docker run -d --name ${config.container} -v <data-dir>:/workspace alpine:latest tail -f /dev/null`);
		process.exit(1);
	}

	console.log(`  Docker container '${config.container}' is running.`);
}

function execSimple(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d) => {
			stdout += d;
		});
		child.stderr?.on("data", (d) => {
			stderr += d;
		});
		child.on("close", (code) => {
			if (code === 0) resolve(stdout);
			else reject(new Error(stderr || `Exit code ${code}`));
		});
	});
}

/**
 * Create an executor for the given sandbox config.
 * For firecracker-pool mode, sessionId (channelId) must be provided so the
 * VmManager can track which VM belongs to which session.
 */
export function createExecutor(config: SandboxConfig, sessionId?: string): Executor {
	if (config.type === "host") {
		return new HostExecutor();
	}
	if (config.type === "firecracker") {
		return new FirecrackerExecutor(config.agentIp);
	}
	if (config.type === "firecracker-pool") {
		if (!sessionId) throw new Error("firecracker-pool sandbox requires a sessionId");
		return new FirecrackerPoolExecutor(sessionId);
	}
	return new DockerExecutor(config.container);
}

/**
 * Release the VM held by an executor (no-op for non-pool executors).
 * Call this when a session ends.
 */
export async function releaseExecutor(executor: Executor): Promise<void> {
	if (executor instanceof FirecrackerPoolExecutor) {
		await executor.release();
	}
}

export interface Executor {
	/**
	 * Execute a bash command
	 */
	exec(command: string, options?: ExecOptions): Promise<ExecResult>;

	/**
	 * Get the workspace path prefix for this executor
	 * Host: returns the actual path
	 * Docker: returns /workspace
	 */
	getWorkspacePath(hostPath: string): string;
}

export interface ExecOptions {
	timeout?: number;
	signal?: AbortSignal;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

class HostExecutor implements Executor {
	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		return new Promise((resolve, reject) => {
			const shell = process.platform === "win32" ? "cmd" : "sh";
			const shellArgs = process.platform === "win32" ? ["/c"] : ["-c"];

			const child = spawn(shell, [...shellArgs, command], {
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";
			let timedOut = false;

			const timeoutHandle =
				options?.timeout && options.timeout > 0
					? setTimeout(() => {
							timedOut = true;
							killProcessTree(child.pid!);
						}, options.timeout * 1000)
					: undefined;

			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			if (options?.signal) {
				if (options.signal.aborted) {
					onAbort();
				} else {
					options.signal.addEventListener("abort", onAbort, { once: true });
				}
			}

			child.stdout?.on("data", (data) => {
				stdout += data.toString();
				if (stdout.length > 10 * 1024 * 1024) {
					stdout = stdout.slice(0, 10 * 1024 * 1024);
				}
			});

			child.stderr?.on("data", (data) => {
				stderr += data.toString();
				if (stderr.length > 10 * 1024 * 1024) {
					stderr = stderr.slice(0, 10 * 1024 * 1024);
				}
			});

			child.on("close", (code) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (options?.signal) {
					options.signal.removeEventListener("abort", onAbort);
				}

				if (options?.signal?.aborted) {
					reject(new Error(`${stdout}\n${stderr}\nCommand aborted`.trim()));
					return;
				}

				if (timedOut) {
					reject(new Error(`${stdout}\n${stderr}\nCommand timed out after ${options?.timeout} seconds`.trim()));
					return;
				}

				resolve({ stdout, stderr, code: code ?? 0 });
			});
		});
	}

	getWorkspacePath(hostPath: string): string {
		return hostPath;
	}
}

class DockerExecutor implements Executor {
	constructor(private container: string) {}

	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		// Wrap command for docker exec
		const dockerCmd = `docker exec ${this.container} sh -c ${shellEscape(command)}`;
		const hostExecutor = new HostExecutor();
		return hostExecutor.exec(dockerCmd, options);
	}

	getWorkspacePath(_hostPath: string): string {
		// Docker container sees /workspace
		return "/workspace";
	}
}

class FirecrackerPoolExecutor implements Executor {
	private inner: FirecrackerExecutor | undefined;

	constructor(private sessionId: string) {}

	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		if (!this.inner) {
			const { vmManager } = await import("./vm-manager.js");
			const guestIp = await vmManager.acquire(this.sessionId);
			this.inner = new FirecrackerExecutor(guestIp);
		} else {
			// Refresh idle TTL on each command
			const { vmManager } = await import("./vm-manager.js");
			vmManager.touch(this.sessionId);
		}
		return this.inner.exec(command, options);
	}

	getWorkspacePath(_hostPath: string): string {
		return "/workspace";
	}

	async release(): Promise<void> {
		const { vmManager } = await import("./vm-manager.js");
		await vmManager.release(this.sessionId);
		this.inner = undefined;
	}
}

class FirecrackerExecutor implements Executor {
	constructor(private agentIp: string) {}

	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		const url = `http://${this.agentIp}:8080/exec`;
		const timeout = options?.timeout ?? 60;

		const controller = new AbortController();
		const httpTimeout = setTimeout(() => controller.abort(), (timeout + 5) * 1000);

		if (options?.signal) {
			options.signal.addEventListener("abort", () => controller.abort(), { once: true });
		}

		try {
			const res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ command, timeout }),
				signal: controller.signal,
			});

			if (!res.ok) {
				const text = await res.text();
				return { stdout: "", stderr: `Firecracker exec HTTP ${res.status}: ${text}`, code: 1 };
			}

			const data = (await res.json()) as { stdout: string; stderr: string; exit_code: number };
			return { stdout: data.stdout, stderr: data.stderr, code: data.exit_code };
		} catch (err) {
			if (options?.signal?.aborted) {
				throw new Error("Command aborted");
			}
			throw new Error(`Firecracker VM unreachable at ${this.agentIp}: ${err}`);
		} finally {
			clearTimeout(httpTimeout);
		}
	}

	getWorkspacePath(_hostPath: string): string {
		return "/workspace";
	}
}

function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
			});
		} catch {
			// Ignore errors
		}
	} else {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		}
	}
}

function shellEscape(s: string): string {
	// Escape for passing to sh -c
	return `'${s.replace(/'/g, "'\\''")}'`;
}
