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
	| { id?: string; type: "shutdown" };

type RpcResponse =
	| { type: "response"; id?: string; success: true; data?: any }
	| { type: "response"; id?: string; success: false; error: string };

type RpcEvent =
	| { type: "event"; id?: string; event: "respond" | "replace" | "thread" | "system"; text: string }
	| { type: "done"; id?: string; stopReason: string; errorMessage?: string };

interface Args {
	workspace?: string;
	socket?: string;
	cmd: "send" | "new-session" | "abort" | "shutdown";
	session?: string;
	channelId?: string;
	userName?: string;
	userId?: string;
	text?: string;
}

function usage(): never {
	console.error(
		[
			"Usage:",
			"  mom-cli --workspace <dir> new-session",
			"  mom-cli --workspace <dir> send --session <id> --text <msg> [--channel <id>]",
			"  mom-cli --workspace <dir> abort --session <id> [--channel <id>]",
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
		} else if (a === "send" || a === "new-session" || a === "abort" || a === "shutdown") {
			cmd = a;
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
		} else if (!a.startsWith("-")) {
			// Convenience: allow positional text for send
			if (!cmd) {
				// no-op
			} else if (cmd === "send" && !text) {
				text = a;
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
