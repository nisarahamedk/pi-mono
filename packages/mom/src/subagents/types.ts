import type { ImageContent, TextContent } from "@mariozechner/pi-ai";

export type SubagentContextMode = "fresh" | "fork";
export type SubagentRunStatus = "running" | "success" | "failed";
export type SubagentToolName = "read" | "bash" | "edit" | "write";

export interface SubagentAgentConfig {
	name: string;
	description: string;
	filePath: string;
	systemPrompt: string;
	model?: string;
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	tools?: string[];
}

export interface SubagentToolSuccessResponse {
	id: string;
	success: true;
	result: {
		content: (TextContent | ImageContent)[];
		details?: unknown;
	};
}

export interface SubagentToolErrorResponse {
	id: string;
	success: false;
	error: string;
}

export interface SubagentToolRequest {
	id: string;
	toolCallId: string;
	toolName: SubagentToolName;
	input: Record<string, unknown>;
}

export type SubagentToolResponse = SubagentToolSuccessResponse | SubagentToolErrorResponse;

export interface SubagentRunMeta {
	runId: string;
	agent: string;
	task: string;
	agentFilePath: string;
	parentSessionId: string;
	parentLeafId: string | null;
	contextMode: SubagentContextMode;
	requestedCwd: string;
	requestedModel?: string;
	requestedThinking?: string;
	startedAt: string;
	endedAt?: string;
	status: SubagentRunStatus;
	childSessionFile: string;
	eventsPath: string;
	stderrPath: string;
	resultPath: string;
	metaPath: string;
	artifacts: string[];
}

export interface PersistedSubagentRunResult {
	status: "success" | "failed";
	agent: string;
	runId: string;
	contextMode: SubagentContextMode;
	fullSummary: string;
	error?: string;
	artifacts: string[];
	logPath: string;
	resultPath: string;
	metaPath: string;
	eventsPath: string;
	contextPath: string;
	stderrPath: string;
}

export interface SubagentRunResult {
	status: "success" | "failed";
	agent: string;
	runId: string;
	contextMode: SubagentContextMode;
	summary: string;
	summaryTruncated?: boolean;
	error?: string;
	artifacts: string[];
	logPath: string;
	resultPath: string;
	metaPath: string;
	eventsPath: string;
	contextPath: string;
	stderrPath: string;
}
