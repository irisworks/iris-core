import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
	compressJsonStructure,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateTail,
} from "./truncate.js";

/**
 * Generate a unique temp file path for bash output
 */
function getTempFilePath(): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `iris-bash-${id}.log`);
}

const bashSchema = Type.Object({
	label: Type.String({ description: "Brief description of what this command does (shown to user)" }),
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 300)" })),
});

interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
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

export function createBashTool(executor: Executor, policy?: BashPolicyOptions): AgentTool<typeof bashSchema> {
	const auditLogPath = policy ? resolveAuditLogPath(policy.workspaceDir) : undefined;

	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
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

			// Track output for potential temp file writing
			let tempFilePath: string | undefined;
			let tempFileStream: ReturnType<typeof createWriteStream> | undefined;

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
			const truncation = compressJsonStructure(output) ?? truncateTail(output);

			// Write to temp file whenever truncation occurred (whether by lines,
			// bytes, or structural summarization) so the notices below can always
			// point at the full output.
			if (truncation.truncated) {
				tempFilePath = getTempFilePath();
				tempFileStream = createWriteStream(tempFilePath);
				tempFileStream.write(output);
				tempFileStream.end();
			}

			let outputText = truncation.content || "(no output)";

			// Build details with truncation info
			let details: BashToolDetails | undefined;

			if (truncation.truncated) {
				details = {
					truncation,
					fullOutputPath: tempFilePath,
				};

				if (truncation.truncatedBy === "structure") {
					outputText += `\n\n[Output is JSON (${formatSize(truncation.totalBytes)}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit): showing structural summary (keys/shape and sample values) instead of raw output. Full output: ${tempFilePath}]`;
				} else if (truncation.lastLinePartial) {
					// Edge case: last line alone > 50KB
					const endLine = truncation.totalLines;
					const lastLineSize = formatSize(Buffer.byteLength(output.split("\n").pop() || "", "utf-8"));
					outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${tempFilePath}]`;
				} else {
					// Build actionable notice
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;

					if (truncation.truncatedBy === "lines") {
						outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${tempFilePath}]`;
					} else {
						outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${tempFilePath}]`;
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
