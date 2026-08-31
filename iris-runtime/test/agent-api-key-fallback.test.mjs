// Regression coverage for #242: pi-coding-agent's AgentSession calls
// ModelRegistry.getApiKeyAndHeaders() directly for compaction/branch-summary,
// bypassing the getApiKey() callback iris-core registers on the Agent for the
// secret-store fallback. applySecretStoreApiKeyFallback() wraps the registry
// method itself so every caller — ours and pi-coding-agent's internal ones —
// falls back to the secret store (env-backed by default in these tests) once
// a models.json provider's configured apiKey can't be resolved from
// process.env directly.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySecretStoreApiKeyFallback } from "../dist/engine/agent.js";

function makeModelsJson(providers) {
	const dir = mkdtempSync(join(tmpdir(), "iris-agent-api-key-"));
	const modelsJsonPath = join(dir, "models.json");
	writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	return modelsJsonPath;
}

function fakeRegistry(result) {
	return { getApiKeyAndHeaders: async () => result };
}

test("applySecretStoreApiKeyFallback falls back to the env-backed secret store when a $-prefixed apiKey throws", async () => {
	const modelsJsonPath = makeModelsJson({ "foundry-e2": { apiKey: "$FOUNDRY_E2_API_KEY" } });
	const registry = fakeRegistry({ ok: false, error: 'Missing required env var "FOUNDRY_E2_API_KEY"' });
	applySecretStoreApiKeyFallback(registry, modelsJsonPath);

	process.env.FOUNDRY_E2_API_KEY = "real-secret-value";
	try {
		const result = await registry.getApiKeyAndHeaders({ provider: "foundry-e2", id: "gpt" });
		assert.equal(result.ok, true);
		assert.equal(result.apiKey, "real-secret-value");
	} finally {
		delete process.env.FOUNDRY_E2_API_KEY;
	}
});

test("applySecretStoreApiKeyFallback falls back when the resolver echoes the configured env var name back literally", async () => {
	const modelsJsonPath = makeModelsJson({ mistral: { apiKey: "MISTRAL_API_KEY" } });
	const registry = fakeRegistry({ ok: true, apiKey: "MISTRAL_API_KEY" });
	applySecretStoreApiKeyFallback(registry, modelsJsonPath);

	process.env.MISTRAL_API_KEY = "real-mistral-key";
	try {
		const result = await registry.getApiKeyAndHeaders({ provider: "mistral", id: "large" });
		assert.equal(result.ok, true);
		assert.equal(result.apiKey, "real-mistral-key");
	} finally {
		delete process.env.MISTRAL_API_KEY;
	}
});

test("applySecretStoreApiKeyFallback passes through a real resolved key untouched", async () => {
	const modelsJsonPath = makeModelsJson({ custom: { apiKey: "$CUSTOM_API_KEY" } });
	const registry = fakeRegistry({ ok: true, apiKey: "sk-already-resolved", headers: { "X-Foo": "bar" } });
	applySecretStoreApiKeyFallback(registry, modelsJsonPath);

	const result = await registry.getApiKeyAndHeaders({ provider: "custom", id: "model" });
	assert.deepEqual(result, { ok: true, apiKey: "sk-already-resolved", headers: { "X-Foo": "bar" } });
});

test("applySecretStoreApiKeyFallback returns the original failure when no fallback resolves the key", async () => {
	const modelsJsonPath = makeModelsJson({ "foundry-e2": { apiKey: "$FOUNDRY_E2_API_KEY" } });
	const registry = fakeRegistry({ ok: false, error: 'Missing required env var "FOUNDRY_E2_API_KEY"' });
	applySecretStoreApiKeyFallback(registry, modelsJsonPath);

	delete process.env.FOUNDRY_E2_API_KEY;
	const result = await registry.getApiKeyAndHeaders({ provider: "foundry-e2", id: "gpt" });
	assert.equal(result.ok, false);
});
