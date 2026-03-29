import { connect } from "node:net";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
	type BashToolDetails,
	type BashToolInput,
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type EditToolDetails,
	type EditToolInput,
	type ExtensionAPI,
	type ReadToolDetails,
	type ReadToolInput,
	type WriteToolInput,
} from "@mariozechner/pi-coding-agent";
import type { SubagentToolName, SubagentToolRequest, SubagentToolResponse } from "../types.js";

const TOOL_SOCKET_ENV = "MOM_SUBAGENT_TOOL_SOCKET";
const ACTIVE_TOOLS_ENV = "MOM_SUBAGENT_ACTIVE_TOOLS";

function getToolSocketPath(): string {
	const socketPath = process.env[TOOL_SOCKET_ENV];
	if (!socketPath) {
		throw new Error(`${TOOL_SOCKET_ENV} is not set`);
	}
	return socketPath;
}

function parseActiveTools(): string[] {
	const raw = process.env[ACTIVE_TOOLS_ENV];
	if (!raw) {
		return ["read", "bash", "edit", "write"];
	}
	const values = raw
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	return values.length > 0 ? values : ["read", "bash", "edit", "write"];
}

async function callBridge<TDetails>(
	toolName: SubagentToolName,
	toolCallId: string,
	input: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<AgentToolResult<TDetails>> {
	const socketPath = getToolSocketPath();
	const request: SubagentToolRequest = {
		id: `${toolCallId}-${Date.now()}`,
		toolCallId,
		toolName,
		input,
	};

	return new Promise<AgentToolResult<TDetails>>((resolve, reject) => {
		const socket = connect({ path: socketPath });
		socket.setEncoding("utf8");
		let buffer = "";
		let completed = false;

		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort);
		};

		const finish = (fn: () => void) => {
			if (completed) return;
			completed = true;
			cleanup();
			try {
				socket.end();
			} catch {
				// ignore
			}
			fn();
		};

		const onAbort = () => {
			try {
				socket.destroy();
			} catch {
				// ignore
			}
			finish(() => reject(new Error("Operation aborted")));
		};

		if (signal) {
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}

		socket.on("connect", () => {
			socket.write(`${JSON.stringify(request)}\n`);
		});

		socket.on("data", (chunk) => {
			buffer += chunk;
			while (true) {
				const newlineIndex = buffer.indexOf("\n");
				if (newlineIndex === -1) break;
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				if (!line) continue;

				let response: SubagentToolResponse;
				try {
					response = JSON.parse(line) as SubagentToolResponse;
				} catch {
					finish(() => reject(new Error("Invalid subagent bridge response")));
					return;
				}

				if (response.id !== request.id) {
					continue;
				}

				if (response.success) {
					finish(() => resolve(response.result as AgentToolResult<TDetails>));
				} else {
					finish(() => reject(new Error(response.error)));
				}
				return;
			}
		});

		socket.on("error", (error) => {
			finish(() => reject(error));
		});

		socket.on("end", () => {
			if (!completed) {
				finish(() => reject(new Error("Subagent bridge connection closed before a response was received")));
			}
		});
	});
}

export default function registerSandboxTools(pi: ExtensionAPI): void {
	const cwd = process.cwd();

	const readDefinition = createReadToolDefinition(cwd);
	pi.registerTool({
		...readDefinition,
		execute: (toolCallId, input: ReadToolInput, signal) =>
			callBridge<ReadToolDetails | undefined>("read", toolCallId, input, signal),
	});

	const bashDefinition = createBashToolDefinition(cwd);
	pi.registerTool({
		...bashDefinition,
		execute: (toolCallId, input: BashToolInput, signal) =>
			callBridge<BashToolDetails | undefined>("bash", toolCallId, input, signal),
	});

	const editDefinition = createEditToolDefinition(cwd);
	pi.registerTool({
		...editDefinition,
		execute: (toolCallId, input: EditToolInput, signal) =>
			callBridge<EditToolDetails | undefined>("edit", toolCallId, input, signal),
	});

	const writeDefinition = createWriteToolDefinition(cwd);
	pi.registerTool({
		...writeDefinition,
		execute: (toolCallId, input: WriteToolInput, signal) => callBridge<undefined>("write", toolCallId, input, signal),
	});

	pi.on("session_start", async () => {
		const requestedActiveTools = parseActiveTools();
		const availableTools = pi
			.getAllTools()
			.map((tool) => tool.name)
			.sort();
		console.error(`[mom-subagent] available tools: ${availableTools.join(", ")}`);
		console.error(`[mom-subagent] requested active tools: ${requestedActiveTools.join(", ")}`);
		pi.setActiveTools(requestedActiveTools);
		console.error(`[mom-subagent] active tools after filter: ${pi.getActiveTools().join(", ")}`);
	});
}
