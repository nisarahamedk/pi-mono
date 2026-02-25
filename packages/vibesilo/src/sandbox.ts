import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { docker, dockerQuiet, dockerSpawn } from "./docker.js";
import type { ExecResult, MountConfig, SandboxOptions } from "./types.js";

const MITM_IMAGE = "mitmproxy/mitmproxy:10.2.4";

function placeholderFor(name: string, salt: string) {
	const hash = createHash("sha256").update(`${name}:${salt}`).digest("hex");
	return `AGENT_SECRET_PLACEHOLDER_${hash}`;
}

async function waitForFile(path: string, timeoutMs = 10_000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		try {
			await access(path);
			return;
		} catch {
			await delay(200);
		}
	}
	throw new Error(`Timed out waiting for ${path}`);
}

function buildAddonScript() {
	return `import json
import os
from mitmproxy import http, ctx

class SecretInjector:
    def __init__(self):
        with open("/config/secrets.json", "r") as f:
            cfg = json.load(f)
        self.allow_hosts = cfg.get("allowNet", [])
        self.secrets = cfg.get("secrets", {})
        self.debug_inject = os.getenv("AGENT_SANDBOX_DEBUG_INJECT") == "1"

    def _matches(self, host, allowed):
        if allowed.startswith("*.") and host.endswith(allowed[1:]):
            return True
        return host == allowed

    def _host_allowed(self, host, allow_list):
        if not allow_list:
            return True
        for allowed in allow_list:
            if self._matches(host, allowed):
                return True
        return False

    def request(self, flow: http.HTTPFlow):
        host = flow.request.host
        if not self._host_allowed(host, self.allow_hosts):
            flow.response = http.Response.make(
                403,
                b"blocked by agent-sandbox allowNet",
                {"content-type": "text/plain"},
            )
            return

        injected = set()
        for name, meta in self.secrets.items():
            placeholder = meta.get("placeholder")
            value = meta.get("value")
            secret_hosts = meta.get("hosts", [])
            if not placeholder or not value:
                continue
            if not self._host_allowed(host, secret_hosts):
                continue

            for header, hvalue in list(flow.request.headers.items()):
                if placeholder in hvalue:
                    flow.request.headers[header] = hvalue.replace(placeholder, value)
                    injected.add(name)

            if flow.request.content:
                try:
                    content = flow.request.content.decode("utf-8")
                    if placeholder in content:
                        flow.request.content = content.replace(placeholder, value).encode("utf-8")
                        injected.add(name)
                except Exception:
                    pass

        if injected:
            flow.metadata["agent_sandbox_injected"] = ",".join(sorted(injected))
            ctx.log.info(f"agent-sandbox injected: {flow.metadata['agent_sandbox_injected']} -> {host}")

    def response(self, flow: http.HTTPFlow):
        if not self.debug_inject:
            return
        injected = flow.metadata.get("agent_sandbox_injected")
        if injected and flow.response:
            flow.response.headers["x-agent-sandbox-injected"] = injected

addons = [SecretInjector()]
`;
}

export class Sandbox {
	private name: string;
	private options: SandboxOptions;
	private workdir: string;
	private networkInternal: string;
	private proxyContainer: string;
	private sandboxContainer: string;
	private relayContainers: string[] = [];
	private placeholderEnv: Record<string, string> = {};

	private constructor(id: string, options: SandboxOptions) {
		this.name = options.name ?? id;
		this.options = options;
		this.workdir = join(tmpdir(), `agent-sandbox-${id}`);
		this.networkInternal = `agent-sandbox-net-${id}`;
		this.proxyContainer = `agent-sandbox-proxy-${id}`;
		this.sandboxContainer = `agent-sandbox-${id}`;
	}

	static async create(options: SandboxOptions) {
		const id = randomUUID();
		const sandbox = new Sandbox(id, options);
		await sandbox.start();
		return sandbox;
	}

	get containerId() {
		return this.sandboxContainer;
	}

	get placeholders() {
		return { ...this.placeholderEnv };
	}

	get proxyContainerId() {
		return this.proxyContainer;
	}

	async proxyLogs(lines = 50) {
		const result = await docker(["logs", "--tail", String(lines), this.proxyContainer]);
		return result.stdout;
	}

	async exec(command: string): Promise<ExecResult> {
		const result = await dockerSpawn(["exec", this.sandboxContainer, "/bin/sh", "-lc", command]);

		return {
			stdout: result.stdout,
			stderr: result.stderr,
			exitCode: result.exitCode,
		};
	}

	async close() {
		for (const relay of this.relayContainers) {
			await dockerQuiet(["rm", "-f", relay]);
		}
		await dockerQuiet(["rm", "-f", this.sandboxContainer]);
		await dockerQuiet(["rm", "-f", this.proxyContainer]);
		await dockerQuiet(["network", "rm", this.networkInternal]);
		await rm(this.workdir, { recursive: true, force: true });
	}

	private resolveHostPath(path: string) {
		if (path.startsWith("~/")) {
			return join(homedir(), path.slice(2));
		}
		if (path === "~") {
			return homedir();
		}
		return resolve(process.cwd(), path);
	}

	private mountArgs(mounts: MountConfig[] | undefined) {
		if (!mounts || mounts.length === 0) return [];
		const args: string[] = [];
		for (const mount of mounts) {
			const hostPath = this.resolveHostPath(mount.host);
			const suffix = mount.readOnly === false ? "rw" : "ro";
			args.push("-v", `${hostPath}:${mount.guest}:${suffix}`);
		}
		return args;
	}

	private async startPortRelays(): Promise<void> {
		const mappings = this.options.portMappings;
		if (!mappings || mappings.length === 0) return;

		for (const mapping of mappings) {
			const bindAddress = mapping.bindAddress?.trim() || "127.0.0.1";
			const relayName = `${this.sandboxContainer}-relay-${mapping.hostPort}`;
			this.relayContainers.push(relayName);
			await docker([
				"run",
				"-d",
				"--name",
				relayName,
				"--network",
				"bridge",
				"-p",
				`${bindAddress}:${mapping.hostPort}:${mapping.hostPort}`,
				"alpine/socat",
				"-d",
				"-d",
				`TCP-LISTEN:${mapping.hostPort},fork,reuseaddr`,
				`TCP:${this.sandboxContainer}:${mapping.containerPort}`,
			]);
			await docker(["network", "connect", this.networkInternal, relayName]);
		}
	}

	private async start() {
		await mkdir(this.workdir, { recursive: true });
		const addonsDir = join(this.workdir, "addons");
		const configDir = join(this.workdir, "config");
		const mitmDir = join(this.workdir, "mitmproxy");
		const certsDir = join(this.workdir, "certs");

		await mkdir(addonsDir, { recursive: true });
		await mkdir(configDir, { recursive: true });
		await mkdir(mitmDir, { recursive: true });
		await mkdir(certsDir, { recursive: true });

		const salt = randomUUID();
		const secrets: Record<string, { hosts: string[]; value: string; placeholder: string }> = {};

		for (const [name, meta] of Object.entries(this.options.secrets ?? {})) {
			const placeholder = placeholderFor(name, salt);
			secrets[name] = {
				hosts: meta.hosts,
				value: meta.value,
				placeholder,
			};
			this.placeholderEnv[name] = placeholder;
		}

		await writeFile(join(addonsDir, "inject_secrets.py"), buildAddonScript());
		await writeFile(
			join(configDir, "secrets.json"),
			JSON.stringify(
				{
					allowNet: this.options.allowNet ?? [],
					secrets,
				},
				null,
				2,
			),
		);

		await docker(["network", "create", "--internal", this.networkInternal]);

		const proxyEnvArgs: string[] = [];
		if (this.options.debugInjectHeader) {
			proxyEnvArgs.push("-e", "AGENT_SANDBOX_DEBUG_INJECT=1");
		}

		await docker([
			"run",
			"-d",
			"--name",
			this.proxyContainer,
			"--network",
			this.networkInternal,
			...proxyEnvArgs,
			"-v",
			`${addonsDir}:/addons`,
			"-v",
			`${configDir}:/config`,
			"-v",
			`${mitmDir}:/home/mitmproxy/.mitmproxy`,
			MITM_IMAGE,
			"mitmdump",
			"--listen-host",
			"0.0.0.0",
			"--listen-port",
			"8080",
			"-s",
			"/addons/inject_secrets.py",
			"--set",
			"block_global=false",
		]);

		await docker(["network", "connect", "bridge", this.proxyContainer]);

		const caPath = join(mitmDir, "mitmproxy-ca-cert.pem");
		await waitForFile(caPath);
		await copyFile(caPath, join(certsDir, "mitmproxy-ca-cert.pem"));

		const envArgs: string[] = [
			"-e",
			`HTTPS_PROXY=http://${this.proxyContainer}:8080`,
			"-e",
			`HTTP_PROXY=http://${this.proxyContainer}:8080`,
			"-e",
			"NO_PROXY=localhost,127.0.0.1",
			"-e",
			`SSL_CERT_FILE=/certs/mitmproxy-ca-cert.pem`,
			"-e",
			`CURL_CA_BUNDLE=/certs/mitmproxy-ca-cert.pem`,
			"-e",
			`NODE_EXTRA_CA_CERTS=/certs/mitmproxy-ca-cert.pem`,
		];

		for (const [key, value] of Object.entries({
			...this.options.env,
			...this.placeholderEnv,
		})) {
			envArgs.push("-e", `${key}=${value}`);
		}

		const installCertScript = [
			"set -e",
			"if command -v update-ca-certificates >/dev/null 2>&1; then",
			"  cp /certs/mitmproxy-ca-cert.pem /usr/local/share/ca-certificates/mitmproxy.crt",
			"  update-ca-certificates",
			"elif command -v update-ca-trust >/dev/null 2>&1; then",
			"  cp /certs/mitmproxy-ca-cert.pem /etc/pki/ca-trust/source/anchors/mitmproxy.crt",
			"  update-ca-trust",
			"fi",
			"sleep infinity",
		].join("\n");

		const mountArgs = this.mountArgs(this.options.mounts);

		await docker([
			"run",
			"-d",
			"--name",
			this.sandboxContainer,
			"--network",
			this.networkInternal,
			"-v",
			`${certsDir}:/certs`,
			...mountArgs,
			...envArgs,
			this.options.image,
			"/bin/sh",
			"-lc",
			installCertScript,
		]);

		await this.startPortRelays();
	}
}
