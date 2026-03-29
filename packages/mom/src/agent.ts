import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import type { Api, ImageContent, Model } from "@mariozechner/pi-ai";
import {
	AgentSession,
	AuthStorage,
	convertToLlm,
	createExtensionRuntime,
	discoverAndLoadExtensions,
	formatSkillsForPrompt,
	loadSkillsFromDir,
	ModelRegistry,
	type ResourceLoader,
	SessionManager,
	type Skill,
} from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { MomSettingsManager, syncLogToSessionManager } from "./context.js";
import * as log from "./log.js";
import { createExecutor, type SandboxConfig } from "./sandbox.js";
import type { ChannelInfo, SlackContext, UserInfo } from "./slack.js";
import type { ChannelStore } from "./store.js";
import { createMomTools, setUploadFunction } from "./tools/index.js";
import { createSubagentTool } from "./tools/subagent.js";

const DEFAULT_PROVIDER_PREFERENCE = [
	"openai-codex",
	"github-copilot",
	"openai",
	"anthropic",
	"google",
	"groq",
	"openrouter",
	"amazon-bedrock",
	"opencode",
] as const;

function resolveModelFromConfig(
	modelRegistry: ModelRegistry,
	ref: { provider: string; modelId: string } | null | undefined,
): Model<Api> | undefined {
	if (!ref) return undefined;
	const model = modelRegistry.find(ref.provider, ref.modelId);
	if (!model) return undefined;
	// Fast check: does auth exist at all? (does not refresh OAuth)
	if (!modelRegistry.authStorage.hasAuth(model.provider)) return undefined;
	return model;
}

function resolvePreferredAvailableModel(modelRegistry: ModelRegistry): Model<Api> | undefined {
	const available = modelRegistry.getAvailable();
	if (available.length === 0) return undefined;

	for (const provider of DEFAULT_PROVIDER_PREFERENCE) {
		const match = available.find((m) => m.provider === provider);
		if (match) return match;
	}

	return available[0];
}

export interface PendingMessage {
	userName: string;
	text: string;
	attachments: { local: string }[];
	timestamp: number;
}

export interface AgentRunner {
	run(
		ctx: SlackContext,
		store: ChannelStore,
		pendingMessages?: PendingMessage[],
	): Promise<{ stopReason: string; errorMessage?: string }>;
	abort(): void;
}

const IMAGE_MIME_TYPES: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
};

function getImageMimeType(filename: string): string | undefined {
	return IMAGE_MIME_TYPES[filename.toLowerCase().split(".").pop() || ""];
}

function getAgentsProfile(channelDir: string): string {
	const agentsPath = join(channelDir, "..", "AGENTS.md");
	if (!existsSync(agentsPath)) {
		return [
			"## IDENTITY",
			"You are mom, a Slack bot assistant.",
			"",
			"## OBJECTIVES",
			"Help the user complete tasks accurately and efficiently.",
			"",
			"## SOUL",
			"Be concise. No emojis.",
		].join("\n");
	}

	try {
		const content = readFileSync(agentsPath, "utf-8").trim();
		if (!content) {
			return [
				"## IDENTITY",
				"You are mom, a Slack bot assistant.",
				"",
				"## OBJECTIVES",
				"Help the user complete tasks accurately and efficiently.",
				"",
				"## SOUL",
				"Be concise. No emojis.",
			].join("\n");
		}
		return content;
	} catch (error) {
		log.logWarning("Failed to read AGENTS profile", `${agentsPath}: ${error}`);
		return [
			"## IDENTITY",
			"You are mom, a Slack bot assistant.",
			"",
			"## OBJECTIVES",
			"Help the user complete tasks accurately and efficiently.",
			"",
			"## SOUL",
			"Be concise. No emojis.",
		].join("\n");
	}
}

function loadMomSkills(channelDir: string, workspacePath: string): Skill[] {
	const skillMap = new Map<string, Skill>();

	// channelDir is the host path (e.g., /Users/.../data/C0A34FL8PMH)
	// hostWorkspacePath is the parent directory on host
	// workspacePath is the container path (e.g., /workspace)
	const hostWorkspacePath = join(channelDir, "..");

	// Helper to translate host paths to container paths
	const translatePath = (hostPath: string): string => {
		if (hostPath.startsWith(hostWorkspacePath)) {
			return workspacePath + hostPath.slice(hostWorkspacePath.length);
		}
		return hostPath;
	};

	// Load workspace-level skills (global)
	const workspaceSkillsDir = join(hostWorkspacePath, "skills");
	for (const skill of loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" }).skills) {
		// Translate paths to container paths for system prompt
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	// Load channel-specific skills (override workspace skills on collision)
	const channelSkillsDir = join(channelDir, "skills");
	for (const skill of loadSkillsFromDir({ dir: channelSkillsDir, source: "channel" }).skills) {
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	return Array.from(skillMap.values());
}

function buildSystemPrompt(
	workspacePath: string,
	channelId: string,
	agentsProfile: string,
	sandboxConfig: SandboxConfig,
	channels: ChannelInfo[],
	users: UserInfo[],
	skills: Skill[],
): string {
	const channelPath = `${workspacePath}/${channelId}`;

	// Format channel mappings
	const channelMappings =
		channels.length > 0 ? channels.map((c) => `${c.id}\t#${c.name}`).join("\n") : "(no channels loaded)";

	// Format user mappings
	const userMappings =
		users.length > 0 ? users.map((u) => `${u.id}\t@${u.userName}\t${u.displayName}`).join("\n") : "(no users loaded)";

	const envDescription =
		sandboxConfig.type === "docker"
			? `You are running inside a Docker container (Alpine Linux).
- Bash working directory: / (use cd or absolute paths)
- Install tools with: apk add <package>
- Your changes persist across sessions`
			: sandboxConfig.type === "vibesilo"
				? `You are running inside a Docker container (vibesilo sandbox; image configured in settings.json).
- Bash working directory: / (use cd or absolute paths)
- Network access may be restricted. Prefer trying the request; if blocked, use the error output to adjust your approach.
- Secret placeholders may be injected via environment variables (same names as configured secrets). Do not print secret values.
- Install tools via the image's package manager (typically apt)
- Your changes persist for the lifetime of this mom process`
				: `You are running directly on the host machine.
- Bash working directory: ${process.cwd()}
- Be careful with system modifications`;

	return `## Agent Profile
${agentsProfile}

## Context
- For current date/time, use: date
- You have access to previous conversation context including tool results from prior turns.
- For older history beyond your context, search log.jsonl (contains user messages and your final responses, but not tool results).

## Slack Formatting (mrkdwn, NOT Markdown)
Bold: *text*, Italic: _text_, Code: \`code\`, Block: \`\`\`code\`\`\`, Links: <url|text>
Do NOT use **double asterisks** or [markdown](links).

## Slack IDs
Channels: ${channelMappings}

Users: ${userMappings}

When mentioning users, use <@username> format (e.g., <@mario>).

## Environment
${envDescription}

## Workspace
- Skills: \`${workspacePath}/skills/\` (global) and \`${channelPath}/skills/\` (channel-specific)
- Memory: \`${workspacePath}/MEMORY.md\` and \`${channelPath}/MEMORY.md\`
- Events: \`${workspacePath}/events/\`
- Log: \`${channelPath}/log.jsonl\`
- Subagents: \`${workspacePath}/.pi/agents/\`

## Skills
Create reusable CLI tools in \`skills/\`. Each skill needs a \`SKILL.md\` with YAML frontmatter (\`name\`, \`description\`) and usage docs.

### Available Skills
${skills.length > 0 ? formatSkillsForPrompt(skills) : "(no skills installed yet)"}

## Tools
- bash: Run shell commands (primary tool). Install packages as needed.
- read: Read files
- write: Create/overwrite files
- edit: Surgical file edits
- attach: Share files to Slack
- subagent: Delegate a bounded task to a workspace-defined child agent from .pi/agents/

Each tool requires a "label" parameter (shown to user).

**Note:** The "Current working directory" shown below refers to the host machine. Your view is \`/workspace\` inside the sandbox.
`;
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.substring(0, maxLen - 3)}...`;
}

function extractToolResultText(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}

	if (
		result &&
		typeof result === "object" &&
		"content" in result &&
		Array.isArray((result as { content: unknown }).content)
	) {
		const content = (result as { content: Array<{ type: string; text?: string }> }).content;
		const textParts: string[] = [];
		for (const part of content) {
			if (part.type === "text" && part.text) {
				textParts.push(part.text);
			}
		}
		if (textParts.length > 0) {
			return textParts.join("\n");
		}
	}

	return JSON.stringify(result);
}

function formatToolArgsForSlack(_toolName: string, args: Record<string, unknown>): string {
	const lines: string[] = [];

	for (const [key, value] of Object.entries(args)) {
		if (key === "label") continue;

		if (key === "path" && typeof value === "string") {
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined && limit !== undefined) {
				lines.push(`${value}:${offset}-${offset + limit}`);
			} else {
				lines.push(value);
			}
			continue;
		}

		if (key === "offset" || key === "limit") continue;

		if (typeof value === "string") {
			lines.push(value);
		} else {
			lines.push(JSON.stringify(value));
		}
	}

	return lines.join("\n");
}

// Cache runners per (channel, thread)
const channelRunners = new Map<string, AgentRunner>();

function sanitizeThreadTs(threadTs: string): string {
	// Slack ts looks like "1234567890.123456". Keep it readable but safe for paths.
	return threadTs.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Get or create an AgentRunner for a Slack thread.
 * Runners are cached per (channelId, threadTs).
 */
export function getOrCreateRunner(
	sandboxConfig: SandboxConfig,
	channelId: string,
	channelDir: string,
	threadTs: string,
	extensionPaths?: string[],
	noExtensions?: boolean,
): AgentRunner {
	const key = `${channelId}:${threadTs}`;
	const existing = channelRunners.get(key);
	if (existing) return existing;

	const runner = createRunner(sandboxConfig, channelId, channelDir, threadTs, extensionPaths, noExtensions);
	channelRunners.set(key, runner);
	return runner;
}

/**
 * Create a new AgentRunner for a Slack thread.
 * Sets up the session and subscribes to events once.
 */
function createRunner(
	sandboxConfig: SandboxConfig,
	channelId: string,
	channelDir: string,
	threadTs: string,
	extensionPaths?: string[],
	noExtensions?: boolean,
): AgentRunner {
	const hostWorkspaceDir = channelDir.replace(`/${channelId}`, "");
	const executor = createExecutor(sandboxConfig, hostWorkspaceDir);
	const workspacePath = executor.getWorkspacePath(hostWorkspaceDir);

	// Create session manager and settings manager
	// Use a fixed context.jsonl file per Slack thread (not timestamped like coding-agent)
	const threadDir = threadTs === "dm" ? channelDir : join(channelDir, "threads", sanitizeThreadTs(threadTs));
	if (!existsSync(threadDir)) {
		mkdirSync(threadDir, { recursive: true });
	}
	const contextFile = join(threadDir, "context.jsonl");
	const sessionManager = SessionManager.open(contextFile, threadDir);
	const settingsManager = new MomSettingsManager(join(channelDir, ".."));

	// Create AuthStorage and ModelRegistry
	// Auth stored outside workspace so agent can't access it
	const authStorage = (AuthStorage as unknown as { create: (path: string) => AuthStorage }).create(
		join(homedir(), ".pi", "mom", "auth.json"),
	);
	const modelRegistry = new ModelRegistry(authStorage);

	// Load existing messages (also contains last selected model/thinking level)
	const loadedSession = sessionManager.buildSessionContext();

	// Resolve model selection (priority: session -> settings -> first available)
	const sessionModel = resolveModelFromConfig(modelRegistry, loadedSession.model);
	const settingsProvider = settingsManager.getDefaultProvider();
	const settingsModelId = settingsManager.getDefaultModel();
	const settingsModel = resolveModelFromConfig(
		modelRegistry,
		settingsProvider && settingsModelId ? { provider: settingsProvider, modelId: settingsModelId } : undefined,
	);
	const availableModel = resolvePreferredAvailableModel(modelRegistry);

	const selectedModel = sessionModel ?? settingsModel ?? availableModel;
	const selectedThinkingLevel = (
		loadedSession.messages.length > 0
			? loadedSession.thinkingLevel
			: settingsManager.getDefaultThinkingLevel() || loadedSession.thinkingLevel || "off"
	) as "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

	if (selectedModel) {
		log.logInfo(`[${channelId}] Using model ${selectedModel.provider}/${selectedModel.id}`);
		// Persist selection for brand new thread sessions so future runs stay stable.
		if (!loadedSession.model) {
			sessionManager.appendModelChange(selectedModel.provider, selectedModel.id);
			settingsManager.setDefaultModelAndProvider(selectedModel.provider, selectedModel.id);
		}
	} else {
		log.logWarning(
			`[${channelId}] No model available (no API keys/OAuth configured).` +
				` Configure credentials (e.g. via pi-coding-agent /login) and link auth.json to ~/.pi/mom/auth.json.`,
		);
	}

	if (loadedSession.messages.length === 0 && selectedThinkingLevel !== "off") {
		sessionManager.appendThinkingLevelChange(selectedThinkingLevel);
	}

	log.logInfo(`[${channelId}] Using thinking level ${selectedThinkingLevel}`);

	let session: AgentSession | undefined;
	let loadedExtensionPaths: string[] = extensionPaths ?? [];
	const subagentTool = createSubagentTool({
		executor,
		sandboxConfig,
		workspaceDir: hostWorkspaceDir,
		threadDir,
		sessionManager,
		getCurrentModel: () => {
			const activeModel = session?.model;
			if (activeModel) {
				return { provider: activeModel.provider, id: activeModel.id };
			}
			if (selectedModel) {
				return { provider: selectedModel.provider, id: selectedModel.id };
			}
			return undefined;
		},
		getCurrentThinkingLevel: () => session?.thinkingLevel ?? selectedThinkingLevel,
		getInheritedExtensionPaths: () => loadedExtensionPaths,
	});
	const tools = createMomTools(executor, [subagentTool]);

	// Build initial system prompt (will be updated by extension via before_agent_start)
	const agentsProfile = getAgentsProfile(channelDir);
	const skills = loadMomSkills(channelDir, workspacePath);
	const systemPrompt = buildSystemPrompt(workspacePath, channelId, agentsProfile, sandboxConfig, [], [], skills);

	// Create agent
	const agent = new Agent({
		initialState: {
			systemPrompt,
			...(selectedModel ? { model: selectedModel } : {}),
			thinkingLevel: selectedThinkingLevel,
			tools,
		},
		sessionId: sessionManager.getSessionId(),
		convertToLlm,
		getApiKey: (provider) => authStorage.getApiKey(provider),
	});

	if (loadedSession.messages.length > 0) {
		agent.replaceMessages(loadedSession.messages);
		log.logInfo(`[${channelId}] Loaded ${loadedSession.messages.length} messages from context.jsonl`);
	}

	// Create a ResourceLoader that includes the loaded extensions
	// Initially empty - will be populated by loadExtensionsOnce() via session.reload()
	const emptyExtensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	const resourceLoader: ResourceLoader = {
		getExtensions: () => emptyExtensionsResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		getPathMetadata: () => new Map(),
		extendResources: () => {},
		reload: async () => {},
	};

	const baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

	// Create AgentSession wrapper
	session = new AgentSession({
		agent,
		sessionManager,
		settingsManager: settingsManager as any,
		cwd: process.cwd(),
		modelRegistry,
		resourceLoader,
		baseToolsOverride,
	});

	// Track whether extensions have been bound (loaded lazily on first run)
	let extensionsLoaded = false;
	const loadExtensionsOnce = async () => {
		if (extensionsLoaded || noExtensions) return;
		extensionsLoaded = true;

		const hostWorkspacePath = join(channelDir, "..");
		const additionalExtPaths = extensionPaths ?? [];

		log.logInfo(
			`[${channelId}] Loading extensions from: ${hostWorkspacePath}, plus: ${additionalExtPaths.join(", ")}`,
		);

		// Only load workspace extensions (no global ~/.pi/agent/extensions/)
		// Pass a non-existent agentDir to skip global extensions
		const extResult = await discoverAndLoadExtensions(
			additionalExtPaths,
			hostWorkspacePath,
			"/nonexistent-agent-dir",
		);

		for (const { path, error } of extResult.errors) {
			log.logWarning(`[${channelId}] Failed to load extension "${path}": ${error}`);
		}

		// Apply pending provider registrations to model registry
		// This MUST happen before model resolution
		for (const { name, config } of extResult.runtime.pendingProviderRegistrations) {
			modelRegistry.registerProvider(name, config);
			log.logInfo(`[${channelId}] Registered provider: ${name}`);
		}
		extResult.runtime.pendingProviderRegistrations = [];

		loadedExtensionPaths = extResult.extensions.map((extension) => extension.path);

		// Update resource loader with loaded extensions before reload
		resourceLoader.getExtensions = () => extResult;
		resourceLoader.reload = async () => {
			// Reload extensions from disk - skip global extensions
			const reloaded = await discoverAndLoadExtensions(
				additionalExtPaths,
				hostWorkspacePath,
				"/nonexistent-agent-dir",
			);
			resourceLoader.getExtensions = () => reloaded;
		};

		// bindExtensions sets up bindings (needed for hasBindings in reload)
		// then reload rebuilds the ExtensionRunner with extensions
		await session.bindExtensions({
			onError: (err) => {
				log.logWarning(`[${channelId}] Extension error (${err.extensionPath}): ${err.error}`);
			},
		});

		// Reload to rebuild ExtensionRunner with workspace extensions
		await session.reload();

		log.logInfo(`[${channelId}] Bound ${extResult.extensions.length} extension(s)`);
	};

	// Mutable per-run state - event handler references this
	const runState = {
		ctx: null as SlackContext | null,
		logCtx: null as { channelId: string; userName?: string; channelName?: string } | null,
		queue: null as {
			enqueue(fn: () => Promise<void>, errorContext: string): void;
			enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog?: boolean): void;
		} | null,
		pendingTools: new Map<string, { toolName: string; args: unknown; startTime: number }>(),
		totalUsage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		errorMessage: undefined as string | undefined,
	};

	// Subscribe to events ONCE
	session.subscribe(async (event) => {
		// Skip if no active run
		if (!runState.ctx || !runState.logCtx || !runState.queue) return;

		const { ctx, logCtx, queue, pendingTools } = runState;

		if (event.type === "tool_execution_start") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_start" };
			const args = agentEvent.args as { label?: string };
			const label = args.label || agentEvent.toolName;

			pendingTools.set(agentEvent.toolCallId, {
				toolName: agentEvent.toolName,
				args: agentEvent.args,
				startTime: Date.now(),
			});

			log.logToolStart(logCtx, agentEvent.toolName, label, agentEvent.args as Record<string, unknown>);
			if (settingsManager.getPostToolDetailsToSlack()) {
				queue.enqueue(() => ctx.respond(`_→ ${label}_`, false), "tool label");
			}
		} else if (event.type === "tool_execution_end") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_end" };
			const resultStr = extractToolResultText(agentEvent.result);
			const pending = pendingTools.get(agentEvent.toolCallId);
			pendingTools.delete(agentEvent.toolCallId);

			const durationMs = pending ? Date.now() - pending.startTime : 0;

			if (agentEvent.isError) {
				log.logToolError(logCtx, agentEvent.toolName, durationMs, resultStr);
			} else {
				log.logToolSuccess(logCtx, agentEvent.toolName, durationMs, resultStr);
			}

			// Post args + result to thread (optional)
			if (settingsManager.getPostToolDetailsToSlack()) {
				const label = pending?.args ? (pending.args as { label?: string }).label : undefined;
				const argsFormatted = pending
					? formatToolArgsForSlack(agentEvent.toolName, pending.args as Record<string, unknown>)
					: "(args not found)";
				const duration = (durationMs / 1000).toFixed(1);
				let threadMessage = `*${agentEvent.isError ? "✗" : "✓"} ${agentEvent.toolName}*`;
				if (label) threadMessage += `: ${label}`;
				threadMessage += ` (${duration}s)\n`;
				if (argsFormatted) threadMessage += `\`\`\`\n${argsFormatted}\n\`\`\`\n`;
				threadMessage += `*Result:*\n\`\`\`\n${resultStr}\n\`\`\``;

				queue.enqueueMessage(threadMessage, "thread", "tool result thread", false);
			}

			if (agentEvent.isError) {
				queue.enqueue(() => ctx.respond(`_Error: ${truncate(resultStr, 200)}_`, false), "tool error");
			}
		} else if (event.type === "message_start") {
			const agentEvent = event as AgentEvent & { type: "message_start" };
			if (agentEvent.message.role === "assistant") {
				log.logResponseStart(logCtx);
			}
		} else if (event.type === "message_end") {
			const agentEvent = event as AgentEvent & { type: "message_end" };
			if (agentEvent.message.role === "assistant") {
				const assistantMsg = agentEvent.message as any;

				if (assistantMsg.stopReason) {
					runState.stopReason = assistantMsg.stopReason;
				}
				if (assistantMsg.errorMessage) {
					runState.errorMessage = assistantMsg.errorMessage;
				}

				if (assistantMsg.usage) {
					runState.totalUsage.input += assistantMsg.usage.input;
					runState.totalUsage.output += assistantMsg.usage.output;
					runState.totalUsage.cacheRead += assistantMsg.usage.cacheRead;
					runState.totalUsage.cacheWrite += assistantMsg.usage.cacheWrite;
					runState.totalUsage.cost.input += assistantMsg.usage.cost.input;
					runState.totalUsage.cost.output += assistantMsg.usage.cost.output;
					runState.totalUsage.cost.cacheRead += assistantMsg.usage.cost.cacheRead;
					runState.totalUsage.cost.cacheWrite += assistantMsg.usage.cost.cacheWrite;
					runState.totalUsage.cost.total += assistantMsg.usage.cost.total;
				}

				const content = agentEvent.message.content;
				const thinkingParts: string[] = [];
				const textParts: string[] = [];
				for (const part of content) {
					if (part.type === "thinking") {
						thinkingParts.push((part as any).thinking);
					} else if (part.type === "text") {
						textParts.push((part as any).text);
					}
				}

				const text = textParts.join("\n");

				for (const thinking of thinkingParts) {
					// Keep thinking in logs/context, but don't post it to Slack to avoid msg_too_long noise.
					log.logThinking(logCtx, thinking);
				}

				if (text.trim()) {
					log.logResponse(logCtx, text);
					queue.enqueueMessage(text, "main", "response main");
				}
			}
		} else if (event.type === "auto_compaction_start") {
			log.logInfo(`Auto-compaction started (reason: ${(event as any).reason})`);
			queue.enqueue(() => ctx.respond("_Compacting context..._", false), "compaction start");
		} else if (event.type === "auto_compaction_end") {
			const compEvent = event as any;
			if (compEvent.result) {
				log.logInfo(`Auto-compaction complete: ${compEvent.result.tokensBefore} tokens compacted`);
			} else if (compEvent.aborted) {
				log.logInfo("Auto-compaction aborted");
			}
		} else if (event.type === "auto_retry_start") {
			const retryEvent = event as any;
			log.logWarning(`Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})`, retryEvent.errorMessage);
			queue.enqueue(
				() => ctx.respond(`_Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})..._`, false),
				"retry",
			);
		}
	});

	// Slack message limit
	const SLACK_MAX_LENGTH = 40000;
	const splitForSlack = (text: string): string[] => {
		if (text.length <= SLACK_MAX_LENGTH) return [text];
		const parts: string[] = [];
		let remaining = text;
		let partNum = 1;
		while (remaining.length > 0) {
			const chunk = remaining.substring(0, SLACK_MAX_LENGTH - 50);
			remaining = remaining.substring(SLACK_MAX_LENGTH - 50);
			const suffix = remaining.length > 0 ? `\n_(continued ${partNum}...)_` : "";
			parts.push(chunk + suffix);
			partNum++;
		}
		return parts;
	};

	return {
		async run(
			ctx: SlackContext,
			_store: ChannelStore,
			_pendingMessages?: PendingMessage[],
		): Promise<{ stopReason: string; errorMessage?: string }> {
			// Load extensions on first run (lazy initialization)
			await loadExtensionsOnce();

			// Ensure channel directory exists
			await mkdir(channelDir, { recursive: true });

			// Sync messages from log.jsonl that arrived while we were offline or busy
			// Exclude the current message (it will be added via prompt())
			const syncedCount = syncLogToSessionManager(sessionManager, channelDir, threadTs, ctx.message.ts);
			if (syncedCount > 0) {
				log.logInfo(`[${channelId}] Synced ${syncedCount} messages from log.jsonl`);
			}

			// Reload messages from context.jsonl
			// This picks up any messages synced above
			const reloadedSession = sessionManager.buildSessionContext();
			if (reloadedSession.messages.length > 0) {
				agent.replaceMessages(reloadedSession.messages);
				log.logInfo(`[${channelId}] Reloaded ${reloadedSession.messages.length} messages from context`);
			}

			// Update system prompt with fresh channel/user info and skills
			const agentsProfile = getAgentsProfile(channelDir);
			const skills = loadMomSkills(channelDir, workspacePath);
			const systemPrompt = buildSystemPrompt(
				workspacePath,
				channelId,
				agentsProfile,
				sandboxConfig,
				ctx.channels,
				ctx.users,
				skills,
			);
			session.agent.setSystemPrompt(systemPrompt);

			// Set up file upload function
			setUploadFunction(async (filePath: string, title?: string) => {
				const hostPath = translateToHostPath(filePath, channelDir, workspacePath, channelId);
				await ctx.uploadFile(hostPath, title);
			});

			// Reset per-run state
			runState.ctx = ctx;
			runState.logCtx = {
				channelId: ctx.message.channel,
				userName: ctx.message.userName,
				channelName: ctx.channelName,
			};
			runState.pendingTools.clear();
			runState.totalUsage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			runState.stopReason = "stop";
			runState.errorMessage = undefined;

			// Create queue for this run
			let queueChain = Promise.resolve();
			runState.queue = {
				enqueue(fn: () => Promise<void>, errorContext: string): void {
					queueChain = queueChain.then(async () => {
						try {
							await fn();
						} catch (err) {
							const errMsg = err instanceof Error ? err.message : String(err);
							log.logWarning(`Slack API error (${errorContext})`, errMsg);
							try {
								await ctx.respondInThread(`_Error: ${errMsg}_`);
							} catch {
								// Ignore
							}
						}
					});
				},
				enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog = true): void {
					const parts = splitForSlack(text);
					if (target === "main") {
						if (parts.length === 0) return;
						if (parts.length === 1) {
							this.enqueue(() => ctx.respond(parts[0], doLog), errorContext);
							return;
						}

						const head = `${parts[0]}\n\n_(continued in thread)_`;
						this.enqueue(() => ctx.respond(head, doLog), errorContext);
						for (let i = 1; i < parts.length; i++) {
							const part = parts[i];
							this.enqueue(() => ctx.respondInThread(part), `${errorContext} (thread continuation)`);
						}
						return;
					}

					for (const part of parts) {
						this.enqueue(() => ctx.respondInThread(part), errorContext);
					}
				},
			};

			// Log context info
			log.logInfo(`System prompt: ${systemPrompt.length} chars`);
			log.logInfo(`Channels: ${ctx.channels.length}, Users: ${ctx.users.length}`);

			// Build user message with timestamp and username prefix
			// Format: "[YYYY-MM-DD HH:MM:SS+HH:MM] [username]: message" so LLM knows when and who
			const now = new Date();
			const pad = (n: number) => n.toString().padStart(2, "0");
			const offset = -now.getTimezoneOffset();
			const offsetSign = offset >= 0 ? "+" : "-";
			const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
			const offsetMins = pad(Math.abs(offset) % 60);
			const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetSign}${offsetHours}:${offsetMins}`;
			let userMessage = `[${timestamp}] [${ctx.message.userName || "unknown"}]: ${ctx.message.text}`;

			const imageAttachments: ImageContent[] = [];
			const nonImagePaths: string[] = [];

			for (const a of ctx.message.attachments || []) {
				const fullPath = `${workspacePath}/${a.local}`;
				const mimeType = getImageMimeType(a.local);

				if (mimeType && existsSync(fullPath)) {
					try {
						imageAttachments.push({
							type: "image",
							mimeType,
							data: readFileSync(fullPath).toString("base64"),
						});
					} catch {
						nonImagePaths.push(fullPath);
					}
				} else {
					nonImagePaths.push(fullPath);
				}
			}

			if (nonImagePaths.length > 0) {
				userMessage += `\n\n<slack_attachments>\n${nonImagePaths.join("\n")}\n</slack_attachments>`;
			}

			await session.prompt(userMessage, imageAttachments.length > 0 ? { images: imageAttachments } : undefined);

			// Debug: write context to last_prompt.jsonl
			// Use the actual system prompt from the agent (may have been modified by extensions)
			const actualSystemPrompt = session.agent.state.systemPrompt;
			const debugContext = {
				systemPrompt: actualSystemPrompt,
				messages: session.messages,
				newUserMessage: userMessage,
				imageAttachmentCount: imageAttachments.length,
			};
			await writeFile(join(threadDir, "last_prompt.jsonl"), JSON.stringify(debugContext, null, 2));

			// Wait for queued messages
			await queueChain;

			// Handle error case - update main message and post error to thread
			if (runState.stopReason === "error" && runState.errorMessage) {
				try {
					await ctx.replaceMessage("_Sorry, something went wrong_");
					await ctx.respondInThread(`_Error: ${runState.errorMessage}_`);
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					log.logWarning("Failed to post error message", errMsg);
				}
			} else {
				// Final message update
				const messages = session.messages;
				const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
				const finalText =
					lastAssistant?.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n") || "";

				// Check for [SILENT] marker - delete message and thread instead of posting
				if (finalText.trim() === "[SILENT]" || finalText.trim().startsWith("[SILENT]")) {
					try {
						await ctx.deleteMessage();
						log.logInfo("Silent response - deleted message and thread");
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning("Failed to delete message for silent response", errMsg);
					}
				} else if (finalText.trim()) {
					try {
						const mainText =
							finalText.length > SLACK_MAX_LENGTH
								? `${finalText.substring(0, SLACK_MAX_LENGTH - 50)}\n\n_(see thread for full response)_`
								: finalText;
						await ctx.replaceMessage(mainText);
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning("Failed to replace message with final text", errMsg);
					}
				}
			}

			// Log usage summary with context info
			if (runState.totalUsage.cost.total > 0) {
				// Get last non-aborted assistant message for context calculation
				const messages = session.messages;
				const lastAssistantMessage = messages
					.slice()
					.reverse()
					.find((m) => m.role === "assistant" && (m as any).stopReason !== "aborted") as any;

				const contextTokens = lastAssistantMessage
					? lastAssistantMessage.usage.input +
						lastAssistantMessage.usage.output +
						lastAssistantMessage.usage.cacheRead +
						lastAssistantMessage.usage.cacheWrite
					: 0;
				const contextWindow = session.model?.contextWindow ?? 200000;

				const summary = log.logUsageSummary(runState.logCtx!, runState.totalUsage, contextTokens, contextWindow);

				// Default: do not post cost breakdown to Slack. Still log it to console.
				if (settingsManager.getPostUsageSummaryToSlack()) {
					runState.queue.enqueue(() => ctx.respondInThread(summary), "usage summary");
					await queueChain;
				}
			}

			// Clear run state
			runState.ctx = null;
			runState.logCtx = null;
			runState.queue = null;

			return { stopReason: runState.stopReason, errorMessage: runState.errorMessage };
		},

		abort(): void {
			session.abort();
		},
	};
}

/**
 * Translate container path back to host path for file operations
 */
function translateToHostPath(
	containerPath: string,
	channelDir: string,
	workspacePath: string,
	channelId: string,
): string {
	if (workspacePath === "/workspace") {
		const prefix = `/workspace/${channelId}/`;
		if (containerPath.startsWith(prefix)) {
			return join(channelDir, containerPath.slice(prefix.length));
		}
		if (containerPath.startsWith("/workspace/")) {
			return join(channelDir, "..", containerPath.slice("/workspace/".length));
		}
	}
	return containerPath;
}
