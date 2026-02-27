#!/usr/bin/env node

import { join, resolve } from "path";
import { type AgentRunner, getOrCreateRunner } from "./agent.js";
import { downloadChannel } from "./download.js";
import { createEventsWatcher } from "./events.js";
import * as log from "./log.js";
import { startRpcServer } from "./rpc-server.js";
import {
	ensureHostBrowserAtGatewayStart,
	parseSandboxArg,
	type SandboxConfig,
	shutdownSandbox,
	validateSandbox,
} from "./sandbox.js";
import { type MomHandler, type SlackBot, SlackBot as SlackBotClass, type SlackEvent } from "./slack.js";
import { ChannelStore } from "./store.js";

// ============================================================================
// Config
// ============================================================================

const MOM_SLACK_APP_TOKEN = process.env.MOM_SLACK_APP_TOKEN;
const MOM_SLACK_BOT_TOKEN = process.env.MOM_SLACK_BOT_TOKEN;

interface ParsedArgs {
	workingDir?: string;
	sandbox: SandboxConfig;
	downloadChannel?: string;
	rpcSocket?: string;
	extensions?: string[];
	noExtensions?: boolean;
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;
	let downloadChannelId: string | undefined;
	let rpcSocket: string | undefined;
	const extensions: string[] = [];
	let noExtensions = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--sandbox=")) {
			sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
		} else if (arg === "--sandbox") {
			sandbox = parseSandboxArg(args[++i] || "");
		} else if (arg.startsWith("--download=")) {
			downloadChannelId = arg.slice("--download=".length);
		} else if (arg === "--download") {
			downloadChannelId = args[++i];
		} else if (arg.startsWith("--rpc-socket=")) {
			rpcSocket = arg.slice("--rpc-socket=".length);
		} else if (arg === "--rpc-socket") {
			rpcSocket = args[++i] || "";
		} else if (arg === "-e" || arg === "--extension") {
			extensions.push(args[++i]);
		} else if (arg.startsWith("--extension=")) {
			extensions.push(arg.slice("--extension=".length));
		} else if (arg === "--no-extensions") {
			noExtensions = true;
		} else if (!arg.startsWith("-")) {
			workingDir = arg;
		}
	}

	return {
		workingDir: workingDir ? resolve(workingDir) : undefined,
		sandbox,
		downloadChannel: downloadChannelId,
		rpcSocket,
		extensions: extensions.length > 0 ? extensions : undefined,
		noExtensions,
	};
}

const parsedArgs = parseArgs();

// Handle --download mode
if (parsedArgs.downloadChannel) {
	if (!MOM_SLACK_BOT_TOKEN) {
		console.error("Missing env: MOM_SLACK_BOT_TOKEN");
		process.exit(1);
	}
	await downloadChannel(parsedArgs.downloadChannel, MOM_SLACK_BOT_TOKEN);
	process.exit(0);
}

// Normal bot mode - require working dir
if (!parsedArgs.workingDir) {
	console.error("Usage: mom [--sandbox=host|vibesilo|docker:<name>] <working-directory>");
	console.error("       mom --download <channel-id>");
	process.exit(1);
}

const { workingDir, sandbox, rpcSocket } = {
	workingDir: parsedArgs.workingDir,
	sandbox: parsedArgs.sandbox,
	rpcSocket: parsedArgs.rpcSocket,
};

const rpcOnly = rpcSocket !== undefined && (!MOM_SLACK_APP_TOKEN || !MOM_SLACK_BOT_TOKEN);

if (!rpcOnly && (!MOM_SLACK_APP_TOKEN || !MOM_SLACK_BOT_TOKEN)) {
	console.error("Missing env: MOM_SLACK_APP_TOKEN, MOM_SLACK_BOT_TOKEN");
	process.exit(1);
}

await validateSandbox(sandbox, workingDir);
await ensureHostBrowserAtGatewayStart(sandbox, workingDir);

// ============================================================================
// State (per thread)
// ============================================================================

interface ThreadRunState {
	running: boolean;
	activeRunner: AgentRunner | null;
	stopRequested: boolean;
	stopMessageTs?: string;
}

const threadStates = new Map<string, ThreadRunState>();
const channelStores = new Map<string, ChannelStore>();

function makeThreadKey(channelId: string, threadTs: string): string {
	return `${channelId}:${threadTs}`;
}

function getChannelStore(channelId: string): ChannelStore {
	let store = channelStores.get(channelId);
	if (!store) {
		store = new ChannelStore({ workingDir, botToken: MOM_SLACK_BOT_TOKEN ?? "" });
		channelStores.set(channelId, store);
	}
	return store;
}

function getThreadState(channelId: string, threadTs: string): ThreadRunState {
	const key = makeThreadKey(channelId, threadTs);
	let state = threadStates.get(key);
	if (!state) {
		state = {
			running: false,
			activeRunner: null,
			stopRequested: false,
		};
		threadStates.set(key, state);
	}
	return state;
}

// ============================================================================
// Create SlackContext adapter
// ============================================================================

function createSlackContext(
	event: SlackEvent,
	slack: SlackBot,
	store: ChannelStore,
	options: {
		threadTs?: string;
		rootMessageTs?: string;
		rootMessageOwned?: boolean;
		isEvent?: boolean;
	},
) {
	let messageTs: string | null = null;
	const threadMessageTs: string[] = [];
	let accumulatedText = "";
	let isWorking = true;
	const workingIndicator = " ...";
	const SLACK_SAFE_MAIN_LIMIT = 30000;
	const SLACK_THREAD_CHUNK = 35000;
	let updatePromise = Promise.resolve();

	const splitForSlack = (text: string, limit: number): string[] => {
		if (text.length <= limit) return [text];
		const parts: string[] = [];
		let i = 0;
		while (i < text.length) {
			parts.push(text.slice(i, i + limit));
			i += limit;
		}
		return parts;
	};

	const user = slack.getUser(event.user);

	const isDm = event.type === "dm";
	const threadTs = isDm ? "dm" : (options.threadTs ?? event.ts);
	const rootMessageTs = options.rootMessageTs ?? null;
	const rootMessageOwned = options.rootMessageOwned ?? false;

	// Extract event filename for status message
	const eventFilename = options.isEvent ? event.text.match(/^\[EVENT:([^:]+):/)?.[1] : undefined;

	return {
		message: {
			text: event.text,
			rawText: event.text,
			user: event.user,
			userName: user?.userName,
			channel: event.channel,
			ts: event.ts,
			attachments: (event.attachments || []).map((a) => ({ local: a.local })),
		},
		channelName: slack.getChannel(event.channel)?.name,
		store,
		channels: slack.getAllChannels().map((c) => ({ id: c.id, name: c.name })),
		users: slack.getAllUsers().map((u) => ({ id: u.id, userName: u.userName, displayName: u.displayName })),

		respond: async (text: string, shouldLog = true) => {
			updatePromise = updatePromise.then(async () => {
				let overflow = "";
				const next = accumulatedText ? `${accumulatedText}\n${text}` : text;
				if (next.length <= SLACK_SAFE_MAIN_LIMIT) {
					accumulatedText = next;
				} else {
					const separator = accumulatedText ? "\n" : "";
					const budget = Math.max(0, SLACK_SAFE_MAIN_LIMIT - accumulatedText.length - separator.length);
					const head = text.slice(0, budget);
					overflow = text.slice(budget);
					accumulatedText = accumulatedText ? `${accumulatedText}${separator}${head}` : head;
					if (!accumulatedText.includes("_(continued in thread)_")) {
						accumulatedText = `${accumulatedText}\n\n_(continued in thread)_`;
					}
				}

				const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;

				if (messageTs) {
					await slack.updateMessage(event.channel, messageTs, displayText);
				} else if (isDm) {
					messageTs = await slack.postMessage(event.channel, displayText);
				} else {
					messageTs = await slack.postInThread(event.channel, threadTs, displayText);
				}

				if (overflow.length > 0) {
					for (const part of splitForSlack(overflow, SLACK_THREAD_CHUNK)) {
						if (isDm) {
							const ts = await slack.postMessage(event.channel, part);
							threadMessageTs.push(ts);
						} else {
							const ts = await slack.postInThread(event.channel, threadTs, part);
							threadMessageTs.push(ts);
						}
					}
				}

				if (shouldLog && messageTs) {
					slack.logBotResponse(event.channel, text, messageTs, threadTs);
				}
			});
			await updatePromise;
		},

		replaceMessage: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				const parts = splitForSlack(text, SLACK_THREAD_CHUNK);
				accumulatedText = parts[0] ?? "";
				if (accumulatedText.length > SLACK_SAFE_MAIN_LIMIT) {
					accumulatedText = `${accumulatedText.slice(0, SLACK_SAFE_MAIN_LIMIT)}\n\n_(continued in thread)_`;
				}
				const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
				if (messageTs) {
					await slack.updateMessage(event.channel, messageTs, displayText);
				} else if (isDm) {
					messageTs = await slack.postMessage(event.channel, displayText);
				} else {
					messageTs = await slack.postInThread(event.channel, threadTs, displayText);
				}

				for (let i = 1; i < parts.length; i++) {
					const part = parts[i];
					if (!part) continue;
					if (isDm) {
						const ts = await slack.postMessage(event.channel, part);
						threadMessageTs.push(ts);
					} else {
						const ts = await slack.postInThread(event.channel, threadTs, part);
						threadMessageTs.push(ts);
					}
				}
			});
			await updatePromise;
		},

		respondInThread: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				if (isDm) {
					const ts = await slack.postMessage(event.channel, text);
					threadMessageTs.push(ts);
					return;
				}

				const ts = await slack.postInThread(event.channel, threadTs, text);
				threadMessageTs.push(ts);
			});
			await updatePromise;
		},

		setTyping: async (isTyping: boolean) => {
			if (isTyping && !messageTs) {
				updatePromise = updatePromise.then(async () => {
					if (messageTs) return;

					accumulatedText = eventFilename ? `_Starting event: ${eventFilename}_` : "_Thinking_";
					const displayText = accumulatedText + workingIndicator;

					if (isDm) {
						messageTs = await slack.postMessage(event.channel, displayText);
					} else {
						messageTs = await slack.postInThread(event.channel, threadTs, displayText);
					}
				});
				await updatePromise;
			}
		},

		uploadFile: async (filePath: string, title?: string) => {
			// Ensure uploads end up in the same thread as the main response.
			// DMs do not use threads for uploads.
			await slack.uploadFile(event.channel, filePath, title, isDm ? undefined : threadTs);
		},

		setWorking: async (working: boolean) => {
			updatePromise = updatePromise.then(async () => {
				isWorking = working;
				if (messageTs) {
					const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
					await slack.updateMessage(event.channel, messageTs, displayText);
				}
			});
			await updatePromise;
		},

		deleteMessage: async () => {
			updatePromise = updatePromise.then(async () => {
				// Delete thread/extra messages first (in reverse order)
				for (let i = threadMessageTs.length - 1; i >= 0; i--) {
					try {
						await slack.deleteMessage(event.channel, threadMessageTs[i]);
					} catch {
						// Ignore
					}
				}
				threadMessageTs.length = 0;

				// Delete main bot message (either DM message or the primary thread reply)
				if (messageTs) {
					try {
						await slack.deleteMessage(event.channel, messageTs);
					} catch {
						// Ignore
					}
					messageTs = null;
				}

				// For events, we may own the thread root top-level message.
				if (rootMessageOwned && rootMessageTs) {
					try {
						await slack.deleteMessage(event.channel, rootMessageTs);
					} catch {
						// Ignore
					}
				}
			});
			await updatePromise;
		},
	};
}

// ============================================================================
// Handler
// ============================================================================

const handler: MomHandler = {
	isRunning(channelId: string, threadTs: string): boolean {
		const state = threadStates.get(makeThreadKey(channelId, threadTs));
		return state?.running ?? false;
	},

	async handleStop(channelId: string, threadTs: string, slack: SlackBot): Promise<void> {
		const state = threadStates.get(makeThreadKey(channelId, threadTs));
		if (state?.running) {
			state.stopRequested = true;
			state.activeRunner?.abort();
			if (threadTs === "dm") {
				const ts = await slack.postMessage(channelId, "_Stopping..._");
				state.stopMessageTs = ts;
			} else {
				const ts = await slack.postInThread(channelId, threadTs, "_Stopping..._");
				state.stopMessageTs = ts;
			}
		} else {
			if (threadTs === "dm") await slack.postMessage(channelId, "_Nothing running_");
			else await slack.postInThread(channelId, threadTs, "_Nothing running_");
		}
	},

	async handleEvent(event: SlackEvent, slack: SlackBot, isEvent?: boolean): Promise<void> {
		const channelStore = getChannelStore(event.channel);

		log.logInfo(`[${event.channel}] Starting run: ${event.text.substring(0, 50)}`);

		let threadTs: string;
		let rootMessageTs: string | undefined;
		let rootMessageOwned = false;

		try {
			if (isEvent) {
				const eventFilename = event.text.match(/^\[EVENT:([^:]+):/)?.[1] ?? "event";
				const rootText = `_Starting event: ${eventFilename}_`;
				rootMessageTs = await slack.postMessage(event.channel, rootText);
				rootMessageOwned = true;
				threadTs = rootMessageTs;
				slack.logBotResponse(event.channel, rootText, rootMessageTs, threadTs);
			} else if (event.type === "dm") {
				threadTs = "dm";
			} else {
				threadTs = event.threadTs ?? event.ts;
			}

			const state = getThreadState(event.channel, threadTs);

			// Start run
			state.running = true;
			state.stopRequested = false;

			const channelDir = join(workingDir, event.channel);
			const runner = getOrCreateRunner(
				sandbox,
				event.channel,
				channelDir,
				threadTs,
				parsedArgs.extensions,
				parsedArgs.noExtensions,
			);
			state.activeRunner = runner;

			// Create context adapter
			const ctx = createSlackContext(event, slack, channelStore, {
				threadTs,
				rootMessageTs,
				rootMessageOwned,
				isEvent,
			});

			// Run the agent
			await ctx.setTyping(true);
			await ctx.setWorking(true);
			const result = await runner.run(ctx as any, channelStore);
			await ctx.setWorking(false);

			if (result.stopReason === "aborted" && state.stopRequested) {
				if (state.stopMessageTs) {
					await slack.updateMessage(event.channel, state.stopMessageTs, "_Stopped_");
					state.stopMessageTs = undefined;
				} else if (threadTs === "dm") {
					await slack.postMessage(event.channel, "_Stopped_");
				} else {
					await slack.postInThread(event.channel, threadTs, "_Stopped_");
				}
			}
		} catch (err) {
			log.logWarning(`[${event.channel}] Run error`, err instanceof Error ? err.message : String(err));
		} finally {
			const doneThreadTs =
				isEvent && rootMessageTs ? rootMessageTs : event.type === "dm" ? "dm" : (event.threadTs ?? event.ts);
			const doneState = threadStates.get(makeThreadKey(event.channel, doneThreadTs));
			if (doneState) {
				doneState.running = false;
				doneState.activeRunner = null;
			}
		}
	},
};

// ============================================================================
// Start
// ============================================================================

log.logStartup(
	workingDir,
	sandbox.type === "host" ? "host" : sandbox.type === "docker" ? `docker:${sandbox.container}` : "vibesilo",
);

// Shared store for attachment downloads (also used per-channel in getState)
const sharedStore = new ChannelStore({ workingDir, botToken: MOM_SLACK_BOT_TOKEN ?? "" });

const bot = rpcOnly
	? null
	: new SlackBotClass(handler, {
			appToken: MOM_SLACK_APP_TOKEN!,
			botToken: MOM_SLACK_BOT_TOKEN!,
			workingDir,
			store: sharedStore,
			onRestartSandbox: async () => {
				// Only applicable for vibesilo. Refuse restart if any channel is currently running.
				if (sandbox.type !== "vibesilo") {
					throw new Error("Sandbox restart is only supported for --sandbox=vibesilo");
				}
				const anyRunning = Array.from(threadStates.values()).some((s) => s.running);
				if (anyRunning) {
					throw new Error("Mom is currently running in at least one channel. Stop it first, then retry.");
				}
				await shutdownSandbox(sandbox);
			},
		});

// Start events watcher (Slack mode only)
const eventsWatcher = bot ? createEventsWatcher(workingDir, bot) : null;
if (eventsWatcher) {
	eventsWatcher.start();
}

// Handle shutdown
let shuttingDown = false;
const shutdown = async (signal: string) => {
	if (shuttingDown) return;
	shuttingDown = true;
	log.logInfo(`Shutting down (${signal})...`);
	try {
		if (eventsWatcher) {
			eventsWatcher.stop();
		}
		if (rpcHandle) {
			try {
				await rpcHandle.close();
			} catch {
				// ignore
			}
			rpcHandle = null;
		}
		await shutdownSandbox(sandbox);
	} finally {
		process.exit(0);
	}
};

// Optional RPC socket for smoke testing (mom-cli)
let rpcHandle: { close(): Promise<void> } | null = null;
if (rpcSocket !== undefined) {
	const socketPath = rpcSocket && rpcSocket.length > 0 ? rpcSocket : join(workingDir, ".mom.sock");
	rpcHandle = await startRpcServer({
		workingDir,
		sandbox,
		socketPath,
		botToken: MOM_SLACK_BOT_TOKEN!,
		extensions: parsedArgs.extensions,
		noExtensions: parsedArgs.noExtensions,
		onShutdown: shutdown,
		onRestartSandbox: async () => {
			if (sandbox.type !== "vibesilo") {
				throw new Error("Sandbox restart is only supported for --sandbox=vibesilo");
			}
			const anyRunning = Array.from(threadStates.values()).some((s) => s.running);
			if (anyRunning) {
				throw new Error("Mom is currently running in at least one channel. Stop it first, then retry.");
			}
			await shutdownSandbox(sandbox);
		},
	});
	log.logInfo(`RPC socket enabled: ${socketPath}`);
}

process.on("SIGINT", () => {
	void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
	void shutdown("SIGTERM");
});

if (bot) {
	bot.start();
} else {
	log.logInfo("RPC-only mode: Slack disabled (missing MOM_SLACK_APP_TOKEN/MOM_SLACK_BOT_TOKEN)");
}
