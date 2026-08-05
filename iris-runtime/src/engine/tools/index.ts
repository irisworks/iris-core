import type { AgentTool } from "@mariozechner/pi-agent-core";
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
}

export function createIrisTools(executor: Executor, options: IrisToolsOptions): AgentTool<any>[] {
	return [
		createReadTool(executor, options),
		createBashTool(executor),
		createEditTool(executor),
		createWriteTool(executor),
		attachTool,
	];
}
