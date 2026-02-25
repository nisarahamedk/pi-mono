import { spawn } from "child_process";
import { Sandbox as VibesiloSandbox } from "vibesilo";
import { MomSettingsManager } from "./context.js";

export type SandboxConfig = { type: "host" } | { type: "docker"; container: string } | { type: "vibesilo" };

export function parseSandboxArg(value: string): SandboxConfig {
	if (value === "host") {
		return { type: "host" };
	}
	if (value === "vibesilo") {
		return { type: "vibesilo" };
	}
	if (value.startsWith("docker:")) {
		const container = value.slice("docker:".length);
		if (!container) {
			console.error("Error: docker sandbox requires container name (e.g., docker:mom-sandbox)");
			process.exit(1);
		}
		return { type: "docker", container };
	}
	console.error(`Error: Invalid sandbox type '${value}'. Use 'host', 'vibesilo', or 'docker:<container-name>'`);
	process.exit(1);
}

export async function validateSandbox(config: SandboxConfig, hostWorkspaceDir: string): Promise<void> {
	if (config.type === "host") {
		return;
	}

	// All non-host sandboxes require Docker
	await validateDockerAvailable();

	if (config.type === "docker") {
		// Check if container exists and is running
		try {
			const result = await execSimple("docker", ["inspect", "-f", "{{.State.Running}}", config.container]);
			if (result.trim() !== "true") {
				console.error(`Error: Container '${config.container}' is not running.`);
				console.error(`Start it with: docker start ${config.container}`);
				process.exit(1);
			}
		} catch {
			console.error(`Error: Container '${config.container}' does not exist.`);
			console.error("Create it with: ./docker.sh create <data-dir>");
			process.exit(1);
		}

		console.log(`  Docker container '${config.container}' is running.`);
		return;
	}

	if (config.type === "vibesilo") {
		const settings = new MomSettingsManager(hostWorkspaceDir);
		const vibesilo = settings.getVibesiloSettings();
		const allowNet = vibesilo.allowNet ?? [];
		if (allowNet.length === 0) {
			console.error(
				"Error: vibesilo sandbox requires settings.json to define non-empty vibesilo.allowNet. " +
					"(vibesilo treats an empty allowNet list as allow-all)\n\n" +
					`Workspace: ${hostWorkspaceDir}`,
			);
			process.exit(1);
		}
		try {
			validateVibesiloPortMappings(vibesilo.portMappings);
		} catch (err) {
			console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
			process.exit(1);
		}
		console.log(`  Vibesilo sandbox enabled (image: ${vibesilo.image ?? "node:20-bookworm"})`);
		return;
	}
}

async function validateDockerAvailable(): Promise<void> {
	try {
		await execSimple("docker", ["--version"]);
	} catch {
		console.error("Error: Docker is not installed or not in PATH");
		process.exit(1);
	}
}

function execSimple(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d) => {
			stdout += d;
		});
		child.stderr?.on("data", (d) => {
			stderr += d;
		});
		child.on("close", (code) => {
			if (code === 0) resolve(stdout);
			else reject(new Error(stderr || `Exit code ${code}`));
		});
	});
}

/**
 * Create an executor that runs commands either on host or in a sandbox.
 *
 * @param hostWorkspaceDir - Absolute path to the mom workspace root on the host.
 */
export function createExecutor(config: SandboxConfig, hostWorkspaceDir: string): Executor {
	if (config.type === "host") {
		return new HostExecutor();
	}
	if (config.type === "docker") {
		return new DockerExecutor(config.container);
	}
	return new VibesiloExecutor(hostWorkspaceDir);
}

export async function shutdownSandbox(config: SandboxConfig): Promise<void> {
	if (config.type !== "vibesilo") return;
	if (!vibesiloSandbox) return;
	try {
		await vibesiloSandbox.close();
	} catch {
		// ignore
	} finally {
		vibesiloSandbox = null;
		vibesiloSandboxCreating = null;
		vibesiloHostWorkspaceDir = null;
		vibesiloPlaceholders = null;
		vibesiloBridgeKey = null;
		vibesiloUpworkInitKey = null;
	}
}

export interface Executor {
	/**
	 * Execute a bash command
	 */
	exec(command: string, options?: ExecOptions): Promise<ExecResult>;

	/**
	 * Get the workspace path prefix for this executor
	 * Host: returns the actual path
	 * Docker/vibesilo: returns /workspace
	 */
	getWorkspacePath(hostPath: string): string;
}

export interface ExecOptions {
	timeout?: number;
	signal?: AbortSignal;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

let vibesiloSandbox: VibesiloSandbox | null = null;
let vibesiloSandboxCreating: Promise<VibesiloSandbox> | null = null;
let vibesiloHostWorkspaceDir: string | null = null;
let vibesiloPlaceholders: Record<string, string> | null = null;
let vibesiloBridgeKey: string | null = null;
let vibesiloUpworkInitKey: string | null = null;

export interface HostBrowserStatus {
	configured: boolean;
	enabled: boolean;
	cdpPort: number;
	cdpTarget: string;
	bridgeRunning: boolean;
	healthy: boolean;
	reason?: string;
}

function getHostBrowserStatusDefault(reason?: string): HostBrowserStatus {
	return {
		configured: false,
		enabled: false,
		cdpPort: 9223,
		cdpTarget: "host.docker.internal:9223",
		bridgeRunning: false,
		healthy: false,
		reason,
	};
}

async function probeHostBrowserBridge(
	containerId: string,
	cdpPort: number,
): Promise<{ running: boolean; healthy: boolean }> {
	const hostExecutor = new HostExecutor();
	const pidFile = `/tmp/mom-cdp-bridge-${cdpPort}.pid`;
	const runningCmd = `if [ -f ${pidFile} ] && kill -0 "$(cat ${pidFile})" 2>/dev/null; then echo running; else echo stopped; fi`;
	const runningResult = await hostExecutor.exec(`docker exec ${containerId} sh -lc ${shellEscape(runningCmd)}`, {
		timeout: 5,
	});
	const running = runningResult.code === 0 && runningResult.stdout.trim() === "running";

	const healthCmd = `curl -fsS --max-time 3 http://127.0.0.1:${cdpPort}/json/version >/dev/null`;
	const healthResult = await hostExecutor.exec(`docker exec ${containerId} sh -lc ${shellEscape(healthCmd)}`, {
		timeout: 6,
	});
	const healthy = healthResult.code === 0;
	return { running, healthy };
}

async function checkHostCdpReachable(host: string, port: number): Promise<boolean> {
	const probeHost = host === "host.docker.internal" ? "127.0.0.1" : host;
	const hostExecutor = new HostExecutor();
	const cmd = `curl -fsS --max-time 2 http://${probeHost}:${port}/json/version >/dev/null`;
	const result = await hostExecutor.exec(cmd, { timeout: 4 });
	return result.code === 0;
}

async function ensureHostBrowserRunning(
	host: string,
	port: number,
	hostBrowser: ReturnType<MomSettingsManager["getHostBrowserSettings"]>,
): Promise<void> {
	if (!hostBrowser.enabled || !hostBrowser.ensureRunning) return;
	if (!hostBrowser.launchCommand || hostBrowser.launchCommand.trim().length === 0) return;

	if (await checkHostCdpReachable(host, port)) return;

	const hostExecutor = new HostExecutor();
	const launchResult = await hostExecutor.exec(hostBrowser.launchCommand, { timeout: 20 });
	if (launchResult.code !== 0) {
		const msg = `Failed to launch host browser via hostBrowser.launchCommand`;
		if (hostBrowser.required) throw new Error(`${msg}. ${launchResult.stderr || launchResult.stdout}`.trim());
		sandboxLog(`${msg}. Continuing without host browser.`);
		return;
	}
	for (let i = 0; i < 12; i++) {
		if (await checkHostCdpReachable(host, port)) return;
		await new Promise((r) => setTimeout(r, 500));
	}

	const msg = `Host browser launch command ran but CDP is still unavailable at ${host}:${port}`;
	if (hostBrowser.required) throw new Error(msg);
	sandboxLog(`${msg}. Continuing without host browser.`);
}

export async function ensureHostBrowserAtGatewayStart(config: SandboxConfig, hostWorkspaceDir: string): Promise<void> {
	if (config.type !== "vibesilo") return;
	const settings = new MomSettingsManager(hostWorkspaceDir);
	const hostBrowser = settings.getHostBrowserSettings();
	if (!hostBrowser.enabled || !hostBrowser.ensureRunning) return;
	const cdpTarget = hostBrowser.cdpTarget ?? "host.docker.internal:9223";
	const parsedTarget = parseHostPort(cdpTarget);
	await ensureHostBrowserRunning(parsedTarget.host, parsedTarget.port, hostBrowser);
}

function parseHostPort(target: string): { host: string; port: number } {
	const idx = target.lastIndexOf(":");
	if (idx === -1) return { host: target, port: 9223 };
	const host = target.slice(0, idx);
	const port = Number(target.slice(idx + 1));
	return { host: host || "host.docker.internal", port: Number.isFinite(port) && port > 0 ? port : 9223 };
}

async function deriveProxyContainerName(sandboxContainerId: string): Promise<string | null> {
	const hostExecutor = new HostExecutor();
	const inspect = await hostExecutor.exec(`docker inspect -f '{{.Name}}' ${sandboxContainerId}`, { timeout: 5 });
	if (inspect.code !== 0) return null;
	const sandboxName = inspect.stdout.trim().replace(/^\//, "");
	const prefix = "agent-sandbox-";
	if (!sandboxName.startsWith(prefix)) return null;
	return `agent-sandbox-proxy-${sandboxName.slice(prefix.length)}`;
}

async function ensureProxyCdpRelay(
	proxyName: string,
	targetHost: string,
	targetPort: number,
	relayPort: number,
): Promise<void> {
	const hostExecutor = new HostExecutor();
	const scriptPath = `/tmp/mom-proxy-cdp-relay-${relayPort}.py`;
	const pidPath = `/tmp/mom-proxy-cdp-relay-${relayPort}.pid`;
	const logPath = `/tmp/mom-proxy-cdp-relay-${relayPort}.log`;
	const py = [
		`import socket,threading,os`,
		`LISTEN=("0.0.0.0",${relayPort})`,
		`TARGET_HOST=${JSON.stringify(targetHost)}`,
		`TARGET_PORT=${targetPort}`,
		`ls=socket.socket(socket.AF_INET,socket.SOCK_STREAM)`,
		`ls.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)`,
		`ls.bind(LISTEN)`,
		`ls.listen(64)`,
		`open(${JSON.stringify(pidPath)},"w").write(str(os.getpid()))`,
		`def pipe(a,b):`,
		`  try:`,
		`    while True:`,
		`      d=a.recv(65536)`,
		`      if not d: break`,
		`      b.sendall(d)`,
		`  except Exception: pass`,
		`  finally:`,
		`    try: a.shutdown(socket.SHUT_RDWR)`,
		`    except Exception: pass`,
		`    try: b.shutdown(socket.SHUT_RDWR)`,
		`    except Exception: pass`,
		`    a.close(); b.close()`,
		`while True:`,
		`  c,_=ls.accept()`,
		`  t=socket.socket(socket.AF_INET,socket.SOCK_STREAM)`,
		`  try:`,
		`    target_ip=socket.gethostbyname(TARGET_HOST)`,
		`    t.connect((target_ip,TARGET_PORT))`,
		`  except Exception:`,
		`    c.close(); t.close(); continue`,
		`  threading.Thread(target=pipe,args=(c,t),daemon=True).start()`,
		`  threading.Thread(target=pipe,args=(t,c),daemon=True).start()`,
	].join("\n");

	const cmd = [
		`if [ -f ${pidPath} ] && kill -0 "$(cat ${pidPath})" 2>/dev/null; then exit 0; fi`,
		`cat > ${scriptPath} <<'PY'`,
		py,
		`PY`,
		`nohup python ${scriptPath} >${logPath} 2>&1 &`,
	].join("\n");

	const result = await hostExecutor.exec(`docker exec ${proxyName} sh -lc ${shellEscape(cmd)}`, { timeout: 12 });
	if (result.code !== 0) {
		throw new Error(`Failed to start proxy CDP relay in ${proxyName}. ${result.stderr || result.stdout}`.trim());
	}
}

async function ensureVibesiloHostBrowserBridge(hostWorkspaceDir: string, sandbox: VibesiloSandbox): Promise<void> {
	const settings = new MomSettingsManager(hostWorkspaceDir);
	const hostBrowser = settings.getHostBrowserSettings();
	if (!hostBrowser.enabled || !hostBrowser.autoStartBridge) return;

	const cdpPort = hostBrowser.cdpPort ?? 9223;
	const cdpTarget = hostBrowser.cdpTarget ?? "host.docker.internal:9223";
	const hostExecutor = new HostExecutor();
	const parsedTarget = parseHostPort(cdpTarget);
	await ensureHostBrowserRunning(parsedTarget.host, parsedTarget.port, hostBrowser);
	let effectiveTarget = cdpTarget;

	// In vibesilo networks, sandbox often can't directly resolve/reach host.docker.internal.
	// Route through the proxy container when host CDP is requested.
	if (parsedTarget.host === "host.docker.internal") {
		const proxyName = await deriveProxyContainerName(sandbox.containerId);
		if (!proxyName) {
			const msg = "Could not derive vibesilo proxy container name for host browser relay";
			if (hostBrowser.required) throw new Error(msg);
			sandboxLog(`${msg}. Continuing without host browser.`);
			return;
		}
		const relayPort = parsedTarget.port + 10000;
		try {
			await ensureProxyCdpRelay(proxyName, parsedTarget.host, parsedTarget.port, relayPort);
			effectiveTarget = `${proxyName}:${relayPort}`;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (hostBrowser.required) throw new Error(msg);
			sandboxLog(`${msg}. Continuing without host browser.`);
			return;
		}
	}

	const bridgeKey = `${sandbox.containerId}:${cdpPort}:${effectiveTarget}`;
	const pidFile = `/tmp/mom-cdp-bridge-${cdpPort}.pid`;
	const logFile = `/tmp/mom-cdp-bridge-${cdpPort}.log`;
	const startCmd = [
		`command -v socat >/dev/null 2>&1 || { echo "socat not found"; exit 127; }`,
		`if [ -f ${pidFile} ] && kill -0 "$(cat ${pidFile})" 2>/dev/null; then exit 0; fi`,
		`nohup socat TCP-LISTEN:${cdpPort},bind=127.0.0.1,reuseaddr,fork TCP:${effectiveTarget} >${logFile} 2>&1 & echo $! > ${pidFile}`,
	].join("; ");

	// Start bridge only if needed/new target.
	if (vibesiloBridgeKey !== bridgeKey) {
		const startResult = await hostExecutor.exec(
			`docker exec ${sandbox.containerId} sh -lc ${shellEscape(startCmd)}`,
			{
				timeout: 10,
			},
		);
		if (startResult.code !== 0) {
			const msg = `Failed to start host-browser bridge (socat) for ${effectiveTarget} on 127.0.0.1:${cdpPort}`;
			if (hostBrowser.required) throw new Error(`${msg}. ${startResult.stderr || startResult.stdout}`.trim());
			sandboxLog(`${msg}. Continuing without host browser.`);
			return;
		}
		vibesiloBridgeKey = bridgeKey;
	}

	let healthy = false;
	for (let i = 0; i < 10; i++) {
		const healthResult = await hostExecutor.exec(
			`docker exec ${sandbox.containerId} sh -lc ${shellEscape(`curl -fsS --max-time 3 http://127.0.0.1:${cdpPort}/json/version >/dev/null`)}`,
			{ timeout: 6 },
		);
		if (healthResult.code === 0) {
			healthy = true;
			break;
		}
		await new Promise((r) => setTimeout(r, 250));
	}

	if (!healthy) {
		const msg =
			`Host-browser bridge is up but CDP health check failed at 127.0.0.1:${cdpPort}. ` +
			`Expected host target ${cdpTarget}.`;
		if (hostBrowser.required) throw new Error(msg);
		sandboxLog(`${msg} Continuing without host browser.`);
		return;
	}
}

async function ensureVibesiloUpworkCliInit(hostWorkspaceDir: string, sandbox: VibesiloSandbox): Promise<void> {
	const settings = new MomSettingsManager(hostWorkspaceDir);
	const hostBrowser = settings.getHostBrowserSettings();
	if (!hostBrowser.enabled) return;

	const cdpPort = hostBrowser.cdpPort ?? 9223;
	const initKey = `${sandbox.containerId}:${cdpPort}`;
	if (vibesiloUpworkInitKey === initKey) return;

	const hostExecutor = new HostExecutor();
	const hasUpworkCli = await hostExecutor.exec(
		`docker exec ${sandbox.containerId} sh -lc ${shellEscape("command -v upwork-cli >/dev/null 2>&1")}`,
		{ timeout: 8 },
	);
	if (hasUpworkCli.code !== 0) {
		throw new Error(
			"upwork-cli is not installed in the vibesilo sandbox image. Build mom-vibesilo-tools with upwork-cli.",
		);
	}

	const initCommand = `upwork-cli init --cdp docker --cdp-port ${cdpPort}`;
	let initResult = await hostExecutor.exec(`docker exec ${sandbox.containerId} sh -lc ${shellEscape(initCommand)}`, {
		timeout: 60,
	});
	if (initResult.code !== 0) {
		// In some Docker network setups host.docker.internal is not resolvable inside the sandbox.
		// Fall back to explicit localhost CDP target (the bridge is already on 127.0.0.1:<cdpPort>).
		const fallbackCommand = `upwork-cli init --cdp 127.0.0.1:${cdpPort} --cdp-port ${cdpPort}`;
		const fallback = await hostExecutor.exec(
			`docker exec ${sandbox.containerId} sh -lc ${shellEscape(fallbackCommand)}`,
			{
				timeout: 60,
			},
		);
		if (fallback.code !== 0) {
			throw new Error(`Failed to initialize upwork-cli CDP mode. ${fallback.stderr || fallback.stdout}`.trim());
		}
		sandboxLog(
			`upwork-cli docker auto-discovery failed, using explicit localhost CDP target 127.0.0.1:${cdpPort} instead.`,
		);
		initResult = fallback;
	}

	vibesiloUpworkInitKey = initKey;
	sandboxLog(`Initialized upwork-cli CDP mode on 127.0.0.1:${cdpPort}`);
}

export async function getHostBrowserStatus(
	config: SandboxConfig,
	hostWorkspaceDir: string,
): Promise<HostBrowserStatus> {
	if (config.type !== "vibesilo") {
		return getHostBrowserStatusDefault("host browser bridge is only supported for vibesilo sandbox");
	}

	const settings = new MomSettingsManager(hostWorkspaceDir);
	const hostBrowser = settings.getHostBrowserSettings();
	const cdpPort = hostBrowser.cdpPort ?? 9223;
	const cdpTarget = hostBrowser.cdpTarget ?? "host.docker.internal:9223";
	if (!hostBrowser.enabled) {
		return {
			configured: true,
			enabled: false,
			cdpPort,
			cdpTarget,
			bridgeRunning: false,
			healthy: false,
			reason: "disabled in settings.json (hostBrowser.enabled=false)",
		};
	}
	if (!vibesiloSandbox) {
		return {
			configured: true,
			enabled: true,
			cdpPort,
			cdpTarget,
			bridgeRunning: false,
			healthy: false,
			reason: "vibesilo sandbox not started yet",
		};
	}
	try {
		const probe = await probeHostBrowserBridge(vibesiloSandbox.containerId, cdpPort);
		return {
			configured: true,
			enabled: true,
			cdpPort,
			cdpTarget,
			bridgeRunning: probe.running,
			healthy: probe.healthy,
		};
	} catch (err) {
		return {
			configured: true,
			enabled: true,
			cdpPort,
			cdpTarget,
			bridgeRunning: false,
			healthy: false,
			reason: err instanceof Error ? err.message : String(err),
		};
	}
}

function isValidPort(value: number): boolean {
	return Number.isInteger(value) && value > 0 && value <= 65535;
}

function validateVibesiloPortMappings(
	portMappings: { hostPort: number; containerPort: number; bindAddress?: string }[] | undefined,
): void {
	if (!portMappings || portMappings.length === 0) return;
	const seen = new Set<number>();
	for (const mapping of portMappings) {
		if (!isValidPort(mapping.hostPort) || !isValidPort(mapping.containerPort)) {
			throw new Error(
				`vibesilo.portMappings contains invalid ports: hostPort=${mapping.hostPort}, containerPort=${mapping.containerPort}`,
			);
		}
		if (seen.has(mapping.hostPort)) {
			throw new Error(`vibesilo.portMappings contains duplicate hostPort ${mapping.hostPort}`);
		}
		seen.add(mapping.hostPort);
	}
}

async function getOrCreateVibesiloSandbox(hostWorkspaceDir: string): Promise<VibesiloSandbox> {
	if (vibesiloSandbox) return vibesiloSandbox;
	if (vibesiloSandboxCreating) return vibesiloSandboxCreating;

	if (vibesiloHostWorkspaceDir && vibesiloHostWorkspaceDir !== hostWorkspaceDir) {
		throw new Error(
			`vibesilo sandbox already initialized for workspace '${vibesiloHostWorkspaceDir}', cannot re-init for '${hostWorkspaceDir}'`,
		);
	}
	vibesiloHostWorkspaceDir = hostWorkspaceDir;

	vibesiloSandboxCreating = (async () => {
		const settings = new MomSettingsManager(hostWorkspaceDir);
		const vibesilo = settings.getVibesiloSettings();

		const allowNet = vibesilo.allowNet ?? [];
		if (allowNet.length === 0) {
			throw new Error(
				"vibesilo sandbox requires non-empty settings.json vibesilo.allowNet (empty means allow-all in vibesilo)",
			);
		}
		validateVibesiloPortMappings(vibesilo.portMappings);

		const secrets: Record<string, { hosts: string[]; value: string }> = {};
		if (vibesilo.secrets) {
			for (const [name, spec] of Object.entries(vibesilo.secrets)) {
				const value = process.env[spec.fromEnv];
				if (!value) {
					throw new Error(`vibesilo secret '${name}' requires env var '${spec.fromEnv}' to be set`);
				}
				secrets[name] = { hosts: spec.hosts, value };
			}
		}

		sandboxLog(`Starting vibesilo sandbox (image=${vibesilo.image ?? "node:20-bookworm"})...`);

		const sandbox = await VibesiloSandbox.create({
			name: `mom-vibesilo-${process.pid}`,
			image: vibesilo.image ?? "node:20-bookworm",
			allowNet,
			debugInjectHeader: vibesilo.debugInjectHeader ?? false,
			mounts: [{ host: hostWorkspaceDir, guest: "/workspace", readOnly: false }],
			portMappings: vibesilo.portMappings,
			secrets,
		});

		vibesiloSandbox = sandbox;
		vibesiloPlaceholders = sandbox.placeholders;
		await ensureVibesiloHostBrowserBridge(hostWorkspaceDir, sandbox);
		await ensureVibesiloUpworkCliInit(hostWorkspaceDir, sandbox);
		return sandbox;
	})();

	try {
		return await vibesiloSandboxCreating;
	} finally {
		vibesiloSandboxCreating = null;
	}
}

function buildContainerShellCommand(command: string): string {
	const wrapped = `if command -v bash >/dev/null 2>&1; then exec bash -lc ${shellEscape(command)}; else exec sh -c ${shellEscape(command)}; fi`;
	return `sh -lc ${shellEscape(wrapped)}`;
}

class VibesiloExecutor implements Executor {
	constructor(private hostWorkspaceDir: string) {}

	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		const sandbox = await getOrCreateVibesiloSandbox(this.hostWorkspaceDir);
		await ensureVibesiloHostBrowserBridge(this.hostWorkspaceDir, sandbox);
		await ensureVibesiloUpworkCliInit(this.hostWorkspaceDir, sandbox);
		const placeholders = vibesiloPlaceholders ?? {};
		const envFlags = Object.entries(placeholders)
			.map(([name, value]) => `-e ${shellEscape(`${name}=${value}`)}`)
			.join(" ");
		const shellCmd = buildContainerShellCommand(command);
		const dockerCmd = `docker exec${envFlags ? ` ${envFlags}` : ""} ${sandbox.containerId} ${shellCmd}`;
		const hostExecutor = new HostExecutor();
		return hostExecutor.exec(dockerCmd, options);
	}

	getWorkspacePath(_hostPath: string): string {
		return "/workspace";
	}
}

function sandboxLog(msg: string): void {
	// Keep it minimal: only console; avoid Slack noise.
	console.log(msg);
}

class HostExecutor implements Executor {
	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		return new Promise((resolve, reject) => {
			const shell = process.platform === "win32" ? "cmd" : "sh";
			const shellArgs = process.platform === "win32" ? ["/c"] : ["-c"];

			const child = spawn(shell, [...shellArgs, command], {
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";
			let timedOut = false;

			const timeoutHandle =
				options?.timeout && options.timeout > 0
					? setTimeout(() => {
							timedOut = true;
							killProcessTree(child.pid!);
						}, options.timeout * 1000)
					: undefined;

			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			if (options?.signal) {
				if (options.signal.aborted) {
					onAbort();
				} else {
					options.signal.addEventListener("abort", onAbort, { once: true });
				}
			}

			child.stdout?.on("data", (data) => {
				stdout += data.toString();
				if (stdout.length > 10 * 1024 * 1024) {
					stdout = stdout.slice(0, 10 * 1024 * 1024);
				}
			});

			child.stderr?.on("data", (data) => {
				stderr += data.toString();
				if (stderr.length > 10 * 1024 * 1024) {
					stderr = stderr.slice(0, 10 * 1024 * 1024);
				}
			});

			child.on("close", (code) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (options?.signal) {
					options.signal.removeEventListener("abort", onAbort);
				}

				if (options?.signal?.aborted) {
					reject(new Error(`${stdout}\n${stderr}\nCommand aborted`.trim()));
					return;
				}

				if (timedOut) {
					reject(new Error(`${stdout}\n${stderr}\nCommand timed out after ${options?.timeout} seconds`.trim()));
					return;
				}

				resolve({ stdout, stderr, code: code ?? 0 });
			});
		});
	}

	getWorkspacePath(hostPath: string): string {
		return hostPath;
	}
}

class DockerExecutor implements Executor {
	constructor(private container: string) {}

	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		// Wrap command for docker exec (prefer bash when available, fallback to sh)
		const shellCmd = buildContainerShellCommand(command);
		const dockerCmd = `docker exec ${this.container} ${shellCmd}`;
		const hostExecutor = new HostExecutor();
		return hostExecutor.exec(dockerCmd, options);
	}

	getWorkspacePath(_hostPath: string): string {
		// Docker container sees /workspace
		return "/workspace";
	}
}

function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
			});
		} catch {
			// Ignore errors
		}
	} else {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		}
	}
}

function shellEscape(s: string): string {
	// POSIX single-quote escaping for shell command arguments
	return `'${s.replace(/'/g, "'\\''")}'`;
}
