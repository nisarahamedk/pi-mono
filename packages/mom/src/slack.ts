import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import { MomSettingsManager } from "./context.js";
import * as log from "./log.js";
import type { Attachment, ChannelStore } from "./store.js";

// ============================================================================
// Types
// ============================================================================

export interface SlackEvent {
	type: "mention" | "dm";
	channel: string;
	ts: string;
	/**
	 * Slack thread root timestamp.
	 *
	 * - For thread replies: this is Slack's `thread_ts`.
	 * - For top-level messages: undefined.
	 * - For DMs: not used.
	 */
	threadTs?: string;
	user: string;
	text: string;
	files?: Array<{ name?: string; url_private_download?: string; url_private?: string }>;
	/** Processed attachments with local paths (populated after logUserMessage) */
	attachments?: Attachment[];
}

export interface SlackUser {
	id: string;
	userName: string;
	displayName: string;
}

export interface SlackChannel {
	id: string;
	name: string;
}

// Types used by agent.ts
export interface ChannelInfo {
	id: string;
	name: string;
}

export interface UserInfo {
	id: string;
	userName: string;
	displayName: string;
}

export interface SlackContext {
	message: {
		text: string;
		rawText: string;
		user: string;
		userName?: string;
		channel: string;
		ts: string;
		attachments: Array<{ local: string }>;
	};
	channelName?: string;
	channels: ChannelInfo[];
	users: UserInfo[];
	respond: (text: string, shouldLog?: boolean) => Promise<void>;
	replaceMessage: (text: string) => Promise<void>;
	respondInThread: (text: string) => Promise<void>;
	setTyping: (isTyping: boolean) => Promise<void>;
	uploadFile: (filePath: string, title?: string) => Promise<void>;
	setWorking: (working: boolean) => Promise<void>;
	deleteMessage: () => Promise<void>;
}

export interface MomHandler {
	/**
	 * Check if channel is currently running (SYNC)
	 */
	isRunning(channelId: string): boolean;

	/**
	 * Handle an event that triggers mom (ASYNC)
	 * Called only when isRunning() returned false for user messages.
	 * Events always queue and pass isEvent=true.
	 */
	handleEvent(event: SlackEvent, slack: SlackBot, isEvent?: boolean): Promise<void>;

	/**
	 * Handle stop command (ASYNC)
	 * Called when user says "stop" while mom is running
	 */
	handleStop(channelId: string, slack: SlackBot): Promise<void>;
}

// ============================================================================
// Per-channel queue for sequential processing
// ============================================================================

type QueuedWork = () => Promise<void>;

class ChannelQueue {
	private queue: QueuedWork[] = [];
	private processing = false;

	enqueue(work: QueuedWork): void {
		this.queue.push(work);
		this.processNext();
	}

	size(): number {
		return this.queue.length;
	}

	private async processNext(): Promise<void> {
		if (this.processing || this.queue.length === 0) return;
		this.processing = true;
		const work = this.queue.shift()!;
		try {
			await work();
		} catch (err) {
			log.logWarning("Queue error", err instanceof Error ? err.message : String(err));
		}
		this.processing = false;
		this.processNext();
	}
}

// ============================================================================
// SlackBot
// ============================================================================

export class SlackBot {
	private socketClient: SocketModeClient;
	private webClient: WebClient;
	private handler: MomHandler;
	private workingDir: string;
	private store: ChannelStore;
	private settingsManager: MomSettingsManager;
	private botUserId: string | null = null;
	private startupTs: string | null = null; // Messages older than this are just logged, not processed
	private onRestartSandbox?: () => Promise<void>;

	private users = new Map<string, SlackUser>();
	private channels = new Map<string, SlackChannel>();
	private queues = new Map<string, ChannelQueue>();

	constructor(
		handler: MomHandler,
		config: {
			appToken: string;
			botToken: string;
			workingDir: string;
			store: ChannelStore;
			onRestartSandbox?: () => Promise<void>;
		},
	) {
		this.handler = handler;
		this.workingDir = config.workingDir;
		this.store = config.store;
		this.onRestartSandbox = config.onRestartSandbox;
		this.settingsManager = new MomSettingsManager(this.workingDir);
		this.socketClient = new SocketModeClient({ appToken: config.appToken });
		this.webClient = new WebClient(config.botToken);
	}

	// ==========================================================================
	// Public API
	// ==========================================================================

	async start(): Promise<void> {
		const auth = await this.webClient.auth.test();
		this.botUserId = auth.user_id as string;

		await Promise.all([this.fetchUsers(), this.fetchChannels()]);
		log.logInfo(`Loaded ${this.channels.size} channels, ${this.users.size} users`);

		await this.backfillAllChannels();

		this.setupEventHandlers();
		await this.socketClient.start();

		// Record startup time - messages older than this are just logged, not processed
		this.startupTs = (Date.now() / 1000).toFixed(6);

		this.settingsManager.reloadIfChanged();
		if (this.settingsManager.getAutoTriggerChannels()) {
			const allow = this.settingsManager.getAutoTriggerChannelUserIds();
			log.logInfo(
				`Auto-trigger in channels enabled` +
					(allow && allow.length > 0 ? ` (user allowlist: ${allow.join(", ")})` : " (no user allowlist)"),
			);
		}

		log.logConnected();
	}

	getUser(userId: string): SlackUser | undefined {
		return this.users.get(userId);
	}

	getChannel(channelId: string): SlackChannel | undefined {
		return this.channels.get(channelId);
	}

	getAllUsers(): SlackUser[] {
		return Array.from(this.users.values());
	}

	getAllChannels(): SlackChannel[] {
		return Array.from(this.channels.values());
	}

	async postMessage(channel: string, text: string): Promise<string> {
		const result = await this.webClient.chat.postMessage({ channel, text });
		return result.ts as string;
	}

	async postEphemeral(channel: string, user: string, text: string): Promise<void> {
		await this.webClient.chat.postEphemeral({ channel, user, text });
	}

	async updateMessage(channel: string, ts: string, text: string): Promise<void> {
		await this.webClient.chat.update({ channel, ts, text });
	}

	async deleteMessage(channel: string, ts: string): Promise<void> {
		await this.webClient.chat.delete({ channel, ts });
	}

	async postInThread(channel: string, threadTs: string, text: string): Promise<string> {
		const result = await this.webClient.chat.postMessage({ channel, thread_ts: threadTs, text });
		return result.ts as string;
	}

	async uploadFile(channel: string, filePath: string, title?: string, threadTs?: string): Promise<void> {
		const fileName = title || basename(filePath);
		const fileContent = readFileSync(filePath);
		if (threadTs) {
			await this.webClient.files.uploadV2({
				channels: channel,
				thread_ts: threadTs,
				file: fileContent,
				filename: fileName,
				title: fileName,
			});
			return;
		}

		await this.webClient.files.uploadV2({
			channels: channel,
			file: fileContent,
			filename: fileName,
			title: fileName,
		});
	}

	/**
	 * Log a message to log.jsonl (SYNC)
	 * This is the ONLY place messages are written to log.jsonl
	 */
	logToFile(channel: string, entry: object): void {
		const dir = join(this.workingDir, channel);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	/**
	 * Log a bot response to log.jsonl
	 */
	logBotResponse(channel: string, text: string, ts: string, threadTs: string): void {
		this.logToFile(channel, {
			date: new Date().toISOString(),
			ts,
			threadTs,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	// ==========================================================================
	// Events Integration
	// ==========================================================================

	/**
	 * Enqueue an event for processing. Always queues (no "already working" rejection).
	 * Returns true if enqueued, false if queue is full (max 5).
	 */
	enqueueEvent(event: SlackEvent): boolean {
		const queue = this.getQueue(event.channel);
		if (queue.size() >= 5) {
			log.logWarning(`Event queue full for ${event.channel}, discarding: ${event.text.substring(0, 50)}`);
			return false;
		}
		log.logInfo(`Enqueueing event for ${event.channel}: ${event.text.substring(0, 50)}`);
		queue.enqueue(() => this.handler.handleEvent(event, this, true));
		return true;
	}

	// ==========================================================================
	// Private - Event Handlers
	// ==========================================================================

	private getQueue(channelId: string): ChannelQueue {
		let queue = this.queues.get(channelId);
		if (!queue) {
			queue = new ChannelQueue();
			this.queues.set(channelId, queue);
		}
		return queue;
	}

	private setupEventHandlers(): void {
		// Slash commands (Socket Mode)
		this.socketClient.on("slash_commands", ({ body, ack }) => {
			// Ack immediately, do work async.
			ack();

			void (async () => {
				const b = body as {
					command?: string;
					text?: string;
					user_id?: string;
					channel_id?: string;
				};

				const command = b.command || "/rootclaw";
				const text = (b.text || "").trim();
				const userId = b.user_id;
				const channelId = b.channel_id;

				if (!userId || !channelId) return;

				this.settingsManager.reloadIfChanged();
				const adminUserIds =
					this.settingsManager.getAdminUserIds() ?? this.settingsManager.getAutoTriggerChannelUserIds();
				const isAdmin = !!adminUserIds && adminUserIds.length > 0 && adminUserIds.includes(userId);

				const reply = async (msg: string) => {
					try {
						await this.postEphemeral(channelId, userId, msg);
					} catch (err) {
						log.logWarning(
							`Slash command reply failed (${command})`,
							err instanceof Error ? err.message : String(err),
						);
					}
				};

				const args = text.split(/\s+/).filter(Boolean);
				const sub = args[0];

				const help =
					`*${command}* supports:\n` +
					`• \`${command} status\`\n` +
					`• \`${command} allow-net list\`\n` +
					`• \`${command} allow-net add <host> [--restart]\`\n` +
					`• \`${command} allow-net remove <host> [--restart]\`\n` +
					`• \`${command} restart-sandbox\`\n` +
					`\n` +
					`Admin-only: allow-net add/remove, restart-sandbox`;

				if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
					await reply(help);
					return;
				}

				if (sub === "status") {
					const vibesilo = this.settingsManager.getVibesiloSettings();
					const allowNet = vibesilo.allowNet ?? [];
					await reply(
						`Workspace: \`${this.workingDir}\`\n` +
							`vibesilo.image: \`${vibesilo.image ?? "(default)"}\`\n` +
							`vibesilo.allowNet: ${allowNet.length} entr${allowNet.length === 1 ? "y" : "ies"}`,
					);
					return;
				}

				// Privileged commands
				if (!isAdmin) {
					await reply(
						`Not authorized. Add your Slack user id to \`adminUserIds\` in settings.json (or ensure autoTriggerChannelUserIds contains you).`,
					);
					return;
				}

				const normalizeHost = (input: string): string => {
					let s = input.trim();
					s = s.replace(/^[a-zA-Z]+:\/\//, "");
					s = s.split("/")[0] || s;
					s = s.split("?")[0] || s;
					s = s.split("#")[0] || s;
					return s;
				};

				const maybeRestart = async (explicit?: boolean) => {
					if (!explicit) return;
					if (!this.onRestartSandbox) {
						await reply("Sandbox restart not available in this mom process.");
						return;
					}
					try {
						await this.onRestartSandbox();
						await reply(
							"Sandbox restart requested. Next tool run will recreate the vibesilo sandbox with the new config.",
						);
					} catch (err) {
						await reply(`Failed to restart sandbox: ${err instanceof Error ? err.message : String(err)}`);
					}
				};

				if (sub === "restart-sandbox") {
					await maybeRestart(true);
					return;
				}

				if (sub === "allow-net") {
					const action = args[1];
					const hostArg = args[2];
					const restart = args.includes("--restart");
					const vibesilo = this.settingsManager.getVibesiloSettings();
					const allowNet = [...(vibesilo.allowNet ?? [])];

					if (action === "list") {
						await reply(
							allowNet.length > 0
								? `vibesilo.allowNet:\n\n\`${allowNet.join("\n")}\``
								: "vibesilo.allowNet is empty (this should be disallowed for vibesilo).",
						);
						return;
					}

					if (!hostArg) {
						await reply(`Missing host.\n\n${help}`);
						return;
					}

					const host = normalizeHost(hostArg);
					if (!host) {
						await reply(`Invalid host: '${hostArg}'`);
						return;
					}

					if (action === "add") {
						if (!allowNet.includes(host)) {
							allowNet.push(host);
							allowNet.sort();
							this.settingsManager.setVibesiloAllowNet(allowNet);
						}
						await reply(`Added \`${host}\` to vibesilo.allowNet. ${restart ? "Restarting sandbox..." : ""}`);
						await maybeRestart(restart);
						return;
					}

					if (action === "remove" || action === "rm") {
						const next = allowNet.filter((h) => h !== host);
						if (next.length === allowNet.length) {
							await reply(`Host not present: \`${host}\``);
							return;
						}
						if (next.length === 0) {
							await reply(
								"Refusing to make vibesilo.allowNet empty (vibesilo treats empty as allow-all). Add another host first.",
							);
							return;
						}
						this.settingsManager.setVibesiloAllowNet(next);
						await reply(`Removed \`${host}\` from vibesilo.allowNet. ${restart ? "Restarting sandbox..." : ""}`);
						await maybeRestart(restart);
						return;
					}

					await reply(`Unknown allow-net action: '${action}'.\n\n${help}`);
					return;
				}

				await reply(`Unknown subcommand: '${sub}'.\n\n${help}`);
			})();
		});
		// Channel @mentions
		this.socketClient.on("app_mention", ({ event, ack }) => {
			const e = event as {
				text: string;
				channel: string;
				user: string;
				ts: string;
				thread_ts?: string;
				files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
			};

			// Skip DMs (handled by message event)
			if (e.channel.startsWith("D")) {
				ack();
				return;
			}

			const slackEvent: SlackEvent = {
				type: "mention",
				channel: e.channel,
				ts: e.ts,
				threadTs: e.thread_ts,
				user: e.user,
				text: e.text.replace(/<@[A-Z0-9]+>/gi, "").trim(),
				files: e.files,
			};

			// SYNC: Log to log.jsonl (ALWAYS, even for old messages)
			// Also downloads attachments in background and stores local paths
			slackEvent.attachments = this.logUserMessage(slackEvent);

			// Only trigger processing for messages AFTER startup (not replayed old messages)
			if (this.startupTs && e.ts < this.startupTs) {
				log.logInfo(
					`[${e.channel}] Logged old message (pre-startup), not triggering: ${slackEvent.text.substring(0, 30)}`,
				);
				ack();
				return;
			}

			// Check for stop command - execute immediately, don't queue!
			if (slackEvent.text.toLowerCase().trim() === "stop") {
				if (this.handler.isRunning(e.channel)) {
					this.handler.handleStop(e.channel, this); // Don't await, don't queue
				} else {
					this.postMessage(e.channel, "_Nothing running_");
				}
				ack();
				return;
			}

			// SYNC: Check if busy
			if (this.handler.isRunning(e.channel)) {
				const threadRoot = e.thread_ts ?? e.ts;
				this.postInThread(e.channel, threadRoot, "_Already working. Say `@mom stop` to cancel._");
			} else {
				this.getQueue(e.channel).enqueue(() => this.handler.handleEvent(slackEvent, this));
			}

			ack();
		});

		// All messages (for logging) + DMs (for triggering)
		this.socketClient.on("message", ({ event, ack }) => {
			const e = event as {
				text?: string;
				channel: string;
				user?: string;
				ts: string;
				thread_ts?: string;
				channel_type?: string;
				subtype?: string;
				bot_id?: string;
				files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
			};

			this.settingsManager.reloadIfChanged();

			// Skip bot messages, edits, etc.
			if (e.bot_id || !e.user || e.user === this.botUserId) {
				ack();
				return;
			}
			if (e.subtype !== undefined && e.subtype !== "file_share") {
				ack();
				return;
			}
			if (!e.text && (!e.files || e.files.length === 0)) {
				ack();
				return;
			}

			const isDM = e.channel_type === "im";
			const isBotMention = e.text?.includes(`<@${this.botUserId}>`);

			// Skip channel @mentions - already handled by app_mention event
			if (!isDM && isBotMention) {
				ack();
				return;
			}

			const slackEvent: SlackEvent = {
				type: isDM ? "dm" : "mention",
				channel: e.channel,
				ts: e.ts,
				threadTs: e.thread_ts,
				user: e.user,
				text: (e.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim(),
				files: e.files,
			};

			// SYNC: Log to log.jsonl (ALL messages - channel chatter and DMs)
			// Also downloads attachments in background and stores local paths
			slackEvent.attachments = this.logUserMessage(slackEvent);

			// Only trigger processing for messages AFTER startup (not replayed old messages)
			if (this.startupTs && e.ts < this.startupTs) {
				log.logInfo(`[${e.channel}] Skipping old message (pre-startup): ${slackEvent.text.substring(0, 30)}`);
				ack();
				return;
			}

			const autoTriggerChannels = !isDM && this.settingsManager.getAutoTriggerChannels();
			const autoTriggerUserIds = this.settingsManager.getAutoTriggerChannelUserIds();
			const autoTriggerUserAllowed =
				autoTriggerChannels &&
				(!autoTriggerUserIds || autoTriggerUserIds.length === 0 || autoTriggerUserIds.includes(e.user));

			// Trigger handler for DMs
			if (isDM) {
				// Check for stop command - execute immediately, don't queue!
				if (slackEvent.text.toLowerCase().trim() === "stop") {
					if (this.handler.isRunning(e.channel)) {
						this.handler.handleStop(e.channel, this); // Don't await, don't queue
					} else {
						this.postMessage(e.channel, "_Nothing running_");
					}
					ack();
					return;
				}

				if (this.handler.isRunning(e.channel)) {
					this.postMessage(e.channel, "_Already working. Say `stop` to cancel._");
				} else {
					this.getQueue(e.channel).enqueue(() => this.handler.handleEvent(slackEvent, this));
				}
			} else if (autoTriggerUserAllowed) {
				// Auto-trigger in channels: top-level messages start a thread, thread replies continue it.
				const threadRoot = e.thread_ts ?? e.ts;

				// Stop command in channels (if auto-triggering): execute immediately, don't queue!
				if (slackEvent.text.toLowerCase().trim() === "stop") {
					if (this.handler.isRunning(e.channel)) {
						this.handler.handleStop(e.channel, this); // Don't await, don't queue
					} else {
						this.postInThread(e.channel, threadRoot, "_Nothing running_");
					}
					ack();
					return;
				}

				if (this.handler.isRunning(e.channel)) {
					this.postInThread(e.channel, threadRoot, "_Already working. Say `@mom stop` to cancel._");
				} else {
					this.getQueue(e.channel).enqueue(() => this.handler.handleEvent(slackEvent, this));
				}
			}

			ack();
		});
	}

	/**
	 * Log a user message to log.jsonl (SYNC)
	 * Downloads attachments in background via store
	 */
	private logUserMessage(event: SlackEvent): Attachment[] {
		const user = this.users.get(event.user);
		// Process attachments - queues downloads in background
		const attachments = event.files ? this.store.processAttachments(event.channel, event.files, event.ts) : [];

		// Normalize to a thread root key so we can maintain per-thread contexts.
		// - DMs: single conversation key ("dm")
		// - Thread replies: Slack's thread_ts
		// - Top-level channel messages: their own ts becomes the thread root
		const threadTs = event.type === "dm" ? "dm" : (event.threadTs ?? event.ts);

		this.logToFile(event.channel, {
			date: new Date(parseFloat(event.ts) * 1000).toISOString(),
			ts: event.ts,
			threadTs,
			user: event.user,
			userName: user?.userName,
			displayName: user?.displayName,
			text: event.text,
			attachments,
			isBot: false,
		});
		return attachments;
	}

	// ==========================================================================
	// Private - Backfill
	// ==========================================================================

	private getExistingTimestamps(channelId: string): Set<string> {
		const logPath = join(this.workingDir, channelId, "log.jsonl");
		const timestamps = new Set<string>();
		if (!existsSync(logPath)) return timestamps;

		const content = readFileSync(logPath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.ts) timestamps.add(entry.ts);
			} catch {}
		}
		return timestamps;
	}

	private async backfillChannel(channelId: string): Promise<number> {
		const existingTs = this.getExistingTimestamps(channelId);

		// Find the biggest ts in log.jsonl
		let latestTs: string | undefined;
		for (const ts of existingTs) {
			if (!latestTs || parseFloat(ts) > parseFloat(latestTs)) latestTs = ts;
		}

		type Message = {
			user?: string;
			bot_id?: string;
			text?: string;
			ts?: string;
			thread_ts?: string;
			subtype?: string;
			files?: Array<{ name: string }>;
		};
		const allMessages: Message[] = [];

		let cursor: string | undefined;
		let pageCount = 0;
		const maxPages = 3;

		do {
			const result = await this.webClient.conversations.history({
				channel: channelId,
				oldest: latestTs, // Only fetch messages newer than what we have
				inclusive: false,
				limit: 1000,
				cursor,
			});
			if (result.messages) {
				allMessages.push(...(result.messages as Message[]));
			}
			cursor = result.response_metadata?.next_cursor;
			pageCount++;
		} while (cursor && pageCount < maxPages);

		// Filter: include mom's messages, exclude other bots, skip already logged
		const relevantMessages = allMessages.filter((msg) => {
			if (!msg.ts || existingTs.has(msg.ts)) return false; // Skip duplicates
			if (msg.user === this.botUserId) return true;
			if (msg.bot_id) return false;
			if (msg.subtype !== undefined && msg.subtype !== "file_share") return false;
			if (!msg.user) return false;
			if (!msg.text && (!msg.files || msg.files.length === 0)) return false;
			return true;
		});

		// Reverse to chronological order
		relevantMessages.reverse();

		// Log each message to log.jsonl
		for (const msg of relevantMessages) {
			const isMomMessage = msg.user === this.botUserId;
			const user = this.users.get(msg.user!);
			// Strip @mentions from text (same as live messages)
			const text = (msg.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim();
			// Process attachments - queues downloads in background
			const attachments = msg.files ? this.store.processAttachments(channelId, msg.files, msg.ts!) : [];

			const threadTs = channelId.startsWith("D") ? "dm" : (msg.thread_ts ?? msg.ts!);
			this.logToFile(channelId, {
				date: new Date(parseFloat(msg.ts!) * 1000).toISOString(),
				ts: msg.ts!,
				threadTs,
				user: isMomMessage ? "bot" : msg.user!,
				userName: isMomMessage ? undefined : user?.userName,
				displayName: isMomMessage ? undefined : user?.displayName,
				text,
				attachments,
				isBot: isMomMessage,
			});
		}

		return relevantMessages.length;
	}

	private async backfillAllChannels(): Promise<void> {
		const startTime = Date.now();

		// Only backfill channels that already have a log.jsonl (mom has interacted with them before)
		const channelsToBackfill: Array<[string, SlackChannel]> = [];
		for (const [channelId, channel] of this.channels) {
			const logPath = join(this.workingDir, channelId, "log.jsonl");
			if (existsSync(logPath)) {
				channelsToBackfill.push([channelId, channel]);
			}
		}

		log.logBackfillStart(channelsToBackfill.length);

		let totalMessages = 0;
		for (const [channelId, channel] of channelsToBackfill) {
			try {
				const count = await this.backfillChannel(channelId);
				if (count > 0) log.logBackfillChannel(channel.name, count);
				totalMessages += count;
			} catch (error) {
				log.logWarning(`Failed to backfill #${channel.name}`, String(error));
			}
		}

		const durationMs = Date.now() - startTime;
		log.logBackfillComplete(totalMessages, durationMs);
	}

	// ==========================================================================
	// Private - Fetch Users/Channels
	// ==========================================================================

	private async fetchUsers(): Promise<void> {
		let cursor: string | undefined;
		do {
			const result = await this.webClient.users.list({ limit: 200, cursor });
			const members = result.members as
				| Array<{ id?: string; name?: string; real_name?: string; deleted?: boolean }>
				| undefined;
			if (members) {
				for (const u of members) {
					if (u.id && u.name && !u.deleted) {
						this.users.set(u.id, { id: u.id, userName: u.name, displayName: u.real_name || u.name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);
	}

	private async fetchChannels(): Promise<void> {
		// Fetch public/private channels
		let cursor: string | undefined;
		do {
			const result = await this.webClient.conversations.list({
				types: "public_channel,private_channel",
				exclude_archived: true,
				limit: 200,
				cursor,
			});
			const channels = result.channels as Array<{ id?: string; name?: string; is_member?: boolean }> | undefined;
			if (channels) {
				for (const c of channels) {
					if (c.id && c.name && c.is_member) {
						this.channels.set(c.id, { id: c.id, name: c.name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);

		// Also fetch DM channels (IMs)
		cursor = undefined;
		do {
			const result = await this.webClient.conversations.list({
				types: "im",
				limit: 200,
				cursor,
			});
			const ims = result.channels as Array<{ id?: string; user?: string }> | undefined;
			if (ims) {
				for (const im of ims) {
					if (im.id) {
						// Use user's name as channel name for DMs
						const user = im.user ? this.users.get(im.user) : undefined;
						const name = user ? `DM:${user.userName}` : `DM:${im.id}`;
						this.channels.set(im.id, { id: im.id, name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);
	}
}
