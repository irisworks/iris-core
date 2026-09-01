import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Executor } from "../sandbox.js";
import {
	appendAuditEntry,
	bashPolicyEnabled,
	classifyCommand,
	isConfirmedByHuman,
	recordConfirmationRequest,
	resolveAuditLogPath,
} from "./bash-policy.js";
import { persistFullOutput } from "./full-output-store.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateForToolOutput, type TruncationResult } from "./truncate.js";

const bashSchema = Type.Object({
	label: Type.String({ description: "Brief description of what this command does (shown to user)" }),
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 300)" })),
});

interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputId?: string;
}

export interface BashPolicyOptions {
	channelId: string;
	channelDir: string;
	workspaceDir: string;
}

const CONFIRM_MESSAGE =
	"This command was blocked by the bash policy layer because it is destructive. " +
	"Do NOT retry it yet. Ask the user in your reply to explicitly confirm they want this command run, " +
	"and end your turn. Only if the user replies with an explicit approval (yes/approve) may you re-run " +
	"the exact same command in your next turn.";

export function createBashTool(executor: Executor, policy?: BashPolicyOptions, channelDir?: string): AgentTool<typeof bashSchema> {
	const auditLogPath = policy ? resolveAuditLogPath(policy.workspaceDir) : undefined;
	// Full-output persistence (#159) is independent of the bash-policy gate
	// (which requires both channelId AND channelDir): a caller that supplies
	// channelDir without channelId still gets output persisted where
	// read_full can find it, instead of silently falling back to tmpdir.
	const persistDir = channelDir ?? policy?.channelDir;

	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved and retrievable with read_full(id). Optionally provide a timeout in seconds.`,
		parameters: bashSchema,
		execute: async (
			_toolCallId: string,
			{ command, timeout = 300 }: { label: string; command: string; timeout?: number },
			signal?: AbortSignal,
		) => {
			const audit = (decision: "executed" | "denied" | "confirmation-required" | "confirmed", exitCode?: number | null): void => {
				if (!policy || !auditLogPath) return;
				appendAuditEntry(auditLogPath, {
					channelId: policy.channelId,
					command,
					decision,
					exitCode: exitCode ?? null,
				});
			};

			// Policy layer (issue #131): hard refusals, then confirmation-gated
			// destructive commands. Pattern matching only catches accidents and
			// low-effort injection — it is not a security boundary (docs/bash-policy.md).
			const enforcementOn = Boolean(policy) && bashPolicyEnabled();
			if (enforcementOn && policy) {
				const decision = classifyCommand(command);
				if (decision.action === "deny") {
					audit("denied");
					throw new Error(`Command refused by bash policy: ${decision.reason}. This command cannot be run.`);
				}
				if (decision.action === "confirm") {
					if (isConfirmedByHuman(policy.channelId, command, policy.channelDir)) {
						audit("confirmed");
					} else {
						recordConfirmationRequest(policy.channelId, command);
						audit("confirmation-required");
						throw new Error(`${CONFIRM_MESSAGE} (reason: ${decision.reason})`);
					}
				}
			}

			let result;
			try {
				result = await executor.exec(command, { timeout, signal });
			} catch (err) {
				audit("executed", null);
				throw err;
			}
			audit("executed", result.code);
			let output = "";
			if (result.stdout) output += result.stdout;
			if (result.stderr) {
				if (output) output += "\n";
				output += result.stderr;
			}

			// For large JSON output, prefer a schema-aware structural summary over
			// blind tail truncation so the model still sees keys/shape and sample
			// values instead of an arbitrarily cut-off blob.
			const truncation = truncateForToolOutput(output, { direction: "tail" });

			// Persist the full output whenever truncation occurred (whether by
			// lines, bytes, or structural summarization) so the notices below can
			// always point at a way to retrieve it (#159).
			const fullOutputId = truncation.shouldPersistFull ? persistFullOutput(persistDir, output) : undefined;

			let outputText = truncation.content || "(no output)";

			// Build details with truncation info
			let details: BashToolDetails | undefined;

			if (truncation.truncated) {
				details = {
					truncation,
					fullOutputId,
				};

				const fullOutputNotice = `Full output saved, use read_full("${fullOutputId}") to see the rest`;

				if (truncation.truncatedBy === "structure") {
					outputText += `\n\n[Output is JSON (${formatSize(truncation.totalBytes)}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit): showing structural summary (keys/shape and sample values) instead of raw output. ${fullOutputNotice}]`;
				} else if (truncation.lastLinePartial) {
					// Edge case: last line alone > 50KB
					const endLine = truncation.totalLines;
					const lastLineSize = formatSize(Buffer.byteLength(output.split("\n").pop() || "", "utf-8"));
					outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). ${fullOutputNotice}]`;
				} else {
					// Build actionable notice
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;

					if (truncation.truncatedBy === "lines") {
						outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. ${fullOutputNotice}]`;
					} else {
						outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). ${fullOutputNotice}]`;
					}
				}
			}

			if (result.code !== 0) {
				throw new Error(`${outputText}\n\nCommand exited with code ${result.code}`.trim());
			}

			return { content: [{ type: "text", text: outputText }], details };
		},
	};
}
