// Tests for the bash tool policy layer (#131).
// Requires `npm run build` first (tests import ../dist/*.js).

import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	appendAuditEntry,
	bashPolicyEnabled,
	classifyCommand,
	hasHumanAffirmationSince,
	isConfirmedByHuman,
	recordConfirmationRequest,
	resolveAuditLogPath,
} from "../dist/engine/tools/bash-policy.js";
import { createBashTool } from "../dist/engine/tools/bash.js";

function makeTempDir(prefix) {
	return mkdtempSync(join(tmpdir(), `iris-bash-policy-${prefix}-`));
}

function fakeExecutor(result = { stdout: "ok\n", stderr: "", code: 0 }) {
	const calls = [];
	return {
		calls,
		exec: async (command) => {
			calls.push(command);
			if (result.reject) throw result.reject;
			return result;
		},
		getWorkspacePath: (p) => p,
	};
}

async function runBash(tool, command) {
	return tool.execute("call-1", { label: "test", command }, undefined);
}

// ── Hard refusals ────────────────────────────────────────────────────────────

const DENIED = [
	["secret .env by absolute path", "cat /iris/.env"],
	["bare .env", "cat .env"],
	["quoted path to .env", "head -50 '/iris/.env'"],
	["secret.key", "cat /iris/secret.key"],
	["secrets.json.enc", "cat /iris/secrets.json.enc"],
	["agents.json", "jq . agents.json"],
	["AWS metadata endpoint", "curl -s http://169.254.169.254/latest/meta-data/iam/security-credentials/"],
	["GCP metadata endpoint", "curl -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/token"],
];

for (const [name, cmd] of DENIED) {
	test(`classify: denied — ${name}`, () => {
		assert.equal(classifyCommand(cmd).action, "deny");
	});
}

const DENY_NEAR_MISS_ALLOWED = [
	[".env.example is not .env", "cat .env.example"],
	[".envrc is not .env", "source .envrc"],
	["my.env is not .env", "cat my.env"],
	["agents.json.bak is not agents.json", "git diff agents.json.bak"],
	["secret.keyboard typo", "echo secret.keyboard"],
	["loopback address that isn't metadata", "ping 169.254.1.1"],
];

for (const [name, cmd] of DENY_NEAR_MISS_ALLOWED) {
	test(`classify: allowed near-miss — ${name}`, () => {
		assert.equal(classifyCommand(cmd).action, "allow");
	});
}

// ── Confirmation required ────────────────────────────────────────────────────

const CONFIRMED = [
	["rm -rf /", "rm -rf /"],
	["sudo rm -rf /*", "sudo rm -rf /*"],
	["rm -fr top-level dir", "rm -fr /etc"],
	["long-form flags on trailing-slash dir", "rm --recursive --force /usr/"],
	["mkfs", "mkfs.ext4 /dev/sda1"],
	["bare mkfs", "mkfs /dev/sdb"],
	["dd to block device", "dd if=/dev/zero of=/dev/sda bs=1M"],
	["terraform destroy", "terraform destroy -auto-approve"],
	["force push to main", "git push --force origin main"],
	["short force flag to master", "git push -f origin master"],
	["force-with-lease to protected branch", "git push --force-with-lease upstream release/1.0"],
	["plus-refspec force push to main", "git push origin +main"],
	["plus-refspec force push to full main ref", "git push origin +refs/heads/main"],
	["append to /etc/passwd", "echo 'h:x:0:0::/root:/bin/bash' >> /etc/passwd"],
	["chmod on sudoers", "sudo chmod 777 /etc/sudoers"],
	["sed -i on sshd_config", "sed -i 's/#PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config"],
	["overwrite authorized_keys", "echo 'ssh-ed25519 AAAA' > ~/.ssh/authorized_keys"],
	["systemctl disable iris.service", "systemctl disable iris.service"],
	["systemctl mask iris.service with sudo", "sudo systemctl mask iris.service"],
];

for (const [name, cmd] of CONFIRMED) {
	test(`classify: confirmation required — ${name}`, () => {
		assert.equal(classifyCommand(cmd).action, "confirm");
	});
}

const CONFIRM_NEAR_MISS_ALLOWED = [
	["rm -rf in workspace subdir", "rm -rf ./build"],
	["rm -rf under /tmp", "rm -rf /tmp/scratch/foo"],
	["rm -rf under a home subdir", "rm -rf /home/user/project/build"],
	["plain rm of a file", "rm old.log"],
	["recursive rm of a relative dir", "rm -r src/cache"],
	["force push to a feature branch", "git push --force origin feature-x"],
	["plus-refspec force push to a feature branch", "git push origin +feature-x"],
	["normal push to main", "git push origin main"],
	["reading /etc/passwd is fine", "cat /etc/passwd | wc -l"],
	["grep on sudoers without write verb", "grep iris /etc/sudoers"],
	["systemctl status is fine", "systemctl status iris.service"],
	["systemctl restart is fine", "systemctl restart iris.service"],
	["terraform plan is fine", "terraform plan -out=tfplan"],
	["dd to a regular file", "dd if=input.img of=./output.img bs=1M"],
];

for (const [name, cmd] of CONFIRM_NEAR_MISS_ALLOWED) {
	test(`classify: allowed near-miss — ${name}`, () => {
		assert.equal(classifyCommand(cmd).action, "allow");
	});
}

test("classify: empty and trivial commands are allowed", () => {
	assert.equal(classifyCommand("").action, "allow");
	assert.equal(classifyCommand("ls -la").action, "allow");
});

// ── Policy toggle ────────────────────────────────────────────────────────────

test("bashPolicyEnabled: on by default, off only for IRIS_BASH_POLICY=off", () => {
	const prev = process.env.IRIS_BASH_POLICY;
	try {
		delete process.env.IRIS_BASH_POLICY;
		assert.equal(bashPolicyEnabled(), true);
		process.env.IRIS_BASH_POLICY = "off";
		assert.equal(bashPolicyEnabled(), false);
		process.env.IRIS_BASH_POLICY = "on";
		assert.equal(bashPolicyEnabled(), true);
	} finally {
		if (prev === undefined) delete process.env.IRIS_BASH_POLICY;
		else process.env.IRIS_BASH_POLICY = prev;
	}
});

// ── Audit log ────────────────────────────────────────────────────────────────

test("audit log: appends JSONL entries and preserves existing content", () => {
	const dir = makeTempDir("audit");
	const logPath = join(dir, "bash-audit.log");
	writeFileSync(logPath, "preexisting line kept\n");

	appendAuditEntry(logPath, { channelId: "tg-1", command: "ls", decision: "executed", exitCode: 0 });
	appendAuditEntry(logPath, { channelId: "tg-1", command: "cat /iris/.env", decision: "denied", exitCode: null });

	const lines = readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
	assert.equal(lines.length, 3);
	assert.equal(lines[0], "preexisting line kept");
	const entry = JSON.parse(lines[2]);
	assert.equal(entry.command, "cat /iris/.env");
	assert.equal(entry.decision, "denied");
	assert.ok(entry.date);
	rmSync(dir, { recursive: true, force: true });
});

test("audit log: never throws, even when the target path is unwritable", () => {
	// A regular file used as a directory prefix — parent creation fails (ENOTDIR).
	const dir = makeTempDir("audit-bad");
	const blocker = join(dir, "blocker");
	writeFileSync(blocker, "");
	const bogus = join(blocker, "sub", "bash-audit.log");
	assert.doesNotThrow(() => appendAuditEntry(bogus, { channelId: "x", command: "ls", decision: "executed", exitCode: 0 }));
	rmSync(dir, { recursive: true, force: true });
});

test("audit log path: IRIS_BASH_AUDIT_FILE overrides the default", () => {
	const prev = process.env.IRIS_BASH_AUDIT_FILE;
	try {
		delete process.env.IRIS_BASH_AUDIT_FILE;
		assert.equal(resolveAuditLogPath("/iris/data"), "/iris/data/meta/bash-audit.log");
		process.env.IRIS_BASH_AUDIT_FILE = "/var/log/iris/bash-audit.log";
		assert.equal(resolveAuditLogPath("/iris/data"), "/var/log/iris/bash-audit.log");
	} finally {
		if (prev === undefined) delete process.env.IRIS_BASH_AUDIT_FILE;
		else process.env.IRIS_BASH_AUDIT_FILE = prev;
	}
});

// ── Conversational confirmation loop ─────────────────────────────────────────

function appendLogEntry(channelDir, entry) {
	mkdirSync(channelDir, { recursive: true });
	appendFileSync(join(channelDir, "log.jsonl"), `${JSON.stringify({ date: new Date().toISOString(), ...entry })}\n`);
}

test("confirmation: requires an exact-command match plus human affirmation", () => {
	const channelDir = makeTempDir("confirm");
	const channelId = "tg-confirm-1";
	const command = "rm -rf /tmp/bigthing";

	recordConfirmationRequest(channelId, command);
	assert.equal(isConfirmedByHuman(channelId, command, channelDir), false, "no affirmation yet");

	// A different command must not consume the request.
	assert.equal(isConfirmedByHuman(channelId, "rm -rf /tmp/other", channelDir), false);

	appendLogEntry(channelDir, { user: "U123", text: "yes go ahead", isBot: false });
	assert.equal(isConfirmedByHuman(channelId, command, channelDir), true, "approved after human yes");

	// Grant is single-use.
	assert.equal(isConfirmedByHuman(channelId, command, channelDir), false);
	rmSync(channelDir, { recursive: true, force: true });
});

test("confirmation: bot messages and non-affirmations don't unlock", () => {
	const channelDir = makeTempDir("confirm-bot");
	const channelId = "tg-confirm-2";
	const command = "terraform destroy";

	recordConfirmationRequest(channelId, command);
	appendLogEntry(channelDir, { user: "iris", text: "yes", isBot: true });
	assert.equal(isConfirmedByHuman(channelId, command, channelDir), false, "bot yes doesn't count");

	appendLogEntry(channelDir, { user: "U123", text: "what are you doing?", isBot: false });
	assert.equal(isConfirmedByHuman(channelId, command, channelDir), false, "non-affirmation doesn't count");

	appendLogEntry(channelDir, { user: "U123", text: "nah skip it", isBot: false });
	assert.equal(isConfirmedByHuman(channelId, command, channelDir), false);
	rmSync(channelDir, { recursive: true, force: true });
});

test("confirmation: an affirming reply counts even if the human keeps chatting after it", () => {
	const channelDir = makeTempDir("confirm-chatter");
	const channelId = "tg-confirm-3";
	const command = "terraform destroy";

	recordConfirmationRequest(channelId, command);
	appendLogEntry(channelDir, { user: "U123", text: "yes", isBot: false });
	appendLogEntry(channelDir, { user: "iris", text: "Holding for confirmation.", isBot: true });
	appendLogEntry(channelDir, { user: "U123", text: "and also check the logs while you are at it", isBot: false });
	assert.equal(isConfirmedByHuman(channelId, command, channelDir), true, "earlier yes is not revoked by later chatter");
	rmSync(channelDir, { recursive: true, force: true });
});

test("affirmation scanner: fails closed on missing/broken logs", () => {
	assert.equal(hasHumanAffirmationSince(join(tmpdir(), "does-not-exist-xyz"), 0), false);
});

// ── Bash tool integration ────────────────────────────────────────────────────

test("bash tool: denied command never reaches the executor", async () => {
	const workspaceDir = makeTempDir("tool-deny");
	const executor = fakeExecutor();
	const tool = createBashTool(executor, { channelId: "tg-t", channelDir: workspaceDir, workspaceDir });

	await assert.rejects(() => runBash(tool, "cat /iris/.env"), /refused by bash policy/);
	assert.equal(executor.calls.length, 0);

	const auditLines = readFileSync(resolveAuditLogPath(workspaceDir), "utf-8").trim().split("\n");
	assert.equal(auditLines.length, 1);
	assert.equal(JSON.parse(auditLines[0]).decision, "denied");
	rmSync(workspaceDir, { recursive: true, force: true });
});

test("bash tool: destructive command blocked until confirmed via channel log", async () => {
	const workspaceDir = makeTempDir("tool-confirm");
	const executor = fakeExecutor();
	const tool = createBashTool(executor, { channelId: "tg-tc", channelDir: workspaceDir, workspaceDir });
	const command = "terraform destroy";

	await assert.rejects(() => runBash(tool, command), /blocked by the bash policy layer/);
	assert.equal(executor.calls.length, 0);

	// No affirmation yet — still blocked.
	await assert.rejects(() => runBash(tool, command), /blocked by the bash policy layer/);

	appendLogEntry(workspaceDir, { user: "U1", text: "yes, approved", isBot: false });
	await runBash(tool, command);
	assert.deepEqual(executor.calls, [command]);

	const auditLines = readFileSync(resolveAuditLogPath(workspaceDir), "utf-8").trim().split("\n");
	const decisions = auditLines.map((l) => JSON.parse(l).decision);
	assert.deepEqual(decisions, ["confirmation-required", "confirmation-required", "confirmed", "executed"]);
	rmSync(workspaceDir, { recursive: true, force: true });
});

test("bash tool: executed commands audited with exit code; aborts audited as null", async () => {
	const workspaceDir = makeTempDir("tool-exec");
	const executor = fakeExecutor({ stdout: "", stderr: "", code: 3 });
	const tool = createBashTool(executor, { channelId: "tg-te", channelDir: workspaceDir, workspaceDir });

	await assert.rejects(() => runBash(tool, "false"), /exited with code 3/);
	const failing = fakeExecutor({ reject: new Error("aborted") });
	const tool2 = createBashTool(failing, { channelId: "tg-te", channelDir: workspaceDir, workspaceDir });
	await assert.rejects(() => runBash(tool2, "sleep 100"), /aborted/);

	const entries = readFileSync(resolveAuditLogPath(workspaceDir), "utf-8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
	assert.equal(entries[0].exitCode, 3);
	assert.equal(entries[1].exitCode, null);
	rmSync(workspaceDir, { recursive: true, force: true });
});

test("bash tool: IRIS_BASH_POLICY=off disables enforcement but keeps auditing", async () => {
	const workspaceDir = makeTempDir("tool-off");
	const executor = fakeExecutor();
	const tool = createBashTool(executor, { channelId: "tg-to", channelDir: workspaceDir, workspaceDir });
	const prev = process.env.IRIS_BASH_POLICY;
	process.env.IRIS_BASH_POLICY = "off";
	try {
		await runBash(tool, "cat /iris/.env"); // would otherwise be refused
		assert.equal(executor.calls.length, 1);
		const auditLines = readFileSync(resolveAuditLogPath(workspaceDir), "utf-8").trim().split("\n");
		assert.equal(JSON.parse(auditLines[0]).decision, "executed");
	} finally {
		if (prev === undefined) delete process.env.IRIS_BASH_POLICY;
		else process.env.IRIS_BASH_POLICY = prev;
		rmSync(workspaceDir, { recursive: true, force: true });
	}
});

test("bash tool: no policy options means legacy behavior (no audit file)", async () => {
	const dir = makeTempDir("tool-nopolicy");
	const executor = fakeExecutor();
	const tool = createBashTool(executor);
	await runBash(tool, "cat /iris/.env");
	assert.equal(executor.calls.length, 1);
	assert.equal(existsSync(join(dir, "meta", "bash-audit.log")), false);
	rmSync(dir, { recursive: true, force: true });
});
