import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import type { SubagentAgentConfig } from "./types.js";

interface SubagentFrontmatter extends Record<string, unknown> {
	name?: string;
	description?: string;
	model?: string;
	thinking?: string;
	tools?: string;
}

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function parseTools(tools: string | undefined): string[] | undefined {
	if (!tools) return undefined;
	const values = tools
		.split(",")
		.map((tool) => tool.trim())
		.filter((tool) => tool.length > 0);
	return values.length > 0 ? values : undefined;
}

export function loadWorkspaceSubagent(workspaceDir: string, agentName: string): SubagentAgentConfig {
	const filePath = join(workspaceDir, ".pi", "agents", `${agentName}.md`);
	if (!existsSync(filePath)) {
		throw new Error(`Subagent not found: ${filePath}`);
	}

	const content = readFileSync(filePath, "utf-8");
	const { frontmatter, body } = parseFrontmatter<SubagentFrontmatter>(content);

	if (!frontmatter.name || !frontmatter.description) {
		throw new Error(`Subagent ${filePath} must define frontmatter name and description`);
	}
	if (frontmatter.name !== agentName) {
		throw new Error(
			`Subagent frontmatter name mismatch in ${filePath}: expected "${agentName}", found "${frontmatter.name}"`,
		);
	}
	if (frontmatter.thinking && !VALID_THINKING_LEVELS.has(frontmatter.thinking)) {
		throw new Error(
			`Invalid thinking level "${frontmatter.thinking}" in ${filePath}. Valid values: ${Array.from(VALID_THINKING_LEVELS).join(", ")}`,
		);
	}

	const systemPrompt = body.trim();
	if (systemPrompt.length === 0) {
		throw new Error(`Subagent ${filePath} must include a system prompt body`);
	}

	return {
		name: frontmatter.name,
		description: frontmatter.description,
		filePath,
		systemPrompt,
		model: frontmatter.model?.trim() || undefined,
		thinking: (frontmatter.thinking?.trim() || undefined) as SubagentAgentConfig["thinking"],
		tools: parseTools(frontmatter.tools),
	};
}
