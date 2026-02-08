#!/usr/bin/env node

import { connect } from "node:net";
import { resolve } from "node:path";

type RpcRequest =
	| {
			id?: string;
			type: "prompt";
			channelId?: string;
			session: string;
			userId?: string;
			userName?: string;
			text: string;
	  }
	| { id?: string; type: "new_session" }
	| { id?: string; type: "abort"; channelId?: string; session: string }
	| { id?: string; type: "shutdown" }
	| { id?: string; type: "status" }
	| { id?: string; type: "restart_sandbox" }
	| {
			id?: string;
			type: "allow_net";
			action: "list" | "add" | "remove";
			host?: string;
			restart?: boolean;
	  }
	| { id?: string; type: "host_browser_status" };

type RpcResponse =
	| { type: "response"; id?: string; success: true; data?: any }
	| { type: "response"; id?: string; success: false; error: string };

type RpcEvent =
	| { type: "event"; id?: string; event: "respond" | "replace" | "thread" | "system"; text: string }
	| { type: "done"; id?: string; stopReason: string; errorMessage?: string };

interface Args {
	workspace?: string;
	socket?: string;
	cmd: "send" | "new-session" | "abort" | "shutdown" | "status" | "restart-sandbox" | "allow-net" | "host-browser";
	session?: string;
	channelId?: string;
	userName?: string;
	userId?: string;
	text?: string;
	allowNetAction?: "list" | "add" | "remove";
	hostBrowserAction?: "status";
	host?: string;
	restart?: boolean;
}

function usage(): never {
	console.error(
		[
			"Usage:",
			"  mom-cli --workspace <dir> new-session",
			"  mom-cli --workspace <dir> send --session <id> --text <msg> [--channel <id>]",
			"  mom-cli --workspace <dir> abort --session <id> [--channel <id>]",
			"  mom-cli --workspace <dir> status",
			"  mom-cli --workspace <dir> allow-net list",
			"  mom-cli --workspace <dir> allow-net add <host> [--restart]",
			"  mom-cli --workspace <dir> allow-net remove <host> [--restart]",
			"  mom-cli --workspace <dir> host-browser status",
			"  mom-cli --workspace <dir> restart-sandbox",
			"  mom-cli --workspace <dir> shutdown",
			"",
			"Notes:",
			"  - Connects to a running mom process started with --rpc-socket.",
			"  - Default socket path is <workspace>/.mom.sock.",
			"  - Example: mom --sandbox=vibesilo --rpc-socket <workspace>/.mom.sock <workspace>",
		].join("\n"),
	);
	process.exit(1);
}

function parseArgs(): Args {
	const argv = process.argv.slice(2);
	let workspace: string | undefined;
	let socket: string | undefined;
	let cmd: Args["cmd"] | undefined;
	let session: string | undefined;
	let channelId: string | undefined;
	let text: string | undefined;
	let userName: string | undefined;
	let userId: string | undefined;
	let allowNetAction: Args["allowNetAction"] | undefined;
	let hostBrowserAction: Args["hostBrowserAction"] | undefined;
	let host: string | undefined;
	let restart: boolean | undefined;

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--workspace") {
			workspace = argv[++i];
		} else if (a.startsWith("--workspace=")) {
			workspace = a.slice("--workspace=".length);
		} else if (a === "--socket") {
			socket = argv[++i];
		} else if (a.startsWith("--socket=")) {
			socket = a.slice("--socket=".length);
		} else if (
			a === "send" ||
			a === "new-session" ||
			a === "abort" ||
			a === "shutdown" ||
			a === "status" ||
			a === "restart-sandbox" ||
			a === "allow-net" ||
			a === "host-browser"
		) {
			cmd = a;
			if (cmd === "allow-net") {
				const maybeAction = argv[i + 1];
				if (maybeAction && !maybeAction.startsWith("-")) {
					if (
						maybeAction === "list" ||
						maybeAction === "add" ||
						maybeAction === "remove" ||
						maybeAction === "rm"
					) {
						allowNetAction = maybeAction === "rm" ? "remove" : maybeAction;
						i++;
						const maybeHost = argv[i + 1];
						if (allowNetAction !== "list" && maybeHost && !maybeHost.startsWith("-")) {
							host = maybeHost;
							i++;
						}
					}
				}
			}
			if (cmd === "host-browser") {
				const maybeAction = argv[i + 1];
				if (maybeAction === "status") {
					hostBrowserAction = "status";
					i++;
				}
			}
		} else if (a === "--session") {
			session = argv[++i];
		} else if (a.startsWith("--session=")) {
			session = a.slice("--session=".length);
		} else if (a === "--channel") {
			channelId = argv[++i];
		} else if (a.startsWith("--channel=")) {
			channelId = a.slice("--channel=".length);
		} else if (a === "--text") {
			text = argv[++i];
		} else if (a.startsWith("--text=")) {
			text = a.slice("--text=".length);
		} else if (a === "--user") {
			userName = argv[++i];
		} else if (a.startsWith("--user=")) {
			userName = a.slice("--user=".length);
		} else if (a === "--user-id") {
			userId = argv[++i];
		} else if (a.startsWith("--user-id=")) {
			userId = a.slice("--user-id=".length);
		} else if (a === "--host") {
			host = argv[++i];
		} else if (a.startsWith("--host=")) {
			host = a.slice("--host=".length);
		} else if (a === "--restart") {
			restart = true;
		} else if (!a.startsWith("-")) {
			// Convenience: allow positional text for send
			if (!cmd) {
				// no-op
			} else if (cmd === "send" && !text) {
				text = a;
			} else if (cmd === "allow-net" && !allowNetAction) {
				// allow-net <action> [host]
				if (a === "list" || a === "add" || a === "remove" || a === "rm") {
					allowNetAction = a === "rm" ? "remove" : a;
				} else {
					host = host ?? a;
				}
			} else if (cmd === "host-browser" && !hostBrowserAction) {
				if (a === "status") hostBrowserAction = "status";
			}
		}
	}

	return {
		workspace: workspace ? resolve(workspace) : undefined,
		socket,
		cmd: cmd ?? ("send" as const),
		session,
		channelId,
		userName,
		userId,
		text,
		allowNetAction,
		hostBrowserAction,
		host,
		restart,
	};
}

function connectAndRun(socketPath: string, req: RpcRequest): Promise<void> {
	return new Promise((resolvePromise, rejectPromise) => {
		const socket = connect({ path: socketPath });
		socket.setEncoding("utf8");

		let buffer = "";
		let done = false;

		const finish = (err?: Error) => {
			if (done) return;
			done = true;
			socket.end();
			if (err) rejectPromise(err);
			else resolvePromise();
		};

		socket.on("connect", () => {
			socket.write(`${JSON.stringify(req)}\n`);
		});

		socket.on("data", (chunk) => {
			buffer += chunk;
			while (true) {
				const idx = buffer.indexOf("\n");
				if (idx === -1) break;
				const line = buffer.slice(0, idx).trim();
				buffer = buffer.slice(idx + 1);
				if (!line) continue;
				let msg: RpcResponse | RpcEvent;
				try {
					msg = JSON.parse(line);
				} catch {
					continue;
				}

				if (msg.type === "response") {
					if (!msg.success) {
						finish(new Error(msg.error));
						return;
					}
					if (req.type === "new_session" && msg.data?.session) {
						process.stdout.write(`${msg.data.session}\n`);
					}
					if (req.type === "status" && msg.data) {
						process.stdout.write(`${JSON.stringify(msg.data, null, 2)}\n`);
					}
					if (req.type === "host_browser_status" && msg.data) {
						process.stdout.write(`${JSON.stringify(msg.data, null, 2)}\n`);
					}
					if (req.type === "allow_net" && msg.data?.allowNet) {
						process.stdout.write(`${msg.data.allowNet.join("\n")}\n`);
					}
					continue;
				}

				if (msg.type === "event") {
					const prefix = msg.event === "thread" ? "[thread] " : msg.event === "system" ? "[system] " : "";
					process.stdout.write(`${prefix}${msg.text}\n`);
					continue;
				}

				if (msg.type === "done") {
					if (msg.stopReason === "error") {
						finish(new Error(msg.errorMessage ?? "unknown error"));
						return;
					}
					finish();
					return;
				}
			}
		});

		socket.on("error", (err) => finish(err));
		socket.on("end", () => finish());
	});
}

const args = parseArgs();
if (!args.workspace) usage();

const socketPath = args.socket ?? `${args.workspace}/.mom.sock`;
const id = `cli-${Date.now()}`;

if (args.cmd === "new-session") {
	await connectAndRun(socketPath, { id, type: "new_session" });
	process.exit(0);
}

if (args.cmd === "shutdown") {
	await connectAndRun(socketPath, { id, type: "shutdown" });
	process.exit(0);
}

if (args.cmd === "abort") {
	if (!args.session) usage();
	await connectAndRun(socketPath, { id, type: "abort", session: args.session, channelId: args.channelId });
	process.exit(0);
}

if (args.cmd === "status") {
	await connectAndRun(socketPath, { id, type: "status" });
	process.exit(0);
}

if (args.cmd === "restart-sandbox") {
	await connectAndRun(socketPath, { id, type: "restart_sandbox" });
	process.exit(0);
}

if (args.cmd === "allow-net") {
	if (!args.allowNetAction) usage();
	if (args.allowNetAction === "list") {
		await connectAndRun(socketPath, { id, type: "allow_net", action: "list" });
		process.exit(0);
	}
	if (!args.host) usage();
	await connectAndRun(socketPath, {
		id,
		type: "allow_net",
		action: args.allowNetAction,
		host: args.host,
		restart: !!args.restart,
	});
	process.exit(0);
}

if (args.cmd === "host-browser") {
	if (args.hostBrowserAction !== "status") usage();
	await connectAndRun(socketPath, { id, type: "host_browser_status" });
	process.exit(0);
}

// send
if (!args.session || !args.text) usage();
await connectAndRun(socketPath, {
	id,
	type: "prompt",
	session: args.session,
	channelId: args.channelId,
	userName: args.userName,
	userId: args.userId,
	text: args.text,
});
