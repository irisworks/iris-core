import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Executor } from "../sandbox.js";
import { attachTool } from "./attach.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export { setUploadFunction } from "./attach.js";

export interface IrisToolsOptions {
	/** Whether the active model's provider accepts image input. When false, the
	 * read tool tells the model an image was skipped instead of claiming success
	 * on a file whose image content pi-ai will silently strip before the request
	 * goes out (every provider module filters on model.input). */
	supportsImageInput: boolean;
	/** Host workspace root — the read tool discovers read-handlers from `<workspaceDir>/read-handlers/`. */
	workspaceDir: string;
	/** Channel/session identity — enables the bash policy layer + command audit
	 * log (#131). Optional so tests and headless callers can omit it. */
	channelId?: string;
	channelDir?: string;
}

export function createIrisTools(executor: Executor, options: IrisToolsOptions): AgentTool<any>[] {
	const bashPolicy =
		options.channelId && options.channelDir
			? {
					channelId: options.channelId,
					channelDir: options.channelDir,
					workspaceDir: options.workspaceDir,
				}
			: undefined;
	return [
		createReadTool(executor, options),
		createBashTool(executor, bashPolicy),
		createEditTool(executor),
		createWriteTool(executor),
		attachTool,
	];
}
