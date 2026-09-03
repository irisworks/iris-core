import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Executor } from "../sandbox.js";
import { attachTool } from "./attach.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createReadFullTool } from "./read-full.js";
import { createReadTool } from "./read.js";
import { createTaskTool, isTasksEnabled, type TaskRunnerOptions } from "./task.js";
import { createWriteTool } from "./write.js";

export { setUploadFunction } from "./attach.js";
export { getTaskMaxMs, isTasksEnabled, runIsolatedTask } from "./task.js";
export type { TaskRunnerOptions } from "./task.js";

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
	/** Wires up the `task` tool (issue #253) when IRIS_TASKS_ENABLED is "true".
	 * Optional so tests and headless callers can omit it — with no `task`
	 * option, or with the flag unset/false, the returned tool array is
	 * byte-for-byte the same as before `task` existed. */
	task?: Omit<TaskRunnerOptions, "tools">;
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
	const baseTools: AgentTool<any>[] = [
		createReadTool(executor, options),
		createBashTool(executor, bashPolicy, options.channelDir),
		createEditTool(executor),
		createWriteTool(executor),
		attachTool,
		createReadFullTool({ channelDir: options.channelDir }),
	];

	if (!options.task || !isTasksEnabled()) {
		return baseTools;
	}

	// The inner task agent gets Iris's own tool array minus `task` itself —
	// omitted structurally (baseTools has no `task` entry yet), not via a
	// runtime recursion guard, so a task-spawning-a-task fork bomb can't happen.
	const taskTool = createTaskTool({ ...options.task, tools: baseTools });
	return [...baseTools, taskTool];
}
