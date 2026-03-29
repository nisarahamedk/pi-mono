import type { AgentTool, ThinkingLevel } from "@mariozechner/pi-agent-core";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { Executor, SandboxConfig } from "../sandbox.js";
import { launchSubagent } from "../subagents/launcher.js";
import type { SubagentRunResult } from "../subagents/types.js";

const subagentContextModeSchema = StringEnum(["fresh", "fork"] as const, {
	description: "Whether to run with a fresh child session or a fork of the current parent session",
	default: "fresh",
});

const subagentSchema = Type.Object({
	label: Type.Optional(
		Type.String({ description: "Brief description of what the subagent run is doing (shown to user)" }),
	),
	agent: Type.String({ description: "Workspace subagent name from .pi/agents/<name>.md" }),
	task: Type.String({ description: "Task to delegate to the child subagent" }),
	context: Type.Optional(subagentContextModeSchema),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the child pi process (defaults to workspace root)" }),
	),
	model: Type.Optional(Type.String({ description: "Optional model override for the child process" })),
});

interface CreateSubagentToolOptions {
	executor: Executor;
	sandboxConfig: SandboxConfig;
	workspaceDir: string;
	threadDir: string;
	sessionManager: {
		getSessionId(): string;
		getSessionFile(): string | undefined;
		getLeafId(): string | null;
	};
	getCurrentModel(): { provider: string; id: string } | undefined;
	getCurrentThinkingLevel(): ThinkingLevel | undefined;
	getInheritedExtensionPaths(): string[];
}

function formatSubagentResult(result: SubagentRunResult): string {
	const lines = [
		`Subagent ${result.agent} ${result.status}.`,
		`Run ID: ${result.runId}`,
		`Context: ${result.contextMode}`,
		`Summary: ${result.summary}`,
	];
	if (result.summaryTruncated && result.resultPath) {
		lines.push(`Summary truncated. Read ${result.resultPath} and inspect fullSummary for the complete child result.`);
	}
	if (result.error) {
		lines.push(`Error: ${result.error}`);
	}
	lines.push("Artifacts:");
	for (const artifact of result.artifacts) {
		lines.push(`- ${artifact}`);
	}
	return lines.join("\n");
}

export function createSubagentTool(options: CreateSubagentToolOptions): AgentTool<typeof subagentSchema> {
	let subagentQueue: Promise<void> = Promise.resolve();

	const runSequentially = async <T>(operation: () => Promise<T>): Promise<T> => {
		const previous = subagentQueue;
		let releaseQueue: (() => void) | undefined;
		subagentQueue = new Promise<void>((resolve) => {
			releaseQueue = resolve;
		});

		await previous;
		try {
			return await operation();
		} finally {
			releaseQueue?.();
		}
	};

	return {
		name: "subagent",
		label: "subagent",
		description:
			"Delegate a bounded task to a workspace subagent defined in .pi/agents/<name>.md. Supports fresh or forked child context and returns a summarized result with artifact paths.",
		parameters: subagentSchema,
		execute: async (
			_toolCallId: string,
			input: {
				label?: string;
				agent: string;
				task: string;
				context?: "fresh" | "fork";
				cwd?: string;
				model?: string;
			},
		) =>
			runSequentially(async () => {
				if ((process.env.MOM_SUBAGENT_DEPTH ?? "0") !== "0") {
					const result: SubagentRunResult = {
						status: "failed",
						agent: input.agent,
						runId: "blocked-depth",
						contextMode: input.context ?? "fresh",
						summary: "Nested subagent execution is disabled in v1.",
						error: "Subagents cannot launch subagents in v1",
						artifacts: [],
						logPath: "",
						resultPath: "",
						metaPath: "",
						eventsPath: "",
						contextPath: "",
						stderrPath: "",
					};
					return {
						content: [{ type: "text", text: formatSubagentResult(result) }],
						details: result,
					};
				}

				const result = await launchSubagent({
					executor: options.executor,
					sandboxConfig: options.sandboxConfig,
					workspaceDir: options.workspaceDir,
					threadDir: options.threadDir,
					parentSessionId: options.sessionManager.getSessionId(),
					parentSessionFile: options.sessionManager.getSessionFile(),
					parentLeafId: options.sessionManager.getLeafId(),
					parentModel: options.getCurrentModel(),
					parentThinkingLevel: options.getCurrentThinkingLevel(),
					agent: input.agent,
					task: input.task,
					contextMode: input.context ?? "fresh",
					cwd: input.cwd,
					model: input.model,
					inheritedExtensionPaths: options.getInheritedExtensionPaths(),
				});

				return {
					content: [{ type: "text", text: formatSubagentResult(result) }],
					details: result,
				};
			}),
	};
}
