import { appendFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { type AgentRunner, getOrCreateRunner } from "./agent.js";
import { MomSettingsManager } from "./context.js";
import type { SandboxConfig } from "./sandbox.js";
import type { SlackContext } from "./slack.js";
import { ChannelStore } from "./store.js";

export type RpcRequest =
	| {
			id?: string;
			type: "prompt";
			channelId?: string;
			session: string;
			userId?: string;
			userName?: string;
			text: string;
	  }
	| {
			id?: string;
			type: "new_session";
	  }
	| {
			id?: string;
			type: "abort";
			channelId?: string;
			session: string;
	  }
	| {
			id?: string;
			type: "shutdown";
	  }
	| {
			id?: string;
			type: "status";
	  }
	| {
			id?: string;
			type: "restart_sandbox";
	  }
	| {
			id?: string;
			type: "allow_net";
			action: "list" | "add" | "remove";
			host?: string;
			restart?: boolean;
	  };

export type RpcResponse =
	| { type: "response"; id?: string; success: true; data?: unknown }
	| { type: "response"; id?: string; success: false; error: string };

export type RpcEvent =
	| { type: "event"; id?: string; event: "respond" | "replace" | "thread" | "system"; text: string }
	| { type: "done"; id?: string; stopReason: string; errorMessage?: string };

export interface RpcServerOptions {
	workingDir: string;
	sandbox: SandboxConfig;
	socketPath: string;
	botToken: string;
	onShutdown: (reason: string) => Promise<void>;
	onRestartSandbox?: () => Promise<void>;
}

export interface RpcServerHandle {
	socketPath: string;
	close(): Promise<void>;
}

function nowSlackTs(): string {
	return (Date.now() / 1000).toFixed(6);
}

function generateSessionId(): string {
	// Slack-like ts works well as a stable thread key
	return nowSlackTs();
}

function logToFile(workingDir: string, channelId: string, entry: object): void {
	const dir = `${workingDir}/${channelId}`;
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	appendFileSync(`${dir}/log.jsonl`, `${JSON.stringify(entry)}\n`);
}

function createRpcContext(params: {
	workingDir: string;
	channelId: string;
	threadTs: string;
	userId: string;
	userName: string;
	text: string;
	emit: (evt: RpcEvent) => void;
	requestId?: string;
}): { ctx: SlackContext; flushBotLog: () => void } {
	const ts = nowSlackTs();
	const { workingDir, channelId, threadTs, userId, userName, text, emit, requestId } = params;

	logToFile(workingDir, channelId, {
		date: new Date().toISOString(),
		ts,
		threadTs,
		user: userId,
		userName,
		text,
		attachments: [],
		isBot: false,
	});

	let botMain = "";
	const botThread: string[] = [];

	const flushBotLog = () => {
		const textParts = [botMain, ...botThread].map((s) => s.trim()).filter(Boolean);
		if (textParts.length === 0) return;
		logToFile(workingDir, channelId, {
			date: new Date().toISOString(),
			ts: nowSlackTs(),
			threadTs,
			user: "bot",
			text: textParts.join("\n\n"),
			attachments: [],
			isBot: true,
		});
	};

	const ctx: SlackContext = {
		message: {
			text,
			rawText: text,
			user: userId,
			userName,
			channel: channelId,
			ts,
			attachments: [],
		},
		channelName: channelId,
		channels: [{ id: channelId, name: channelId }],
		users: [{ id: userId, userName, displayName: userName }],

		respond: async (msg: string) => {
			emit({ type: "event", id: requestId, event: "respond", text: msg });
			botMain = botMain ? `${botMain}\n${msg}` : msg;
		},

		replaceMessage: async (msg: string) => {
			emit({ type: "event", id: requestId, event: "replace", text: msg });
			botMain = msg;
		},

		respondInThread: async (msg: string) => {
			emit({ type: "event", id: requestId, event: "thread", text: msg });
			botThread.push(msg);
		},

		setTyping: async (_isTyping: boolean) => {},
		uploadFile: async (filePath: string, title?: string) => {
			emit({
				type: "event",
				id: requestId,
				event: "system",
				text: title ? `upload requested: ${title}: ${filePath}` : `upload requested: ${filePath}`,
			});
		},
		setWorking: async (working: boolean) => {
			emit({ type: "event", id: requestId, event: "system", text: working ? "working" : "idle" });
		},
		deleteMessage: async () => {
			emit({ type: "event", id: requestId, event: "system", text: "(deleted message)" });
		},
	};

	return { ctx, flushBotLog };
}

function sendJson(socket: Socket, obj: RpcResponse | RpcEvent): void {
	socket.write(`${JSON.stringify(obj)}\n`);
}

export async function startRpcServer(options: RpcServerOptions): Promise<RpcServerHandle> {
	const { workingDir, sandbox, socketPath, botToken, onShutdown, onRestartSandbox } = options;

	await mkdir(workingDir, { recursive: true });

	// Remove stale socket
	if (existsSync(socketPath)) {
		try {
			unlinkSync(socketPath);
		} catch {
			// ignore
		}
	}

	const store = new ChannelStore({ workingDir, botToken });
	const running = new Set<string>();

	const server: Server = createServer((socket) => {
		socket.setEncoding("utf8");
		let buffer = "";
		let handled = false;

		const handle = async (req: RpcRequest) => {
			if (handled) {
				sendJson(socket, {
					type: "response",
					id: (req as any).id,
					success: false,
					error: "only one request per connection",
				});
				socket.end();
				return;
			}
			handled = true;

			if (req.type === "new_session") {
				const session = generateSessionId();
				sendJson(socket, { type: "response", id: req.id, success: true, data: { session } });
				socket.end();
				return;
			}

			if (req.type === "shutdown") {
				sendJson(socket, { type: "response", id: req.id, success: true });
				socket.end();
				await onShutdown("rpc");
				return;
			}

			if (req.type === "abort") {
				const channelId = req.channelId ?? "CLOCAL";
				const runner: AgentRunner = getOrCreateRunner(
					sandbox,
					channelId,
					`${workingDir}/${channelId}`,
					req.session,
				);
				runner.abort();
				sendJson(socket, { type: "response", id: req.id, success: true });
				socket.end();
				return;
			}

			if (req.type === "status") {
				const settings = new MomSettingsManager(workingDir);
				const vibesilo = settings.getVibesiloSettings();
				const allowNet = vibesilo.allowNet ?? [];
				sendJson(socket, {
					type: "response",
					id: req.id,
					success: true,
					data: {
						sandbox: sandbox.type,
						vibesilo:
							sandbox.type === "vibesilo"
								? { image: vibesilo.image, allowNetCount: allowNet.length }
								: undefined,
					},
				});
				socket.end();
				return;
			}

			if (req.type === "restart_sandbox") {
				if (sandbox.type !== "vibesilo") {
					sendJson(socket, {
						type: "response",
						id: req.id,
						success: false,
						error: "sandbox restart is only supported for --sandbox=vibesilo",
					});
					socket.end();
					return;
				}
				if (running.size > 0) {
					sendJson(socket, {
						type: "response",
						id: req.id,
						success: false,
						error: "cannot restart sandbox while sessions are running",
					});
					socket.end();
					return;
				}
				if (!onRestartSandbox) {
					sendJson(socket, {
						type: "response",
						id: req.id,
						success: false,
						error: "restart callback not configured",
					});
					socket.end();
					return;
				}
				await onRestartSandbox();
				sendJson(socket, { type: "response", id: req.id, success: true });
				socket.end();
				return;
			}

			if (req.type === "allow_net") {
				if (sandbox.type !== "vibesilo") {
					sendJson(socket, {
						type: "response",
						id: req.id,
						success: false,
						error: "allowNet is only applicable for --sandbox=vibesilo",
					});
					socket.end();
					return;
				}
				const settings = new MomSettingsManager(workingDir);
				settings.reloadIfChanged();
				const vibesilo = settings.getVibesiloSettings();
				const current = [...(vibesilo.allowNet ?? [])];

				const normalizeHost = (input: string): string => {
					let s = input.trim();
					s = s.replace(/^[a-zA-Z]+:\/\//, "");
					s = s.split("/")[0] || s;
					s = s.split("?")[0] || s;
					s = s.split("#")[0] || s;
					return s;
				};

				if (req.action === "list") {
					sendJson(socket, {
						type: "response",
						id: req.id,
						success: true,
						data: { allowNet: current },
					});
					socket.end();
					return;
				}

				const host = req.host ? normalizeHost(req.host) : "";
				if (!host) {
					sendJson(socket, { type: "response", id: req.id, success: false, error: "missing host" });
					socket.end();
					return;
				}

				let next = current;
				if (req.action === "add") {
					if (!next.includes(host)) {
						next = [...next, host].sort();
					}
					settings.setVibesiloAllowNet(next);
				} else if (req.action === "remove") {
					next = next.filter((h) => h !== host);
					if (next.length === 0) {
						sendJson(socket, {
							type: "response",
							id: req.id,
							success: false,
							error: "refusing to make vibesilo.allowNet empty (empty means allow-all in vibesilo)",
						});
						socket.end();
						return;
					}
					settings.setVibesiloAllowNet(next);
				}

				if (req.restart) {
					if (running.size > 0) {
						sendJson(socket, {
							type: "response",
							id: req.id,
							success: false,
							error: "cannot restart sandbox while sessions are running",
						});
						socket.end();
						return;
					}
					if (!onRestartSandbox) {
						sendJson(socket, {
							type: "response",
							id: req.id,
							success: false,
							error: "restart callback not configured",
						});
						socket.end();
						return;
					}
					await onRestartSandbox();
				}

				sendJson(socket, {
					type: "response",
					id: req.id,
					success: true,
					data: { allowNet: next },
				});
				socket.end();
				return;
			}

			if (req.type === "prompt") {
				const channelId = req.channelId ?? "CLOCAL";
				const userId = req.userId ?? "local";
				const userName = req.userName ?? "local";
				const threadTs = req.session;
				const key = `${channelId}:${threadTs}`;

				if (running.has(key)) {
					sendJson(socket, {
						type: "response",
						id: req.id,
						success: false,
						error: "session is busy",
					});
					socket.end();
					return;
				}
				running.add(key);

				const emit = (evt: RpcEvent) => sendJson(socket, evt);
				const { ctx, flushBotLog } = createRpcContext({
					workingDir,
					channelId,
					threadTs,
					userId,
					userName,
					text: req.text,
					emit,
					requestId: req.id,
				});

				sendJson(socket, { type: "response", id: req.id, success: true });

				try {
					await mkdir(`${workingDir}/${channelId}`, { recursive: true });
					const runner = getOrCreateRunner(sandbox, channelId, `${workingDir}/${channelId}`, threadTs);
					await ctx.setTyping(true);
					await ctx.setWorking(true);
					const result = await runner.run(ctx, store);
					await ctx.setWorking(false);
					flushBotLog();
					emit({ type: "done", id: req.id, stopReason: result.stopReason, errorMessage: result.errorMessage });
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					sendJson(socket, { type: "done", id: req.id, stopReason: "error", errorMessage: msg });
				} finally {
					running.delete(key);
					socket.end();
				}
				return;
			}

			sendJson(socket, { type: "response", id: (req as any).id, success: false, error: "unknown request type" });
			socket.end();
		};

		socket.on("data", (chunk) => {
			buffer += chunk;
			while (true) {
				const idx = buffer.indexOf("\n");
				if (idx === -1) break;
				const line = buffer.slice(0, idx).trim();
				buffer = buffer.slice(idx + 1);
				if (!line) continue;

				let req: RpcRequest;
				try {
					req = JSON.parse(line) as RpcRequest;
				} catch (err) {
					sendJson(socket, {
						type: "response",
						success: false,
						error: `invalid json: ${err instanceof Error ? err.message : String(err)}`,
					});
					socket.end();
					return;
				}

				void handle(req);
			}
		});

		socket.on("error", () => {});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => resolve());
	});

	return {
		socketPath,
		async close(): Promise<void> {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			try {
				if (existsSync(socketPath)) unlinkSync(socketPath);
			} catch {
				// ignore
			}
		},
	};
}
