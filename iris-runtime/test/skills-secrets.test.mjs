// Core skills must resolve secrets via get-secret, not read them from the
// environment: store/proxy secrets mode scrubs SENSITIVE_ENV_VARS from
// process.env, so a bare $GITHUB_TOKEN is empty after migration (#288).

import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SENSITIVE_ENV_VARS } from "../dist/engine/secret-store.js";

const SKILLS_DIR = join(import.meta.dirname, "..", "..", "skills");

function skillFiles(dir) {
	return readdirSync(dir, { withFileTypes: true, recursive: true })
		.filter((e) => e.isFile())
		.map((e) => join(e.parentPath, e.name));
}

test("skills don't read scrubbed secrets from the environment", () => {
	const offenders = [];
	for (const file of skillFiles(SKILLS_DIR)) {
		const text = readFileSync(file, "utf8");
		for (const name of SENSITIVE_ENV_VARS) {
			if (!new RegExp(`\\$\\{?${name}\\b`).test(text)) continue;
			// A local variable assigned in the same file (e.g. from get-secret) is fine.
			if (new RegExp(`\\b${name}=`).test(text)) continue;
			offenders.push(`${file}: $${name}`);
		}
	}
	assert.deepEqual(offenders, [], "use get-secret instead of the environment");
});
