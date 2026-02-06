#!/usr/bin/env node

import { join, resolve } from "path";
import { type AgentRunner, getOrCreateRunner } from "./agent.js";
import { downloadChannel } from "./download.js";
import { createEventsWatcher } from "./events.js";
import * as log from "./log.js";
import { startRpcServer } from "./rpc-server.js";
import { parseSandboxArg, type SandboxConfig, shutdownSandbox, validateSandbox } from "./sandbox.js";
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
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;
	let downloadChannelId: string | undefined;
	let rpcSocket: string | undefined;

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
		} else if (!arg.startsWith("-")) {
			workingDir = arg;
		}
	}

	return {
		workingDir: workingDir ? resolve(workingDir) : undefined,
		sandbox,
		downloadChannel: downloadChannelId,
		rpcSocket,
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

// ============================================================================
// State (per channel)
// ============================================================================

interface ChannelState {
	running: boolean;
	activeRunner: AgentRunner | null;
	store: ChannelStore;
	stopRequested: boolean;
	stopMessageTs?: string;
}

const channelStates = new Map<string, ChannelState>();

function getState(channelId: string): ChannelState {
	let state = channelStates.get(channelId);
	if (!state) {
		state = {
			running: false,
			activeRunner: null,
			store: new ChannelStore({ workingDir, botToken: MOM_SLACK_BOT_TOKEN ?? "" }),
			stopRequested: false,
		};
		channelStates.set(channelId, state);
	}
	return state;
}

// ============================================================================
// Create SlackContext adapter
// ============================================================================

function createSlackContext(
	event: SlackEvent,
	slack: SlackBot,
	state: ChannelState,
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
	let updatePromise = Promise.resolve();

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
		store: state.store,
		channels: slack.getAllChannels().map((c) => ({ id: c.id, name: c.name })),
		users: slack.getAllUsers().map((u) => ({ id: u.id, userName: u.userName, displayName: u.displayName })),

		respond: async (text: string, shouldLog = true) => {
			updatePromise = updatePromise.then(async () => {
				accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;
				const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;

				if (messageTs) {
					await slack.updateMessage(event.channel, messageTs, displayText);
				} else if (isDm) {
					messageTs = await slack.postMessage(event.channel, displayText);
				} else {
					messageTs = await slack.postInThread(event.channel, threadTs, displayText);
				}

				if (shouldLog && messageTs) {
					slack.logBotResponse(event.channel, text, messageTs, threadTs);
				}
			});
			await updatePromise;
		},

		replaceMessage: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				accumulatedText = text;
				const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
				if (messageTs) {
					await slack.updateMessage(event.channel, messageTs, displayText);
				} else if (isDm) {
					messageTs = await slack.postMessage(event.channel, displayText);
				} else {
					messageTs = await slack.postInThread(event.channel, threadTs, displayText);
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
			await slack.uploadFile(event.channel, filePath, title);
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
	isRunning(channelId: string): boolean {
		const state = channelStates.get(channelId);
		return state?.running ?? false;
	},

	async handleStop(channelId: string, slack: SlackBot): Promise<void> {
		const state = channelStates.get(channelId);
		if (state?.running) {
			state.stopRequested = true;
			state.activeRunner?.abort();
			const ts = await slack.postMessage(channelId, "_Stopping..._");
			state.stopMessageTs = ts; // Save for updating later
		} else {
			await slack.postMessage(channelId, "_Nothing running_");
		}
	},

	async handleEvent(event: SlackEvent, slack: SlackBot, isEvent?: boolean): Promise<void> {
		const state = getState(event.channel);

		// Start run
		state.running = true;
		state.stopRequested = false;

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

			const channelDir = join(workingDir, event.channel);
			const runner = getOrCreateRunner(sandbox, event.channel, channelDir, threadTs);
			state.activeRunner = runner;

			// Create context adapter
			const ctx = createSlackContext(event, slack, state, {
				threadTs,
				rootMessageTs,
				rootMessageOwned,
				isEvent,
			});

			// Run the agent
			await ctx.setTyping(true);
			await ctx.setWorking(true);
			const result = await runner.run(ctx as any, state.store);
			await ctx.setWorking(false);

			if (result.stopReason === "aborted" && state.stopRequested) {
				if (state.stopMessageTs) {
					await slack.updateMessage(event.channel, state.stopMessageTs, "_Stopped_");
					state.stopMessageTs = undefined;
				} else {
					await slack.postMessage(event.channel, "_Stopped_");
				}
			}
		} catch (err) {
			log.logWarning(`[${event.channel}] Run error`, err instanceof Error ? err.message : String(err));
		} finally {
			state.running = false;
			state.activeRunner = null;
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
		onShutdown: shutdown,
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
