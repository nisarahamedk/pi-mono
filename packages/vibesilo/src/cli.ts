#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import { Sandbox } from "./sandbox.js";
import type { MountConfig, SandboxProfile, SecretConfig } from "./types.js";

const program = new Command();

program.name("vibesilo").description("Run commands in a sandboxed container with secret injection").version("0.1.0");

program
	.command("run")
	.description("Run a command inside a new sandbox")
	.option("-c, --config <path>", "Path to sandbox profile JSON")
	.option("-i, --image <image>", "Docker image to use")
	.option("-a, --allow <host>", "Allow outbound host (repeatable)", collect, [])
	.option("-s, --secret <spec>", "Secret spec: NAME=VALUE@host1,host2 (repeatable)", collect, [])
	.option("-m, --mount <spec>", "Mount spec: host:guest[:ro|rw] (repeatable)", collect, [])
	.option("--mount-auth", "Mount ~/.pi/agent/auth.json to /root/.pi/agent/auth.json (ro)")
	.allowUnknownOption(true)
	.argument("<cmd...>", "Command to run")
	.action(async (cmd: string[], options) => {
		const profile = options.config ? loadProfile(options.config as string) : {};
		const allowNet = mergeList(profile.allowNet, options.allow as string[]);
		const secrets = mergeSecrets(profile.secrets, parseSecrets(options.secret as string[]));
		const mounts = mergeMounts(profile.mounts, parseMounts(options.mount as string[]));
		if (options.mountAuth) {
			mounts.push({
				host: "~/.pi/agent/auth.json",
				guest: "/root/.pi/agent/auth.json",
				readOnly: true,
			});
		}

		const image = options.image ?? profile.image;
		if (!image) {
			throw new Error("Missing image. Provide --image or set it in the config.");
		}

		const sandbox = await Sandbox.create({
			image,
			allowNet,
			secrets,
			env: profile.env,
			mounts,
			name: profile.name,
			debugInjectHeader: profile.debugInjectHeader,
		});

		try {
			const result = await sandbox.exec(cmd.join(" "));
			if (result.stdout) process.stdout.write(`${result.stdout}\n`);
			if (result.stderr) process.stderr.write(`${result.stderr}\n`);
			process.exitCode = result.exitCode;
		} finally {
			await sandbox.close();
		}
	});

program
	.command("init")
	.description("Create a vibesilo.json profile")
	.option("-p, --path <path>", "Output path", "vibesilo.json")
	.option("-i, --image <image>", "Docker image to use", "node:20-bookworm")
	.option("--no-auth-mount", "Do not mount ~/.pi/agent/auth.json")
	.option("-f, --force", "Overwrite if the file exists")
	.action((options) => {
		const path = options.path as string;
		if (existsSync(path) && !options.force) {
			throw new Error(`File already exists: ${path}`);
		}

		const profile: SandboxProfile = {
			image: options.image as string,
			allowNet: ["api.github.com", "auth.openai.com", "api.openai.com"],
			mounts: [{ host: ".", guest: "/workspace", readOnly: false }],
		};

		if (options.authMount) {
			profile.mounts!.push({
				host: "~/.pi/agent/auth.json",
				guest: "/root/.pi/agent/auth.json",
				readOnly: true,
			});
		}

		writeFileSync(path, JSON.stringify(profile, null, 2));
		process.stdout.write(`Wrote ${path}\n`);
	});

program.parse(process.argv);

function collect(value: string, previous: string[]) {
	return previous.concat([value]);
}

function loadProfile(path: string): SandboxProfile {
	const raw = readFileSync(path, "utf-8");
	return JSON.parse(raw) as SandboxProfile;
}

function mergeList(base: string[] | undefined, extra: string[]) {
	return [...(base ?? []), ...extra];
}

function mergeSecrets(base: Record<string, SecretConfig> | undefined, extra: Record<string, SecretConfig>) {
	return { ...(base ?? {}), ...extra };
}

function mergeMounts(base: MountConfig[] | undefined, extra: MountConfig[]) {
	return [...(base ?? []), ...extra];
}

function parseSecrets(items: string[]) {
	const secrets: Record<string, SecretConfig> = {};
	for (const item of items) {
		const [left, hostsPart] = item.split("@");
		if (!left || !hostsPart) {
			throw new Error(`Invalid secret spec: ${item}`);
		}
		const [name, ...valueParts] = left.split("=");
		const value = valueParts.join("=");
		if (!name || !value) {
			throw new Error(`Invalid secret spec: ${item}`);
		}
		secrets[name] = {
			value,
			hosts: hostsPart
				.split(",")
				.map((h) => h.trim())
				.filter(Boolean),
		};
	}
	return secrets;
}

function parseMounts(items: string[]) {
	const mounts: MountConfig[] = [];
	for (const item of items) {
		const parts = item.split(":");
		if (parts.length < 2 || parts.length > 3) {
			throw new Error(`Invalid mount spec: ${item}`);
		}
		const [host, guest, mode] = parts;
		const readOnly = mode ? mode !== "rw" : true;
		mounts.push({ host, guest, readOnly });
	}
	return mounts;
}
