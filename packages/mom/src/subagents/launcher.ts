import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Message, TextContent } from "@mariozechner/pi-ai";
import { SessionManager, type SessionMessageEntry } from "@mariozechner/pi-coding-agent";
import type { Executor, SandboxConfig } from "../sandbox.js";
import { loadWorkspaceSubagent } from "./agents.js";
import { startSubagentToolBridge } from "./bridge.js";
import type {
	PersistedSubagentRunResult,
	SubagentContextMode,
	SubagentRunMeta,
	SubagentRunResult,
	SubagentRunStatus,
} from "./types.js";

interface ParentModelRef {
	provider: string;
	id: string;
}

export interface LaunchSubagentOptions {
	executor: Executor;
	sandboxConfig: SandboxConfig;
	workspaceDir: string;
	threadDir: string;
	parentSessionId: string;
	parentSessionFile?: string;
	parentLeafId: string | null;
	parentModel?: ParentModelRef;
	parentThinkingLevel?: ThinkingLevel;
	agent: string;
	task: string;
	contextMode: SubagentContextMode;
	cwd?: string;
	model?: string;
	inheritedExtensionPaths: string[];
}

interface ObservedChildState {
	lastAssistantText?: string;
	stopReason?: string;
	errorMessage?: string;
}

interface LastAssistantInfo {
	text: string;
	stopReason?: string;
	errorMessage?: string;
}

function getRepoRoot(): string {
	return fileURLToPath(new URL("../../../../", import.meta.url));
}

function getInternalSandboxToolsExtensionPath(): string {
	return fileURLToPath(new URL("./extensions/sandbox-tools.ts", import.meta.url));
}

function getTsxBinaryPath(repoRoot: string): string {
	return join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
}

function sanitizeRunIdPart(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

function dedupePaths(paths: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const path of paths) {
		if (!path || seen.has(path)) continue;
		seen.add(path);
		result.push(path);
	}
	return result;
}

function createRunId(agent: string): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${sanitizeRunIdPart(agent)}-${timestamp}-${suffix}`;
}

function resolveChildCwd(workspaceDir: string, cwdOverride: string | undefined): string {
	if (!cwdOverride || cwdOverride.trim().length === 0) {
		return workspaceDir;
	}
	if (cwdOverride === "/workspace") {
		return workspaceDir;
	}
	if (cwdOverride.startsWith("/workspace/")) {
		return resolve(workspaceDir, cwdOverride.slice("/workspace/".length));
	}
	if (cwdOverride.startsWith("/")) {
		return cwdOverride;
	}
	return resolve(workspaceDir, cwdOverride);
}

function normalizeRelativePathForAgent(relativePath: string): string {
	return relativePath.split(sep).join(posix.sep);
}

function toAgentVisiblePath(hostWorkspaceDir: string, agentWorkspaceDir: string, hostPath: string): string {
	const resolvedWorkspaceDir = resolve(hostWorkspaceDir);
	const resolvedHostPath = resolve(hostPath);
	const relativePath = relative(resolvedWorkspaceDir, resolvedHostPath);
	if (relativePath.startsWith("..") || relativePath === "..") {
		throw new Error(`Cannot expose host path outside workspace on subagent result surface: ${hostPath}`);
	}
	if (relativePath.length === 0) {
		return agentWorkspaceDir;
	}
	if (agentWorkspaceDir === resolvedWorkspaceDir) {
		return resolvedHostPath;
	}
	return posix.join(agentWorkspaceDir, normalizeRelativePathForAgent(relativePath));
}

function resolveRequestedChildCwd(agentWorkspaceDir: string, cwdOverride: string | undefined): string {
	if (!cwdOverride || cwdOverride.trim().length === 0) {
		return agentWorkspaceDir;
	}
	if (agentWorkspaceDir === "/workspace") {
		if (cwdOverride === "/workspace" || cwdOverride.startsWith("/workspace/")) {
			return cwdOverride;
		}
		if (cwdOverride.startsWith("/")) {
			return cwdOverride;
		}
		return posix.join(agentWorkspaceDir, normalizeRelativePathForAgent(cwdOverride));
	}
	if (cwdOverride.startsWith("/")) {
		return cwdOverride;
	}
	return resolve(agentWorkspaceDir, cwdOverride);
}

function parseTextContent(content: Message["content"]): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function readLastAssistantInfo(contextPath: string): LastAssistantInfo | undefined {
	if (!existsSync(contextPath)) {
		return undefined;
	}
	const sessionManager = SessionManager.open(contextPath);
	const entries = sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const messageEntry = entry as SessionMessageEntry;
		if (messageEntry.message.role !== "assistant") continue;
		const assistantMessage = messageEntry.message as AssistantMessage;
		return {
			text: parseTextContent(assistantMessage.content),
			stopReason: assistantMessage.stopReason,
			errorMessage: assistantMessage.errorMessage,
		};
	}
	return undefined;
}

function copyForkedSessionToContext(
	parentSessionFile: string,
	parentLeafId: string,
	runDir: string,
	contextPath: string,
): void {
	const branchedSessionManager = SessionManager.open(parentSessionFile, runDir);
	const branchedPath = branchedSessionManager.createBranchedSession(parentLeafId);
	if (!branchedPath) {
		throw new Error("Failed to create branched session file for subagent fork");
	}
	if (branchedPath !== contextPath) {
		renameSync(branchedPath, contextPath);
	}
}

function buildArtifacts(paths: string[]): string[] {
	return paths.filter((path) => existsSync(path));
}

function writeMeta(metaPath: string, meta: SubagentRunMeta): void {
	writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

function writeResult(resultPath: string, result: PersistedSubagentRunResult): void {
	writeFileSync(resultPath, JSON.stringify(result, null, 2));
}

function normalizeSummaryText(text: string | undefined, fallback: string): string {
	if (!text || text.trim().length === 0) {
		return fallback;
	}
	return text.replace(/\s+/g, " ").trim();
}

function truncateSummary(fullSummary: string): { summary: string; truncated: boolean } {
	return fullSummary.length > 280
		? { summary: `${fullSummary.slice(0, 277)}...`, truncated: true }
		: { summary: fullSummary, truncated: false };
}

function toDisplayResult(result: PersistedSubagentRunResult): SubagentRunResult {
	const { summary, truncated } = truncateSummary(result.fullSummary);
	return {
		status: result.status,
		agent: result.agent,
		runId: result.runId,
		contextMode: result.contextMode,
		summary,
		summaryTruncated: truncated || undefined,
		error: result.error,
		artifacts: result.artifacts,
		logPath: result.logPath,
		resultPath: result.resultPath,
		metaPath: result.metaPath,
		eventsPath: result.eventsPath,
		contextPath: result.contextPath,
		stderrPath: result.stderrPath,
	};
}

function updateObservedState(observed: ObservedChildState, line: string): void {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
		return;
	}
	const event = parsed as { type?: string; message?: unknown };
	if (event.type !== "message_end" || typeof event.message !== "object" || event.message === null) {
		return;
	}
	const message = event.message as {
		role?: string;
		content?: Message["content"];
		stopReason?: string;
		errorMessage?: string;
	};
	if (message.role !== "assistant" || message.content === undefined) {
		return;
	}
	observed.lastAssistantText = parseTextContent(message.content);
	observed.stopReason = message.stopReason;
	observed.errorMessage = message.errorMessage;
}

function createFailureResult(
	base: {
		agent: string;
		runId: string;
		contextMode: SubagentContextMode;
		contextPath: string;
		eventsPath: string;
		metaPath: string;
		resultPath: string;
		stderrPath: string;
	},
	fullSummary: string,
	error: string,
	artifacts: string[],
): PersistedSubagentRunResult {
	return {
		status: "failed",
		agent: base.agent,
		runId: base.runId,
		contextMode: base.contextMode,
		fullSummary,
		error,
		artifacts,
		logPath: base.contextPath,
		resultPath: base.resultPath,
		metaPath: base.metaPath,
		eventsPath: base.eventsPath,
		contextPath: base.contextPath,
		stderrPath: base.stderrPath,
	};
}

export async function launchSubagent(options: LaunchSubagentOptions): Promise<SubagentRunResult> {
	const agentConfig = loadWorkspaceSubagent(options.workspaceDir, options.agent);
	const runId = createRunId(agentConfig.name);
	const runDir = join(options.threadDir, "subagents", runId);
	const contextPath = join(runDir, "context.jsonl");
	const eventsPath = join(runDir, "events.jsonl");
	const stderrPath = join(runDir, "stderr.log");
	const metaPath = join(runDir, "meta.json");
	const resultPath = join(runDir, "result.json");
	const systemPromptPath = join(runDir, "system-prompt.md");
	const lastPromptPath = join(runDir, "last_prompt.jsonl");
	await mkdir(runDir, { recursive: true });
	writeFileSync(systemPromptPath, agentConfig.systemPrompt, "utf-8");
	writeFileSync(lastPromptPath, JSON.stringify({ systemPrompt: agentConfig.systemPrompt }, null, 2), "utf-8");

	const agentWorkspaceDir = options.executor.getWorkspacePath(options.workspaceDir);
	const requestedCwd = resolveRequestedChildCwd(agentWorkspaceDir, options.cwd);
	const childCwd = resolveChildCwd(options.workspaceDir, options.cwd);
	const agentFileAgentPath = toAgentVisiblePath(options.workspaceDir, agentWorkspaceDir, agentConfig.filePath);
	const contextAgentPath = toAgentVisiblePath(options.workspaceDir, agentWorkspaceDir, contextPath);
	const eventsAgentPath = toAgentVisiblePath(options.workspaceDir, agentWorkspaceDir, eventsPath);
	const stderrAgentPath = toAgentVisiblePath(options.workspaceDir, agentWorkspaceDir, stderrPath);
	const metaAgentPath = toAgentVisiblePath(options.workspaceDir, agentWorkspaceDir, metaPath);
	const resultAgentPath = toAgentVisiblePath(options.workspaceDir, agentWorkspaceDir, resultPath);
	const requestedModel =
		options.model ??
		agentConfig.model ??
		(options.parentModel ? `${options.parentModel.provider}/${options.parentModel.id}` : undefined);
	const requestedThinking = agentConfig.thinking ?? options.parentThinkingLevel;

	const baseMeta: SubagentRunMeta = {
		runId,
		agent: agentConfig.name,
		task: options.task,
		agentFilePath: agentFileAgentPath,
		parentSessionId: options.parentSessionId,
		parentLeafId: options.parentLeafId,
		contextMode: options.contextMode,
		requestedCwd,
		requestedModel,
		requestedThinking,
		startedAt: new Date().toISOString(),
		status: "running",
		childSessionFile: contextAgentPath,
		eventsPath: eventsAgentPath,
		stderrPath: stderrAgentPath,
		resultPath: resultAgentPath,
		metaPath: metaAgentPath,
		artifacts: [],
	};
	writeMeta(metaPath, baseMeta);

	const repoRoot = getRepoRoot();
	const tsxPath = getTsxBinaryPath(repoRoot);
	const piCliPath = join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
	const bridgeSocketPath = `/tmp/mom-subagent-${runId.slice(-24)}.sock`;
	const bridge = await startSubagentToolBridge({ executor: options.executor, socketPath: bridgeSocketPath });

	const artifactsBase = [contextPath, eventsPath, stderrPath, metaPath, systemPromptPath, lastPromptPath];
	const toAgentArtifactPaths = (paths: string[]): string[] =>
		paths.map((path) => toAgentVisiblePath(options.workspaceDir, agentWorkspaceDir, path));
	const resultBase = {
		agent: agentConfig.name,
		runId,
		contextMode: options.contextMode,
		contextPath: contextAgentPath,
		eventsPath: eventsAgentPath,
		metaPath: metaAgentPath,
		resultPath: resultAgentPath,
		stderrPath: stderrAgentPath,
	};

	try {
		if (options.contextMode === "fork") {
			if (!options.parentSessionFile) {
				const artifacts = buildArtifacts(artifactsBase);
				const result = createFailureResult(
					resultBase,
					"Subagent fork failed before launch.",
					"Parent session file is unavailable for forked subagent context",
					toAgentArtifactPaths([...artifacts, resultPath]),
				);
				writeResult(resultPath, result);
				writeMeta(metaPath, {
					...baseMeta,
					endedAt: new Date().toISOString(),
					status: "failed",
					artifacts: toAgentArtifactPaths([...artifacts, resultPath]),
				});
				return toDisplayResult(result);
			}
			if (!options.parentLeafId) {
				const artifacts = buildArtifacts(artifactsBase);
				const result = createFailureResult(
					resultBase,
					"Subagent fork failed before launch.",
					"Parent session has no current leaf to fork from",
					toAgentArtifactPaths([...artifacts, resultPath]),
				);
				writeResult(resultPath, result);
				writeMeta(metaPath, {
					...baseMeta,
					endedAt: new Date().toISOString(),
					status: "failed",
					artifacts: toAgentArtifactPaths([...artifacts, resultPath]),
				});
				return toDisplayResult(result);
			}
			copyForkedSessionToContext(options.parentSessionFile, options.parentLeafId, runDir, contextPath);
		}

		const childArgs = [
			piCliPath,
			"--mode",
			"json",
			"-p",
			"--session",
			contextPath,
			"--no-tools",
			"--no-extensions",
			"--system-prompt",
			systemPromptPath,
		];

		if (requestedModel) {
			childArgs.push("--model", requestedModel);
		}
		if (requestedThinking) {
			childArgs.push("--thinking", requestedThinking);
		}

		const inheritedExtensionPaths = dedupePaths([
			...options.inheritedExtensionPaths,
			getInternalSandboxToolsExtensionPath(),
		]);
		for (const extensionPath of inheritedExtensionPaths) {
			childArgs.push("--extension", extensionPath);
		}
		childArgs.push(options.task);

		const childEnv: NodeJS.ProcessEnv = {
			...process.env,
			MOM_SUBAGENT_DEPTH: "1",
			MOM_SUBAGENT_TOOL_SOCKET: bridge.socketPath,
			MOM_SUBAGENT_ACTIVE_TOOLS: (agentConfig.tools ?? ["read", "bash", "edit", "write"]).join(","),
			MOM_SUBAGENT_SANDBOX: options.sandboxConfig.type,
		};

		const stdoutStream = createWriteStream(eventsPath, { flags: "a" });
		const stderrStream = createWriteStream(stderrPath, { flags: "a" });
		const observed: ObservedChildState = {};
		let stdoutBuffer = "";

		const exitCode = await new Promise<number>((resolvePromise, rejectPromise) => {
			const child = spawn(tsxPath, childArgs, {
				cwd: childCwd,
				env: childEnv,
				stdio: ["ignore", "pipe", "pipe"],
				shell: false,
			});

			child.stdout.on("data", (chunk: Buffer) => {
				const text = chunk.toString("utf8");
				stdoutStream.write(text);
				stdoutBuffer += text;
				while (true) {
					const newlineIndex = stdoutBuffer.indexOf("\n");
					if (newlineIndex === -1) break;
					const line = stdoutBuffer.slice(0, newlineIndex).trim();
					stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
					if (!line) continue;
					updateObservedState(observed, line);
				}
			});

			child.stderr.on("data", (chunk: Buffer) => {
				stderrStream.write(chunk);
			});

			child.on("error", (error) => {
				rejectPromise(error);
			});

			child.on("close", (code) => {
				if (stdoutBuffer.trim().length > 0) {
					updateObservedState(observed, stdoutBuffer.trim());
				}
				resolvePromise(code ?? 0);
			});
		});

		await new Promise<void>((resolvePromise, rejectPromise) => {
			stdoutStream.end(() => resolvePromise());
			stdoutStream.on("error", rejectPromise);
		});
		await new Promise<void>((resolvePromise, rejectPromise) => {
			stderrStream.end(() => resolvePromise());
			stderrStream.on("error", rejectPromise);
		});

		const lastAssistant = readLastAssistantInfo(contextPath) ?? {
			text: observed.lastAssistantText ?? "",
			stopReason: observed.stopReason,
			errorMessage: observed.errorMessage,
		};

		const stderrText = existsSync(stderrPath) ? readFileSync(stderrPath, "utf-8").trim() : "";
		const hasAssistantResponse = lastAssistant.text.trim().length > 0 || lastAssistant.stopReason !== undefined;
		const status: SubagentRunStatus =
			exitCode === 0 &&
			lastAssistant.stopReason !== "error" &&
			lastAssistant.stopReason !== "aborted" &&
			hasAssistantResponse
				? "success"
				: "failed";
		const fullSummary =
			status === "success"
				? normalizeSummaryText(lastAssistant.text, "Subagent completed successfully.")
				: normalizeSummaryText(lastAssistant.errorMessage ?? stderrText, "Subagent failed.");
		const errorMessage =
			status === "failed"
				? lastAssistant.errorMessage ||
					stderrText ||
					(hasAssistantResponse ? "Subagent did not complete successfully" : "No child response captured")
				: undefined;

		const persistedResult: PersistedSubagentRunResult =
			status === "success"
				? {
						status: "success",
						agent: agentConfig.name,
						runId,
						contextMode: options.contextMode,
						fullSummary,
						artifacts: toAgentArtifactPaths([...buildArtifacts(artifactsBase), resultPath]),
						logPath: contextAgentPath,
						resultPath: resultAgentPath,
						metaPath: metaAgentPath,
						eventsPath: eventsAgentPath,
						contextPath: contextAgentPath,
						stderrPath: stderrAgentPath,
					}
				: createFailureResult(
						resultBase,
						fullSummary,
						errorMessage ?? "Subagent failed",
						toAgentArtifactPaths([...buildArtifacts(artifactsBase), resultPath]),
					);

		writeResult(resultPath, persistedResult);
		writeMeta(metaPath, {
			...baseMeta,
			endedAt: new Date().toISOString(),
			status,
			artifacts: toAgentArtifactPaths(buildArtifacts([...artifactsBase, resultPath])),
		});
		return toDisplayResult(persistedResult);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const result = createFailureResult(
			resultBase,
			"Subagent failed before completion.",
			message,
			toAgentArtifactPaths([...buildArtifacts(artifactsBase), resultPath]),
		);
		writeResult(resultPath, result);
		writeMeta(metaPath, {
			...baseMeta,
			endedAt: new Date().toISOString(),
			status: "failed",
			artifacts: toAgentArtifactPaths(buildArtifacts([...artifactsBase, resultPath])),
		});
		return toDisplayResult(result);
	} finally {
		await bridge.close();
	}
}
