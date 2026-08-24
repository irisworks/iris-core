import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import * as log from "../log.js";

/**
 * Bash tool policy layer (issue #131): hard refusals, human confirmation for
 * destructive commands, and an append-only command audit log.
 *
 * Scope note: shell pattern-matching is NOT a security boundary — it is
 * trivially bypassed by an adversarial model or injected instruction. The real
 * boundary is the uid, systemd confinement, and network rules. This layer
 * catches accidents and low-effort injection, and gives operators forensics
 * via the audit log. See docs/bash-policy.md — do not oversell it.
 */

export interface PolicyDecision {
	action: "deny" | "confirm" | "allow";
	reason?: string;
}

/** `IRIS_BASH_POLICY=off` disables refusals and confirmations (audit stays on). */
export function bashPolicyEnabled(): boolean {
	return process.env.IRIS_BASH_POLICY !== "off";
}

// ── Hard refusals (no prompt) ────────────────────────────────────────────────

// Secret files. Negative lookahead keeps near-misses like `.env.example` or
// `secret.keyboard` allowed; a preceding boundary char avoids matching inside
// longer names (`my.env`).
const DENY_SECRET_FILE_PATTERNS: RegExp[] = [
	/(^|[^\w.-])\.env(?![\w.-])/,
	/(^|[^\w.-])secret\.key(?![\w.-])/,
	/(^|[^\w.-])secrets\.json\.enc(?![\w.-])/,
	/(^|[^\w.-])agents\.json(?![\w.-])/,
];

// Cloud metadata endpoints (AWS/GCP/Azure/Hetzner link-local metadata services).
const DENY_METADATA_PATTERNS: RegExp[] = [
	/169\.254\.169\.254/,
	/metadata\.google\.internal/i,
	/100\.100\.100\.100/,
];

// ── Confirmation required ────────────────────────────────────────────────────

// rm with force/recursive flags targeting / itself or top-level system dirs.
const CONFIRM_RM_ROOT = /\brm\b[^;&|\n]*\s(?:-[A-Za-z]*[rf][A-Za-z]*|--recursive|--force)\b[^;&|\n]*\s\/(?:\*|\s|$)/;
const TOP_LEVEL_DIRS = "(?:bin|boot|dev|etc|home|lib|opt|root|run|sbin|srv|sys|usr|var)";
const CONFIRM_RM_TOP_LEVEL = new RegExp(`\\brm\\b[^;&|\\n]*\\s(?:-[A-Za-z]*[rf][A-Za-z]*|--recursive|--force)\\b[^;&|\\n]*\\s\\/${TOP_LEVEL_DIRS}(?:\\/\\*|\\/\\s*$|\\s|$)`);

const CONFIRM_MKFS = /\bmkfs(\.\w+)?\b/;
const CONFIRM_DD_TO_DEVICE = /\bdd\b[^;&|\n]*\bof=\/dev\//;
const CONFIRM_TERRAFORM_DESTROY = /\bterraform\s+destroy\b/;

const GIT_PUSH_FORCE = /\bgit\s+push\b[^;&|\n]*(--force\b|--force-with-lease\b|\s-f\b|\s\+(?=\S))/;
const PROTECTED_BRANCH = /\b(origin\s+|upstream\s+)?(main|master|release\/[\w.-]+)\b/;

// Sensitive system files paired with something that writes to them — reading
// /etc/passwd stays allowed.
const SENSITIVE_SYSTEM_FILES = /(\/etc\/passwd\b|\bsudoers\b|\bauthorized_keys\b|\bsshd_config\b)/;
const WRITE_PRIMITIVE =
	/(>|>>|\btee\b|\bsed\b[^;&|\n]*\s-i\b|\bcp\b|\bmv\b|\btouch\b|\bchmod\b|\bchown\b|\bchgrp\b|\busermod\b|\buseradd\b|\buserdel\b|\bvisudo\b|\btruncate\b|\binstall\b)/;

const CONFIRM_SYSTEMCTL_IRIS = /\bsystemctl\s+(disable|mask)\b[^;&|\n]*\biris\.service\b/;

/**
 * Classify a command against the policy lists. Pure string matching — see the
 * scope note at the top of this file before trusting it with anything real.
 */
export function classifyCommand(command: string): PolicyDecision {
	for (const pattern of DENY_SECRET_FILE_PATTERNS) {
		if (pattern.test(command)) {
			return { action: "deny", reason: "command references a secret file (.env, secret.key, secrets.json.enc, agents.json)" };
		}
	}
	for (const pattern of DENY_METADATA_PATTERNS) {
		if (pattern.test(command)) {
			return { action: "deny", reason: "command targets a cloud instance metadata endpoint" };
		}
	}

	if (CONFIRM_RM_ROOT.test(command) || CONFIRM_RM_TOP_LEVEL.test(command)) {
		return { action: "confirm", reason: "recursive forced delete at filesystem root" };
	}
	if (CONFIRM_MKFS.test(command)) return { action: "confirm", reason: "filesystem format (mkfs)" };
	if (CONFIRM_DD_TO_DEVICE.test(command)) return { action: "confirm", reason: "raw write to a block device (dd of=/dev/*)" };
	if (CONFIRM_TERRAFORM_DESTROY.test(command)) return { action: "confirm", reason: "terraform destroy" };
	if (GIT_PUSH_FORCE.test(command)) {
		const pushPart = command.slice(command.indexOf("git push"));
		if (PROTECTED_BRANCH.test(pushPart)) {
			return { action: "confirm", reason: "force push to a protected branch" };
		}
	}
	if (SENSITIVE_SYSTEM_FILES.test(command) && WRITE_PRIMITIVE.test(command)) {
		return { action: "confirm", reason: "write to sensitive system/auth configuration" };
	}
	if (CONFIRM_SYSTEMCTL_IRIS.test(command)) {
		return { action: "confirm", reason: "disabling or masking iris.service" };
	}

	return { action: "allow" };
}

// ── Confirmation state (conversational approval across turns) ───────────────

interface PendingConfirmation {
	commandHash: string;
	requestedAt: number;
}

// Per channel: the last command that was held for confirmation. A repeat of
// the exact same command after an explicit human "yes" in the channel log is
// allowed once. In-memory by design — a restart clears pending requests and
// the model must simply ask again.
const pendingConfirmations = new Map<string, PendingConfirmation>();

function commandHash(command: string): string {
	return createHash("sha256").update(command).digest("hex").slice(0, 16);
}

/** Record that a command was held for confirmation in this channel. */
export function recordConfirmationRequest(channelId: string, command: string): void {
	pendingConfirmations.set(channelId, { commandHash: commandHash(command), requestedAt: Date.now() });
}

/**
 * True when the model re-runs exactly the command that was previously held in
 * this channel AND a human (non-bot) message posted to the channel log since
 * then matches an affirmation. Consumes the grant on success.
 */
export function isConfirmedByHuman(channelId: string, command: string, channelDir: string): boolean {
	const pending = pendingConfirmations.get(channelId);
	if (!pending || pending.commandHash !== commandHash(command)) return false;
	if (!hasHumanAffirmationSince(channelDir, pending.requestedAt)) return false;
	pendingConfirmations.delete(channelId);
	return true;
}

const AFFIRMATION_RE =
	/^\s*(yes|yep|yeah|y|approve|approved|approving|confirm|confirmed|go ahead|goahead|proceed|ok|okay|do it|run it|sounds good|lgtm|sure|allowed|granted)\b/i;

/**
 * Scan <channelDir>/log.jsonl for a non-bot message recorded after `sinceMs`
 * whose text starts with an affirmation. ANY affirming message since the
 * request counts — a later unrelated reply does not revoke an earlier "yes".
 * Fails closed: any read/parse error means "no affirmation".
 */
export function hasHumanAffirmationSince(channelDir: string, sinceMs: number): boolean {
	try {
		const logPath = join(channelDir, "log.jsonl");
		if (!existsSync(logPath)) return false;
		const lines = readFileSync(logPath, "utf-8").split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i].trim();
			if (!line) continue;
			let entry: { date?: string; text?: string; isBot?: boolean };
			try {
				entry = JSON.parse(line) as typeof entry;
			} catch {
				continue;
			}
			const entryMs = entry.date ? Date.parse(entry.date) : NaN;
			// Strictly earlier entries predate the request; same-millisecond
			// timestamps count as "after" so a fast reply isn't missed.
			if (!Number.isFinite(entryMs) || entryMs < sinceMs) continue;
			if (entry.isBot) continue;
			if (AFFIRMATION_RE.test(entry.text ?? "")) return true;
		}
		return false;
	} catch {
		return false;
	}
}

// ── Append-only audit log ────────────────────────────────────────────────────

export interface AuditEntry {
	channelId: string;
	command: string;
	decision: "executed" | "denied" | "confirmation-required" | "confirmed";
	exitCode?: number | null;
}

export function resolveAuditLogPath(workspaceDir: string): string {
	return process.env.IRIS_BASH_AUDIT_FILE || join(workspaceDir, "meta", "bash-audit.log");
}

/**
 * Append one JSONL entry to the audit log. Always opens in append mode ('a')
 * and never rewrites existing content — tamper resistance comes from the
 * deployment setup (root-owned directory + `chattr +a`, see docs/bash-policy.md),
 * but even without it this writer must never truncate. Failures are logged and
 * swallowed: auditing must not break command execution.
 */
export function appendAuditEntry(logPath: string, entry: AuditEntry): void {
	try {
		// The meta/ (or custom) parent may not exist on first use — create it once
		// here rather than failing the very command that needed auditing.
		mkdirSync(dirname(logPath), { recursive: true });
		appendFileSync(logPath, `${JSON.stringify({ date: new Date().toISOString(), ...entry })}\n`, { flag: "a" });
	} catch (err) {
		log.logWarning("Failed to append bash audit entry", err instanceof Error ? err.message : String(err));
	}
}
