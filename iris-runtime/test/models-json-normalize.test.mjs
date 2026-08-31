// Regression coverage for #232: providers loaded from a workspace models.json
// skip pi-coding-agent's legacy-env-var-name migration (which only runs for
// registerProvider()), so a bare "MY_KEY" apiKey value gets echoed back
// literally by ModelRegistry.getApiKeyAndHeaders() instead of being resolved
// from the environment — breaking every consumer, including
// AgentSession.compact()/branch-summary. normalizeModelsJsonApiKeys() rewrites
// those bare values to "$MY_KEY" so the registry resolves them correctly, but
// only when the named env var is actually set, so a literal key that merely
// looks like an env-var name is never rewritten into an unresolvable reference.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeModelsJsonApiKeys } from "../dist/engine/agent.js";

function makeTmpDir() {
	return mkdtempSync(join(tmpdir(), "iris-models-json-"));
}

test("normalizeModelsJsonApiKeys rewrites a bare env-var-name apiKey to $NAME when the env var is set", () => {
	const dir = makeTmpDir();
	const modelsJson = join(dir, "models.json");
	writeFileSync(
		modelsJson,
		JSON.stringify({
			providers: {
				"azure-foundry": { apiKey: "MY_PROVIDER_API_KEY", baseUrl: "https://example.com" },
			},
		}),
	);

	process.env.MY_PROVIDER_API_KEY = "some-secret-value";
	try {
		const resultPath = normalizeModelsJsonApiKeys(modelsJson, dir);

		assert.notEqual(resultPath, modelsJson);
		const written = JSON.parse(readFileSync(resultPath, "utf8"));
		assert.equal(written.providers["azure-foundry"].apiKey, "$MY_PROVIDER_API_KEY");
	} finally {
		delete process.env.MY_PROVIDER_API_KEY;
	}
});

test("normalizeModelsJsonApiKeys leaves an all-caps apiKey untouched when no matching env var is set", () => {
	// A literal API key that happens to look like an env-var name (all-caps/digits/
	// underscores) must not be rewritten into an unresolvable "$NAME" reference —
	// that would turn a previously-working literal key into a silent 401.
	const dir = makeTmpDir();
	const modelsJson = join(dir, "models.json");
	writeFileSync(
		modelsJson,
		JSON.stringify({ providers: { custom: { apiKey: "NOTAREALSECRETVALUE" } } }),
	);
	delete process.env.NOTAREALSECRETVALUE;

	const resultPath = normalizeModelsJsonApiKeys(modelsJson, dir);

	assert.equal(resultPath, modelsJson);
});

test("normalizeModelsJsonApiKeys leaves an already-templated apiKey untouched", () => {
	const dir = makeTmpDir();
	const modelsJson = join(dir, "models.json");
	writeFileSync(
		modelsJson,
		JSON.stringify({ providers: { custom: { apiKey: "$MY_PROVIDER_API_KEY" } } }),
	);

	const resultPath = normalizeModelsJsonApiKeys(modelsJson, dir);

	assert.equal(resultPath, modelsJson);
});

test("normalizeModelsJsonApiKeys leaves a literal (non env-var-shaped) apiKey untouched", () => {
	const dir = makeTmpDir();
	const modelsJson = join(dir, "models.json");
	writeFileSync(
		modelsJson,
		JSON.stringify({ providers: { custom: { apiKey: "sk-live-abc123" } } }),
	);

	const resultPath = normalizeModelsJsonApiKeys(modelsJson, dir);

	assert.equal(resultPath, modelsJson);
});

test("normalizeModelsJsonApiKeys returns the original path when there are no providers", () => {
	const dir = makeTmpDir();
	const modelsJson = join(dir, "models.json");
	writeFileSync(modelsJson, JSON.stringify({}));

	const resultPath = normalizeModelsJsonApiKeys(modelsJson, dir);

	assert.equal(resultPath, modelsJson);
});

test("normalizeModelsJsonApiKeys creates channelDir when it doesn't exist yet", () => {
	// Regression for a fresh channel's first interaction (e.g. /compact on a brand-new
	// channel): createRunner() calls this before run()'s mkdir(channelDir) has ever run.
	const parent = makeTmpDir();
	const channelDir = join(parent, "brand-new-channel");
	const modelsJson = join(parent, "models.json");
	writeFileSync(
		modelsJson,
		JSON.stringify({ providers: { custom: { apiKey: "MY_PROVIDER_API_KEY" } } }),
	);

	process.env.MY_PROVIDER_API_KEY = "some-secret-value";
	try {
		const resultPath = normalizeModelsJsonApiKeys(modelsJson, channelDir);

		const written = JSON.parse(readFileSync(resultPath, "utf8"));
		assert.equal(written.providers.custom.apiKey, "$MY_PROVIDER_API_KEY");
	} finally {
		delete process.env.MY_PROVIDER_API_KEY;
	}
});
