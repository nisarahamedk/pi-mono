import { existsSync, unlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { Executor } from "../sandbox.js";
import { createBashTool } from "../tools/bash.js";
import { createEditTool } from "../tools/edit.js";
import { createReadTool } from "../tools/read.js";
import { createWriteTool } from "../tools/write.js";
import type { SubagentToolName, SubagentToolRequest, SubagentToolResponse } from "./types.js";

interface SubagentToolBridgeOptions {
	executor: Executor;
	socketPath: string;
}

interface SubagentToolBridgeHandle {
	socketPath: string;
	close(): Promise<void>;
}

interface BridgeToolResult {
	content: (TextContent | ImageContent)[];
	details?: unknown;
}

function sendJson(socket: Socket, obj: SubagentToolResponse): void {
	socket.write(`${JSON.stringify(obj)}\n`);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isToolName(value: unknown): value is SubagentToolName {
	return value === "read" || value === "bash" || value === "edit" || value === "write";
}

function parseRequest(line: string): SubagentToolRequest | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (!isObject(parsed)) return null;
	if (typeof parsed.id !== "string") return null;
	if (typeof parsed.toolCallId !== "string") return null;
	if (!isToolName(parsed.toolName)) return null;
	if (!isObject(parsed.input)) return null;
	return {
		id: parsed.id,
		toolCallId: parsed.toolCallId,
		toolName: parsed.toolName,
		input: parsed.input,
	};
}

export async function startSubagentToolBridge(options: SubagentToolBridgeOptions): Promise<SubagentToolBridgeHandle> {
	const { executor, socketPath } = options;
	const socketDir = socketPath.includes("/") ? socketPath.slice(0, socketPath.lastIndexOf("/")) : ".";
	await mkdir(socketDir, { recursive: true });
	if (existsSync(socketPath)) {
		unlinkSync(socketPath);
	}

	const readTool = createReadTool(executor);
	const bashTool = createBashTool(executor);
	const editTool = createEditTool(executor);
	const writeTool = createWriteTool(executor);

	const executeRequest = async (request: SubagentToolRequest, signal: AbortSignal): Promise<BridgeToolResult> => {
		switch (request.toolName) {
			case "read": {
				const input = request.input as { label?: string; path: string; offset?: number; limit?: number };
				return readTool.execute(request.toolCallId, { ...input, label: input.label ?? request.toolName }, signal);
			}
			case "bash": {
				const input = request.input as { label?: string; command: string; timeout?: number };
				return bashTool.execute(request.toolCallId, { ...input, label: input.label ?? request.toolName }, signal);
			}
			case "edit": {
				const input = request.input as { label?: string; path: string; oldText: string; newText: string };
				return editTool.execute(request.toolCallId, { ...input, label: input.label ?? request.toolName }, signal);
			}
			case "write": {
				const input = request.input as { label?: string; path: string; content: string };
				return writeTool.execute(request.toolCallId, { ...input, label: input.label ?? request.toolName }, signal);
			}
		}
	};

	const server: Server = createServer((socket) => {
		socket.setEncoding("utf8");
		let buffer = "";
		let handled = false;
		const abortController = new AbortController();

		const finishWithError = (requestId: string | undefined, error: string): void => {
			if (!socket.destroyed) {
				sendJson(socket, {
					id: requestId ?? "unknown",
					success: false,
					error,
				});
				socket.end();
			}
		};

		socket.on("close", () => {
			abortController.abort();
		});

		socket.on("data", (chunk) => {
			buffer += chunk;
			while (true) {
				const newlineIndex = buffer.indexOf("\n");
				if (newlineIndex === -1) break;
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				if (!line) continue;

				const request = parseRequest(line);
				if (!request) {
					finishWithError(undefined, "Invalid subagent tool request");
					return;
				}
				if (handled) {
					finishWithError(request.id, "Only one request per connection is supported");
					return;
				}
				handled = true;

				void (async () => {
					try {
						const result = await executeRequest(request, abortController.signal);
						if (!socket.destroyed) {
							sendJson(socket, { id: request.id, success: true, result });
							socket.end();
						}
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						finishWithError(request.id, message);
					}
				})();
			}
		});

		socket.on("error", () => {
			abortController.abort();
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => resolve());
	});

	return {
		socketPath,
		async close(): Promise<void> {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			if (existsSync(socketPath)) {
				unlinkSync(socketPath);
			}
		},
	};
}
