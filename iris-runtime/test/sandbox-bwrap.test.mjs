// Tests for the bwrap sandbox executor (#267).
// Requires `npm run build` first (tests import ../dist/*.js). Exec tests skip
// when bwrap is missing or unprivileged user namespaces are unavailable.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createExecutor, parseSandboxArg } from "../dist/engine/sandbox.js";

const bwrapWorks = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-all", "true"]).status === 0;

function setup() {
	const workspaceDir = mkdtempSync(join(tmpdir(), "iris-bwrap-"));
	const channelDir = join(workspaceDir, "telegram", "tg-1");
	const otherDir = join(workspaceDir, "telegram", "tg-2");
	mkdirSync(channelDir, { recursive: true });
	mkdirSync(otherDir, { recursive: true });
	mkdirSync(join(workspaceDir, "skills"));
	writeFileSync(join(otherDir, "secret.txt"), "other tenant");
	writeFileSync(join(workspaceDir, "skills", "s.md"), "skill");
	const executor = createExecutor({ type: "bwrap" }, "tg-1", { workspaceDir, channelDir });
	return { workspaceDir, channelDir, otherDir, executor };
}

test("parseSandboxArg accepts bwrap", () => {
	assert.deepEqual(parseSandboxArg("bwrap"), { type: "bwrap" });
});

test("bwrap mode refuses the unauthenticated loopback API", () => {
	const env = { ...process.env };
	delete env.IRIS_API_TOKEN;
	const check = spawnSync(process.execPath, [
		"--input-type=module", "-e",
		'import { validateSandbox } from "./dist/engine/sandbox.js"; await validateSandbox({ type: "bwrap" });',
	], { cwd: process.cwd(), env, encoding: "utf8" });
	assert.equal(check.status, 1);
	assert.match(check.stderr, /requires IRIS_API_TOKEN/);
});

test("bwrap mode starts when the loopback API has a token", { skip: !bwrapWorks && "bwrap unavailable" }, () => {
	const check = spawnSync(process.execPath, [
		"--input-type=module", "-e",
		'import { validateSandbox } from "./dist/engine/sandbox.js"; await validateSandbox({ type: "bwrap" });',
	], { cwd: process.cwd(), env: { ...process.env, IRIS_API_TOKEN: "test-token", IRIS_WEBUI_PORT: "0" }, encoding: "utf8" });
	assert.equal(check.status, 0, check.stderr);
});

test("bwrap mode refuses an enabled unauthenticated web UI", () => {
	const env = { ...process.env, IRIS_API_TOKEN: "test-token", IRIS_WEBUI_PORT: "3001" };
	delete env.IRIS_WEBUI_PASSWORD;
	const check = spawnSync(process.execPath, [
		"--input-type=module", "-e",
		'import { validateSandbox } from "./dist/engine/sandbox.js"; await validateSandbox({ type: "bwrap" });',
	], { cwd: process.cwd(), env, encoding: "utf8" });
	assert.equal(check.status, 1);
	assert.match(check.stderr, /requires IRIS_WEBUI_PASSWORD/);
});

test("createExecutor requires dirs for bwrap", () => {
	assert.throws(() => createExecutor({ type: "bwrap" }, "tg-1"), /requires workspace and channel dirs/);
});

test("bwrap executor keeps host paths", () => {
	const { workspaceDir, executor } = setup();
	assert.equal(executor.getWorkspacePath(workspaceDir), workspaceDir);
	rmSync(workspaceDir, { recursive: true, force: true });
});

test("bwrap executor isolates the channel dir", { skip: !bwrapWorks && "bwrap unavailable" }, async () => {
	const { workspaceDir, channelDir, otherDir, executor } = setup();
	try {
		const pwd = await executor.exec("pwd");
		assert.equal(pwd.stdout.trim(), channelDir);

		const write = await executor.exec("echo hi > out.txt && cat out.txt");
		assert.equal(write.code, 0);
		assert.equal(readFileSync(join(channelDir, "out.txt"), "utf8"), "hi\n");

		const other = await executor.exec(`cat ${join(otherDir, "secret.txt")}`);
		assert.notEqual(other.code, 0);

		const skill = await executor.exec(`cat ${join(workspaceDir, "skills", "s.md")}`);
		assert.equal(skill.stdout, "skill");
		const skillWrite = await executor.exec(`touch ${join(workspaceDir, "skills", "x")}`);
		assert.notEqual(skillWrite.code, 0);

		const usr = await executor.exec("touch /usr/iris-bwrap-test");
		assert.notEqual(usr.code, 0);
		assert.equal(existsSync("/usr/iris-bwrap-test"), false);

		process.env.IRIS_BWRAP_TEST_TOKEN = "leak";
		const env = await executor.exec('echo "[$IRIS_BWRAP_TEST_TOKEN]"');
		delete process.env.IRIS_BWRAP_TEST_TOKEN;
		assert.equal(env.stdout.trim(), "[]");
	} finally {
		rmSync(workspaceDir, { recursive: true, force: true });
	}
});

// #297: the current turn's users/<userId>/ dir is writable, only while set,
// and never another user's.
test("bwrap executor binds only the current user's memory dir", { skip: !bwrapWorks && "bwrap unavailable" }, async () => {
	const { workspaceDir, executor } = setup();
	const adaDir = join(workspaceDir, "users", "ada");
	const bobDir = join(workspaceDir, "users", "bob");
	mkdirSync(bobDir, { recursive: true });
	writeFileSync(join(bobDir, "MEMORY.md"), "bob private");
	try {
		executor.setUserDir(adaDir);
		const write = await executor.exec(`echo tea > ${join(adaDir, "MEMORY.md")}`);
		assert.equal(write.code, 0, write.stderr);
		assert.equal(readFileSync(join(adaDir, "MEMORY.md"), "utf8"), "tea\n");

		const peek = await executor.exec(`cat ${join(bobDir, "MEMORY.md")}`);
		assert.notEqual(peek.code, 0);

		executor.setUserDir(undefined);
		const after = await executor.exec(`cat ${join(adaDir, "MEMORY.md")}`);
		assert.notEqual(after.code, 0);
	} finally {
		rmSync(workspaceDir, { recursive: true, force: true });
	}
});
