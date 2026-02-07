/**
 * Context management for mom.
 *
 * Mom uses two files per channel:
 * - context.jsonl: Structured API messages for LLM context (same format as coding-agent sessions)
 * - log.jsonl: Human-readable channel history for grep (no tool results)
 *
 * This module provides:
 * - syncLogToSessionManager: Syncs messages from log.jsonl to SessionManager
 * - MomSettingsManager: Simple settings for mom (compaction, retry, model preferences)
 */

import type { UserMessage } from "@mariozechner/pi-ai";
import type { SessionManager, SessionMessageEntry } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";

// ============================================================================
// Sync log.jsonl to SessionManager
// ============================================================================

interface LogMessage {
	date?: string;
	ts?: string;
	threadTs?: string;
	user?: string;
	userName?: string;
	text?: string;
	isBot?: boolean;
}

/**
 * Sync user messages from log.jsonl to SessionManager.
 *
 * This ensures that messages logged while mom wasn't running (channel chatter,
 * backfilled messages, messages while busy) are added to the LLM context.
 *
 * @param sessionManager - The SessionManager to sync to
 * @param channelDir - Path to channel directory containing log.jsonl
 * @param threadTs - Slack thread root timestamp key for this session ("dm" for DMs)
 * @param excludeSlackTs - Slack timestamp of current message (will be added via prompt(), not sync)
 * @returns Number of messages synced
 */
export function syncLogToSessionManager(
	sessionManager: SessionManager,
	channelDir: string,
	threadTs: string,
	excludeSlackTs?: string,
): number {
	const logFile = join(channelDir, "log.jsonl");

	if (!existsSync(logFile)) return 0;

	// Build set of existing message content from session
	const existingMessages = new Set<string>();
	for (const entry of sessionManager.getEntries()) {
		if (entry.type === "message") {
			const msgEntry = entry as SessionMessageEntry;
			const msg = msgEntry.message as { role: string; content?: unknown };
			if (msg.role === "user" && msg.content !== undefined) {
				const content = msg.content;
				if (typeof content === "string") {
					// Strip timestamp prefix for comparison (live messages have it, synced don't)
					// Format: [YYYY-MM-DD HH:MM:SS+HH:MM] [username]: text
					let normalized = content.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] /, "");
					// Strip attachments section
					const attachmentsIdx = normalized.indexOf("\n\n<slack_attachments>\n");
					if (attachmentsIdx !== -1) {
						normalized = normalized.substring(0, attachmentsIdx);
					}
					existingMessages.add(normalized);
				} else if (Array.isArray(content)) {
					for (const part of content) {
						if (
							typeof part === "object" &&
							part !== null &&
							"type" in part &&
							part.type === "text" &&
							"text" in part
						) {
							let normalized = (part as { type: "text"; text: string }).text;
							normalized = normalized.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] /, "");
							const attachmentsIdx = normalized.indexOf("\n\n<slack_attachments>\n");
							if (attachmentsIdx !== -1) {
								normalized = normalized.substring(0, attachmentsIdx);
							}
							existingMessages.add(normalized);
						}
					}
				}
			}
		}
	}

	// Read log.jsonl and find user messages not in context
	const logContent = readFileSync(logFile, "utf-8");
	const logLines = logContent.trim().split("\n").filter(Boolean);

	const newMessages: Array<{ timestamp: number; message: UserMessage }> = [];

	for (const line of logLines) {
		try {
			const logMsg: LogMessage = JSON.parse(line);

			const slackTs = logMsg.ts;
			const date = logMsg.date;
			if (!slackTs || !date) continue;

			// Only sync messages from the same Slack thread.
			// For older logs without threadTs, fall back to ts (treat as its own thread).
			const msgThreadTs = logMsg.threadTs ?? slackTs;
			if (msgThreadTs !== threadTs) continue;

			// Skip the current message being processed (will be added via prompt())
			if (excludeSlackTs && slackTs === excludeSlackTs) continue;

			// Skip bot messages - added through agent flow
			if (logMsg.isBot) continue;

			// Build the message text as it would appear in context
			const messageText = `[${logMsg.userName || logMsg.user || "unknown"}]: ${logMsg.text || ""}`;

			// Skip if this exact message text is already in context
			if (existingMessages.has(messageText)) continue;

			const msgTime = new Date(date).getTime() || Date.now();
			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: messageText }],
				timestamp: msgTime,
			};

			newMessages.push({ timestamp: msgTime, message: userMessage });
			existingMessages.add(messageText); // Track to avoid duplicates within this sync
		} catch {
			// Skip malformed lines
		}
	}

	if (newMessages.length === 0) return 0;

	// Sort by timestamp and add to session
	newMessages.sort((a, b) => a.timestamp - b.timestamp);

	for (const { message } of newMessages) {
		sessionManager.appendMessage(message);
	}

	return newMessages.length;
}

// ============================================================================
// MomSettingsManager - Simple settings for mom
// ============================================================================

export interface MomCompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export interface MomRetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
}

export interface MomBranchSummarySettings {
	reserveTokens: number;
}

export interface MomImageSettings {
	autoResize: boolean;
	blockImages: boolean;
}

export interface MomVibesiloSecretSettings {
	/** Name of host env var to load the secret value from */
	fromEnv: string;
	/** Host allowlist for injecting this secret (subset of vibesilo.allowNet) */
	hosts: string[];
}

export interface MomVibesiloSettings {
	image?: string;
	/** Outbound allow list. Important: vibesilo treats an empty list as allow-all, so mom should require this when enabled. */
	allowNet?: string[];
	secrets?: Record<string, MomVibesiloSecretSettings>;
	debugInjectHeader?: boolean;
}

export interface MomSettings {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
	theme?: string;
	shellCommandPrefix?: string;
	branchSummary?: Partial<MomBranchSummarySettings>;
	images?: Partial<MomImageSettings>;
	compaction?: Partial<MomCompactionSettings>;
	retry?: Partial<MomRetrySettings>;
	postUsageSummaryToSlack?: boolean;
	postToolDetailsToSlack?: boolean;
	autoTriggerChannels?: boolean;
	autoTriggerChannelUserIds?: string[];
	vibesilo?: Partial<MomVibesiloSettings>;
	/** User IDs allowed to run privileged slash commands (e.g. updating allowNet). */
	adminUserIds?: string[];
}

const DEFAULT_COMPACTION: MomCompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

const DEFAULT_RETRY: MomRetrySettings = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 2000,
};

const DEFAULT_BRANCH_SUMMARY: MomBranchSummarySettings = {
	reserveTokens: 16384,
};

const DEFAULT_IMAGES: MomImageSettings = {
	autoResize: true,
	blockImages: false,
};

const DEFAULT_VIBESILO: Required<Pick<MomVibesiloSettings, "image" | "allowNet" | "debugInjectHeader">> = {
	image: "node:20-bookworm",
	allowNet: [],
	debugInjectHeader: false,
};

/**
 * Settings manager for mom.
 * Stores settings in the workspace root directory.
 */
export class MomSettingsManager {
	private settingsPath: string;
	private settings: MomSettings;
	private settingsMtimeMs: number | undefined;

	constructor(workspaceDir: string) {
		this.settingsPath = join(workspaceDir, "settings.json");
		this.settings = this.load();
	}

	private load(): MomSettings {
		if (!existsSync(this.settingsPath)) {
			this.settingsMtimeMs = undefined;
			return {};
		}

		let mtimeMs: number | undefined;
		try {
			mtimeMs = statSync(this.settingsPath).mtimeMs;
		} catch {
			mtimeMs = undefined;
		}

		try {
			const content = readFileSync(this.settingsPath, "utf-8");
			const parsed = JSON.parse(content) as MomSettings;
			this.settingsMtimeMs = mtimeMs;
			return parsed;
		} catch {
			// Keep tracking mtime even if JSON is invalid, so we can retry on edits.
			this.settingsMtimeMs = mtimeMs;
			return {};
		}
	}

	reload(): void {
		this.settings = this.load();
	}

	reloadIfChanged(): boolean {
		if (!existsSync(this.settingsPath)) {
			if (this.settingsMtimeMs !== undefined) {
				this.settingsMtimeMs = undefined;
				this.settings = {};
				return true;
			}
			return false;
		}

		let mtimeMs: number | undefined;
		try {
			mtimeMs = statSync(this.settingsPath).mtimeMs;
		} catch {
			mtimeMs = undefined;
		}

		if (mtimeMs !== undefined && this.settingsMtimeMs === mtimeMs) {
			return false;
		}

		this.reload();
		return true;
	}

	private save(): void {
		try {
			const dir = dirname(this.settingsPath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), "utf-8");
		} catch (error) {
			console.error(`Warning: Could not save settings file: ${error}`);
		}
	}

	getCompactionSettings(): MomCompactionSettings {
		return {
			...DEFAULT_COMPACTION,
			...this.settings.compaction,
		};
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? DEFAULT_COMPACTION.enabled;
	}

	setCompactionEnabled(enabled: boolean): void {
		this.settings.compaction = { ...this.settings.compaction, enabled };
		this.save();
	}

	getRetrySettings(): MomRetrySettings {
		return {
			...DEFAULT_RETRY,
			...this.settings.retry,
		};
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? DEFAULT_RETRY.enabled;
	}

	setRetryEnabled(enabled: boolean): void {
		this.settings.retry = { ...this.settings.retry, enabled };
		this.save();
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.settings.defaultProvider = provider;
		this.settings.defaultModel = modelId;
		this.save();
	}

	getDefaultThinkingLevel(): string {
		return this.settings.defaultThinkingLevel || "off";
	}

	setDefaultThinkingLevel(level: string): void {
		this.settings.defaultThinkingLevel = level as MomSettings["defaultThinkingLevel"];
		this.save();
	}

	// Compatibility methods for AgentSession
	getSteeringMode(): "all" | "one-at-a-time" {
		return "one-at-a-time"; // Mom processes one message at a time
	}

	setSteeringMode(_mode: "all" | "one-at-a-time"): void {
		// No-op for mom
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return "one-at-a-time"; // Mom processes one message at a time
	}

	setFollowUpMode(_mode: "all" | "one-at-a-time"): void {
		// No-op for mom
	}

	getTheme(): string | undefined {
		return this.settings.theme;
	}

	setTheme(theme: string): void {
		this.settings.theme = theme;
		this.save();
	}

	getShellCommandPrefix(): string | undefined {
		return this.settings.shellCommandPrefix;
	}

	setShellCommandPrefix(prefix: string | undefined): void {
		this.settings.shellCommandPrefix = prefix;
		this.save();
	}

	getBranchSummarySettings(): MomBranchSummarySettings {
		return {
			...DEFAULT_BRANCH_SUMMARY,
			...this.settings.branchSummary,
		};
	}

	getImageAutoResize(): boolean {
		return this.settings.images?.autoResize ?? DEFAULT_IMAGES.autoResize;
	}

	setImageAutoResize(enabled: boolean): void {
		this.settings.images = { ...this.settings.images, autoResize: enabled };
		this.save();
	}

	getBlockImages(): boolean {
		return this.settings.images?.blockImages ?? DEFAULT_IMAGES.blockImages;
	}

	setBlockImages(blocked: boolean): void {
		this.settings.images = { ...this.settings.images, blockImages: blocked };
		this.save();
	}

	getPostUsageSummaryToSlack(): boolean {
		return this.settings.postUsageSummaryToSlack ?? false;
	}

	setPostUsageSummaryToSlack(enabled: boolean): void {
		this.settings.postUsageSummaryToSlack = enabled;
		this.save();
	}

	getPostToolDetailsToSlack(): boolean {
		return this.settings.postToolDetailsToSlack ?? false;
	}

	setPostToolDetailsToSlack(enabled: boolean): void {
		this.settings.postToolDetailsToSlack = enabled;
		this.save();
	}

	getAutoTriggerChannels(): boolean {
		return this.settings.autoTriggerChannels ?? false;
	}

	setAutoTriggerChannels(enabled: boolean): void {
		this.settings.autoTriggerChannels = enabled;
		this.save();
	}

	getAutoTriggerChannelUserIds(): string[] | undefined {
		return this.settings.autoTriggerChannelUserIds;
	}

	setAutoTriggerChannelUserIds(userIds: string[] | undefined): void {
		this.settings.autoTriggerChannelUserIds = userIds;
		this.save();
	}

	getVibesiloSettings(): MomVibesiloSettings {
		return {
			...DEFAULT_VIBESILO,
			...this.settings.vibesilo,
			secrets: this.settings.vibesilo?.secrets,
		};
	}

	getAdminUserIds(): string[] | undefined {
		return this.settings.adminUserIds;
	}

	setAdminUserIds(userIds: string[] | undefined): void {
		this.settings.adminUserIds = userIds;
		this.save();
	}

	setVibesiloAllowNet(allowNet: string[]): void {
		this.settings.vibesilo = { ...this.settings.vibesilo, allowNet };
		this.save();
	}

	getHookPaths(): string[] {
		return []; // Mom doesn't use hooks
	}

	getHookTimeout(): number {
		return 30000;
	}
}
