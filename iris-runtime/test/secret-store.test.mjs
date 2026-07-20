// SecretStore (encrypted file store) + broker daemon + drop lifecycle +
// write API routes for the store/proxy secrets modes (docs/secrets.md).
// Drives compiled dist against tmp dirs, same pattern as secrets.test.mjs.

import assert from "node:assert/strict";
import { test, after, before } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { SecretStore } from "../dist/engine/secret-store.js";
import { startApiServer } from "../dist/engine/api.js";
import { redactKnownSecrets, registerSecretValue } from "../dist/engine/redact.js";
import { createDrop } from "../dist/engine/secret-drops.js";
import { WebTransport } from "../dist/transports/web/web.js";

function makeStoreDir() {
	const dir = mkdtempSync(join(tmpdir(), "iris-secret-store-test-"));
	const keyFile = join(dir, "secret.key");
	writeFileSync(keyFile, randomBytes(32).toString("hex"));
	return { dir, keyFile, storeFile: join(dir, "secrets.json.enc") };
}

// ── SecretStore ────────────────────────────────────────────────────────────

test("store: set/get round-trip, dash-underscore variants, metadata", () => {
	const { keyFile, storeFile } = makeStoreDir();
	const store = SecretStore.open({ keyFile, storeFile });
	store.set("MY-API-KEY", "s3cret-value", { source: "cli", proxyOnly: false });

	assert.equal(store.get("MY-API-KEY"), "s3cret-value");
	assert.equal(store.get("MY_API_KEY"), "s3cret-value"); // variant lookup
	assert.equal(store.meta("MY-API-KEY").source, "cli");
	assert.equal(store.meta("MY-API-KEY").proxyOnly, false);
	assert.equal(store.list().length, 1);
	// list/meta never expose ciphertext or value fields
	assert.equal(store.list()[0].ciphertext, undefined);
	assert.equal(store.list()[0].value, undefined);
});

test("store: tampered ciphertext fails closed (GCM tag)", () => {
	const { keyFile, storeFile } = makeStoreDir();
	const store = SecretStore.open({ keyFile, storeFile });
	store.set("TAMPER-ME", "original-value");

	const raw = JSON.parse(readFileSync(storeFile, "utf8"));
	const entry = raw.secrets["TAMPER-ME"];
	const bytes = Buffer.from(entry.ciphertext, "base64");
	bytes[0] ^= 0xff;
	entry.ciphertext = bytes.toString("base64");
	writeFileSync(storeFile, JSON.stringify(raw));

	assert.equal(store.get("TAMPER-ME"), undefined);
});

test("store: invalid names rejected, missing key file disables store", () => {
	const { keyFile, storeFile } = makeStoreDir();
	const store = SecretStore.open({ keyFile, storeFile });
	assert.throws(() => store.set("../evil", "x"));
	assert.throws(() => store.set("no spaces", "x"));

	assert.equal(SecretStore.open({ keyFile: join(tmpdir(), "does-not-exist.key"), storeFile }), null);
});

test("store: delete and overwrite preserve createdAt", async () => {
	const { keyFile, storeFile } = makeStoreDir();
	const store = SecretStore.open({ keyFile, storeFile });
	store.set("K", "v1");
	const created = store.meta("K").createdAt;
	await new Promise((r) => setTimeout(r, 5));
	store.set("K", "v2");
	assert.equal(store.get("K"), "v2");
	assert.equal(store.meta("K").createdAt, created);
	assert.equal(store.delete("K"), true);
	assert.equal(store.delete("K"), false);
	assert.equal(store.get("K"), undefined);
});

// ── Redaction ──────────────────────────────────────────────────────────────

test("redact: registered values are masked, short values ignored", () => {
	registerSecretValue("super-secret-token-value");
	registerSecretValue("short");
	const out = redactKnownSecrets("prefix super-secret-token-value suffix short");
	assert.ok(!out.includes("super-secret-token-value"));
	assert.ok(out.includes("[REDACTED-SECRET]"));
	assert.ok(out.includes("short")); // below min length, untouched
});

// ── Broker daemon ──────────────────────────────────────────────────────────

const BROKER_PORT = 19461;
const BROKER_BASE = `http://127.0.0.1:${BROKER_PORT}`;
const BROKER_TOKEN = "test-broker-token";
let brokerProc;
let brokerStore;

// Mock upstream the gateway forwards to.
const UPSTREAM_PORT = 19462;
let upstreamServer;
let lastUpstreamReq;

before(async () => {
	const { dir, keyFile, storeFile } = makeStoreDir();
	brokerStore = { dir, keyFile, storeFile };
	writeFileSync(
		join(dir, "services.json"),
		JSON.stringify({
			mockapi: {
				upstream: `http://127.0.0.1:${UPSTREAM_PORT}`,
				secret: "MOCK-API-KEY",
				headers: { Authorization: "Bearer {value}" },
			},
		}),
	);

	const { createServer } = await import("node:http");
	upstreamServer = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			lastUpstreamReq = { url: req.url, method: req.method, headers: req.headers, body };
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ upstream: true }));
		});
	});
	await new Promise((r) => upstreamServer.listen(UPSTREAM_PORT, "127.0.0.1", r));

	brokerProc = spawn(process.execPath, [join(import.meta.dirname, "..", "dist", "broker", "main.js")], {
		env: {
			...process.env,
			IRIS_BROKER_PORT: String(BROKER_PORT),
			IRIS_SECRET_BROKER_TOKEN: BROKER_TOKEN,
			IRIS_SECRET_KEY_FILE: keyFile,
			IRIS_SECRET_STORE_FILE: storeFile,
			IRIS_BROKER_SERVICES_FILE: join(dir, "services.json"),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	for (let i = 0; i < 50; i++) {
		try {
			const res = await fetch(`${BROKER_BASE}/health`);
			if (res.ok) return;
		} catch {
			await new Promise((r) => setTimeout(r, 100));
		}
	}
	throw new Error("broker did not become healthy");
});

after(() => {
	brokerProc?.kill();
	upstreamServer?.close();
});

const brokerAuth = { Authorization: `Bearer ${BROKER_TOKEN}` };

test("broker: rejects requests without the token", async () => {
	assert.equal((await fetch(`${BROKER_BASE}/secrets`)).status, 401);
	assert.equal((await fetch(`${BROKER_BASE}/secret/X`, { headers: { Authorization: "Bearer wrong" } })).status, 401);
});

test("broker: PUT / GET / meta / list / DELETE round-trip", async () => {
	const put = await fetch(`${BROKER_BASE}/secret/ROUND-TRIP`, {
		method: "PUT",
		headers: { ...brokerAuth, "Content-Type": "application/json" },
		body: JSON.stringify({ value: "round-trip-value", source: "cli" }),
	});
	assert.equal(put.status, 200);

	const get = await fetch(`${BROKER_BASE}/secret/ROUND-TRIP`, { headers: brokerAuth });
	assert.equal(get.status, 200);
	assert.equal((await get.json()).value, "round-trip-value");

	const meta = await fetch(`${BROKER_BASE}/meta/ROUND-TRIP`, { headers: brokerAuth });
	assert.equal((await meta.json()).source, "cli");

	const list = await fetch(`${BROKER_BASE}/secrets`, { headers: brokerAuth });
	const names = (await list.json()).secrets.map((s) => s.name);
	assert.ok(names.includes("ROUND-TRIP"));

	assert.equal((await fetch(`${BROKER_BASE}/secret/ROUND-TRIP`, { method: "DELETE", headers: brokerAuth })).status, 200);
	assert.equal((await fetch(`${BROKER_BASE}/secret/ROUND-TRIP`, { headers: brokerAuth })).status, 404);
});

test("broker: proxy-only secrets are unreadable with ANY token but usable via the gateway", async () => {
	await fetch(`${BROKER_BASE}/secret/MOCK-API-KEY`, {
		method: "PUT",
		headers: { ...brokerAuth, "Content-Type": "application/json" },
		body: JSON.stringify({ value: "gateway-injected-credential", proxyOnly: true }),
	});

	// The hard guarantee: plaintext read refused even for a valid token.
	const read = await fetch(`${BROKER_BASE}/secret/MOCK-API-KEY`, { headers: brokerAuth });
	assert.equal(read.status, 403);

	// ...but the gateway exercises it: header injected, caller auth stripped.
	const proxied = await fetch(`${BROKER_BASE}/proxy/mockapi/v1/send?x=1`, {
		method: "POST",
		headers: { ...brokerAuth, "Content-Type": "application/json", "X-Custom": "kept" },
		body: JSON.stringify({ hello: "world" }),
	});
	assert.equal(proxied.status, 200);
	assert.equal((await proxied.json()).upstream, true);
	assert.equal(lastUpstreamReq.url, "/v1/send?x=1");
	assert.equal(lastUpstreamReq.headers.authorization, "Bearer gateway-injected-credential");
	assert.equal(lastUpstreamReq.headers["x-custom"], "kept");
	assert.equal(lastUpstreamReq.body, JSON.stringify({ hello: "world" }));
});

test("broker: unknown gateway service 404s", async () => {
	assert.equal((await fetch(`${BROKER_BASE}/proxy/nope/x`, { headers: brokerAuth })).status, 404);
});

// ── Runtime API: write routes, alias, drops (store mode against tmp store) ──

const API_PORT = 19470;
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const servers = [];

after(() => {
	for (const server of servers) server.close();
});

function startApi(agents = {}) {
	const workingDir = mkdtempSync(join(tmpdir(), "iris-secrets-api-test-"));
	writeFileSync(join(workingDir, "agents.json"), JSON.stringify(agents));
	const server = startApiServer(API_PORT, workingDir, new Map(), () => []);
	servers.push(server);
	return workingDir;
}

test("api: PUT/DELETE/list/drops in store mode; sub-agent write and policy 403s; /secret alias", async (t) => {
	const { keyFile, storeFile } = makeStoreDir();
	process.env.IRIS_SECRETS_MODE = "store";
	process.env.IRIS_SECRET_KEY_FILE = keyFile;
	process.env.IRIS_SECRET_STORE_FILE = storeFile;
	process.env.IRIS_API_TOKEN = "iris-shared-token";
	process.env.IRIS_WEBUI_PORT = "18081";
	t.after(() => {
		delete process.env.IRIS_SECRETS_MODE;
		delete process.env.IRIS_SECRET_KEY_FILE;
		delete process.env.IRIS_SECRET_STORE_FILE;
		delete process.env.IRIS_API_TOKEN;
		delete process.env.IRIS_WEBUI_PORT;
	});
	startApi({ "sub-agent": { secrets: ["WRITE-TEST"], token: "sub-agent-token" } });
	const iris = { Authorization: "Bearer iris-shared-token" };
	const sub = { Authorization: "Bearer sub-agent-token" };

	// iris writes
	const put = await fetch(`${API_BASE}/secrets/WRITE-TEST`, {
		method: "PUT",
		headers: { ...iris, "Content-Type": "application/json" },
		body: JSON.stringify({ value: "written-through-api" }),
	});
	assert.equal(put.status, 200);

	// read through the canonical path and the /secret alias (allow-listed agent)
	assert.equal((await (await fetch(`${API_BASE}/secrets/WRITE-TEST`, { headers: iris })).json()).value, "written-through-api");
	assert.equal((await (await fetch(`${API_BASE}/secret/WRITE-TEST`, { headers: sub })).json()).value, "written-through-api");

	// sub-agent cannot write or list
	assert.equal(
		(await fetch(`${API_BASE}/secrets/WRITE-TEST`, {
			method: "PUT",
			headers: { ...sub, "Content-Type": "application/json" },
			body: JSON.stringify({ value: "nope" }),
		})).status,
		403,
	);
	assert.equal((await fetch(`${API_BASE}/secrets`, { headers: sub })).status, 403);

	// runtime-only secrets 403 even for iris
	await fetch(`${API_BASE}/secrets/RUNTIME-ONLY`, {
		method: "PUT",
		headers: { ...iris, "Content-Type": "application/json" },
		body: JSON.stringify({ value: "internal", agentReadable: false }),
	});
	assert.equal((await fetch(`${API_BASE}/secrets/RUNTIME-ONLY`, { headers: iris })).status, 403);

	// drop minting: iris only, returns a one-time path
	assert.equal((await fetch(`${API_BASE}/secret-drops`, {
		method: "POST",
		headers: { ...sub, "Content-Type": "application/json" },
		body: JSON.stringify({ name: "X" }),
	})).status, 403);
	const dropRes = await fetch(`${API_BASE}/secret-drops`, {
		method: "POST",
		headers: { ...iris, "Content-Type": "application/json" },
		body: JSON.stringify({ name: "DROPPED-KEY", ttlSeconds: 300 }),
	});
	assert.equal(dropRes.status, 200);
	const drop = await dropRes.json();
	assert.match(drop.path, /^\/secret-drop\/[a-f0-9]{48}$/);
	assert.ok(new Date(drop.expiresAt).getTime() > Date.now());

	// list shows names + metadata, no values
	const list = await (await fetch(`${API_BASE}/secrets`, { headers: iris })).json();
	const entry = list.secrets.find((s) => s.name === "WRITE-TEST");
	assert.ok(entry);
	assert.equal(entry.value, undefined);
	assert.equal(entry.ciphertext, undefined);
});

// ── Drop page on the web transport ─────────────────────────────────────────

test("web: drop link renders pre-auth, stores once, burns, and notifies the channel", async (t) => {
	const { keyFile, storeFile } = makeStoreDir();
	process.env.IRIS_SECRETS_MODE = "store";
	process.env.IRIS_SECRET_KEY_FILE = keyFile;
	process.env.IRIS_SECRET_STORE_FILE = storeFile;
	process.env.IRIS_WEBUI_PASSWORD = "webui-password"; // drop routes must not need it
	t.after(() => {
		delete process.env.IRIS_SECRETS_MODE;
		delete process.env.IRIS_SECRET_KEY_FILE;
		delete process.env.IRIS_SECRET_STORE_FILE;
		delete process.env.IRIS_WEBUI_PASSWORD;
	});

	const workingDir = mkdtempSync(join(tmpdir(), "iris-drop-web-test-"));
	writeFileSync(join(workingDir, "agents.json"), "{}");
	const port = 19481;
	const web = new WebTransport({
		port,
		workingDir,
		dispatch: () => {},
		commands: { stop: async () => {}, compact: async () => {}, reset: async () => {} },
	});
	web.start();
	t.after(() => web.stop());
	await new Promise((r) => setTimeout(r, 100));

	const drop = createDrop({ name: "DROPPED-VIA-WEB", channelId: "C123TEST" });
	const base = `http://127.0.0.1:${port}`;

	// Form renders without any session cookie; unknown token 404s.
	const form = await fetch(`${base}/secret-drop/${drop.token}`);
	assert.equal(form.status, 200);
	assert.match(await form.text(), /DROPPED-VIA-WEB/);
	assert.equal((await fetch(`${base}/secret-drop/${"0".repeat(48)}`)).status, 404);

	// Submit stores the value...
	const submit = await fetch(`${base}/secret-drop/${drop.token}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ value: "value-from-the-drop-form" }),
	});
	assert.equal(submit.status, 200);
	const store = SecretStore.open({ keyFile, storeFile });
	assert.equal(store.get("DROPPED-VIA-WEB"), "value-from-the-drop-form");
	assert.equal(store.meta("DROPPED-VIA-WEB").source, "drop");

	// ...burns the link (second submit and re-render both 404)...
	assert.equal((await fetch(`${base}/secret-drop/${drop.token}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ value: "again" }),
	})).status, 404);
	assert.equal((await fetch(`${base}/secret-drop/${drop.token}`)).status, 404);

	// ...and drops a name-only notification event for the channel.
	const eventsDir = join(workingDir, "events");
	assert.ok(existsSync(eventsDir));
	const events = readdirSync(eventsDir).map((f) => JSON.parse(readFileSync(join(eventsDir, f), "utf8")));
	const notify = events.find((e) => e.channelId === "C123TEST");
	assert.ok(notify);
	assert.match(notify.text, /DROPPED-VIA-WEB/);
	assert.ok(!JSON.stringify(events).includes("value-from-the-drop-form"));
});
