#!/usr/bin/env node
// ============================================================================
// iris-secret — operator CLI for the encrypted secret store.
//
// The out-of-band path for SSH users (and bootstrap): manage secrets without
// ever pasting them into chat. Two backends, decided per invocation:
//   - IRIS_SECRET_BROKER_URL set (proxy mode) → the broker daemon's HTTP API
//   - otherwise → the store file directly (store mode; run as the owning user)
//
// Values are read from stdin or a hidden TTY prompt — never argv, so nothing
// lands in shell history or process listings.
//
// Commands:
//   iris-secret init                      generate the key file if missing
//   iris-secret set NAME [--proxy-only]   value from stdin / hidden prompt
//   iris-secret get NAME
//   iris-secret list
//   iris-secret rm NAME
//   iris-secret import-env FILE [--prune] move known secret vars from an env
//                                         file into the store; --prune rewrites
//                                         the file without those lines
// ============================================================================

import { readFileSync, writeFileSync } from "fs";
import { createInterface } from "readline";
import { SECRET_NAME_RE, SecretStore, SENSITIVE_ENV_VARS } from "../engine/secret-store.js";

const DEFAULT_KEY_FILE = process.env.IRIS_SECRET_KEY_FILE ?? "/iris/secret.key";

function fail(message: string): never {
	console.error(`iris-secret: ${message}`);
	process.exit(1);
}

function usage(): never {
	console.error(
		"Usage: iris-secret <init | set NAME [--proxy-only] | get NAME | list | rm NAME | import-env FILE [--prune]>",
	);
	process.exit(1);
}

interface Backend {
	set(name: string, value: string, opts: { proxyOnly?: boolean; source: "cli" | "import" }): Promise<void>;
	get(name: string): Promise<string | undefined>;
	list(): Promise<Array<{ name: string; source: string; proxyOnly: boolean; updatedAt: string }>>;
	delete(name: string): Promise<boolean>;
	has(name: string): Promise<boolean>;
	label: string;
}

function brokerBackend(baseUrl: string): Backend {
	const base = baseUrl.replace(/\/$/, "");
	const token = process.env.IRIS_SECRET_BROKER_TOKEN;
	const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
	return {
		label: `broker at ${base}`,
		async set(name, value, opts) {
			const res = await fetch(`${base}/secret/${encodeURIComponent(name)}`, {
				method: "PUT",
				headers: { ...auth, "Content-Type": "application/json" },
				body: JSON.stringify({ value, proxyOnly: opts.proxyOnly, source: opts.source }),
			});
			if (!res.ok) fail(`broker refused PUT (${res.status})`);
		},
		async get(name) {
			const res = await fetch(`${base}/secret/${encodeURIComponent(name)}`, { headers: auth });
			if (res.status === 403) fail("that secret is proxy-only — it has no readable plaintext");
			if (!res.ok) return undefined;
			return ((await res.json()) as { value?: string }).value;
		},
		async list() {
			const res = await fetch(`${base}/secrets`, { headers: auth });
			if (!res.ok) fail(`broker refused list (${res.status})`);
			return ((await res.json()) as { secrets: Array<{ name: string; source: string; proxyOnly: boolean; updatedAt: string }> }).secrets;
		},
		async delete(name) {
			const res = await fetch(`${base}/secret/${encodeURIComponent(name)}`, { method: "DELETE", headers: auth });
			return res.ok;
		},
		async has(name) {
			const res = await fetch(`${base}/meta/${encodeURIComponent(name)}`, { headers: auth });
			return res.ok;
		},
	};
}

function fileBackend(): Backend {
	const open = (): SecretStore =>
		SecretStore.open() ??
		fail(`store not configured — key file missing (run 'iris-secret init', key path: ${DEFAULT_KEY_FILE})`);
	return {
		label: "local store file",
		async set(name, value, opts) {
			open().set(name, value, opts);
		},
		async get(name) {
			const store = open();
			if (store.meta(name)?.proxyOnly) fail("that secret is proxy-only — it has no readable plaintext");
			return store.get(name);
		},
		async list() {
			return open().list();
		},
		async delete(name) {
			return open().delete(name);
		},
		async has(name) {
			return open().has(name);
		},
	};
}

function getBackend(): Backend {
	const brokerUrl = process.env.IRIS_SECRET_BROKER_URL;
	return brokerUrl ? brokerBackend(brokerUrl) : fileBackend();
}

/** Read the value from stdin (piped) or a hidden TTY prompt. */
async function readValue(): Promise<string> {
	if (!process.stdin.isTTY) {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
		// A single trailing newline from `echo`/heredocs is almost never part of
		// the secret; embedded newlines are preserved.
		return Buffer.concat(chunks).toString("utf8").replace(/\n$/, "");
	}
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
		process.stderr.write("Secret value (hidden): ");
		const stream = process.stdin as NodeJS.ReadStream;
		stream.setRawMode?.(true);
		let value = "";
		const onData = (char: Buffer) => {
			const c = char.toString("utf8");
			if (c === "\r" || c === "\n") {
				stream.setRawMode?.(false);
				stream.removeListener("data", onData);
				rl.close();
				process.stderr.write("\n");
				resolve(value);
			} else if (c === "\u0003" /* Ctrl-C */) {
				process.stderr.write("\n");
				process.exit(130);
			} else if (c === "\u007f" /* backspace */) {
				value = value.slice(0, -1);
			} else {
				value += c;
			}
		};
		stream.on("data", onData);
	});
}

function validName(name: string | undefined): string {
	if (!name || !SECRET_NAME_RE.test(name)) fail("secret name must match [A-Za-z0-9_-]{1,128}");
	return name;
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
	case "init": {
		const created = SecretStore.initKeyFile(DEFAULT_KEY_FILE);
		console.log(created ? `created ${DEFAULT_KEY_FILE} (0600)` : `${DEFAULT_KEY_FILE} already exists — left untouched`);
		break;
	}

	case "set": {
		const name = validName(rest[0]);
		const proxyOnly = rest.includes("--proxy-only");
		const value = await readValue();
		if (!value) fail("empty value");
		await getBackend().set(name, value, { proxyOnly, source: "cli" });
		console.log(`stored '${name}'${proxyOnly ? " (proxy-only)" : ""}`);
		break;
	}

	case "get": {
		const name = validName(rest[0]);
		const value = await getBackend().get(name);
		if (value === undefined) fail(`'${name}' not found`);
		process.stdout.write(value + "\n");
		break;
	}

	case "list": {
		const secrets = await getBackend().list();
		if (secrets.length === 0) {
			console.log("(no secrets stored)");
			break;
		}
		for (const secret of secrets.sort((a, b) => a.name.localeCompare(b.name))) {
			console.log(`${secret.name}\tsource=${secret.source}${secret.proxyOnly ? "\tproxy-only" : ""}\tupdated=${secret.updatedAt}`);
		}
		break;
	}

	case "rm": {
		const name = validName(rest[0]);
		if (!(await getBackend().delete(name))) fail(`'${name}' not found`);
		console.log(`deleted '${name}'`);
		break;
	}

	case "import-env": {
		const file = rest[0] ?? fail("usage: iris-secret import-env FILE [--prune]");
		const prune = rest.includes("--prune");
		const backend = getBackend();
		let content: string;
		try {
			content = readFileSync(file, "utf8");
		} catch {
			fail(`cannot read ${file}`);
		}
		const lines = content.split("\n");
		const sensitive = new Set<string>(SENSITIVE_ENV_VARS);
		const moved: string[] = [];
		const kept: string[] = [];
		for (const line of lines) {
			const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
			const varName = match?.[1];
			if (match && varName && sensitive.has(varName)) {
				// Strip optional surrounding quotes, same as dotenv would.
				let value = match[2];
				if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
					value = value.slice(1, -1);
				}
				if (value) {
					await backend.set(varName.replace(/_/g, "-"), value, { source: "import" });
					moved.push(varName);
					continue; // pruned line — only dropped when --prune rewrites below
				}
			}
			kept.push(line);
		}
		if (moved.length === 0) {
			console.log("nothing to import — no known secret vars with values found");
			break;
		}
		console.log(`imported into ${backend.label}: ${moved.join(", ")}`);
		if (prune) {
			writeFileSync(file, kept.join("\n"), { mode: 0o600 });
			console.log(`pruned ${moved.length} line(s) from ${file}`);
		} else {
			console.log(`(re-run with --prune to remove those lines from ${file})`);
		}
		break;
	}

	default:
		usage();
}
