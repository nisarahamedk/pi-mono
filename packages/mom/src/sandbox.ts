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
			secrets,
		});

		vibesiloSandbox = sandbox;
		vibesiloPlaceholders = sandbox.placeholders;
		return sandbox;
	})();

	try {
		return await vibesiloSandboxCreating;
	} finally {
		vibesiloSandboxCreating = null;
	}
}

class VibesiloExecutor implements Executor {
	constructor(private hostWorkspaceDir: string) {}

	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		const sandbox = await getOrCreateVibesiloSandbox(this.hostWorkspaceDir);
		const placeholders = vibesiloPlaceholders ?? {};
		const envFlags = Object.entries(placeholders)
			.map(([name, value]) => `-e ${shellEscape(`${name}=${value}`)}`)
			.join(" ");
		const dockerCmd = `docker exec${envFlags ? ` ${envFlags}` : ""} ${sandbox.containerId} sh -c ${shellEscape(command)}`;
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
		// Wrap command for docker exec
		const dockerCmd = `docker exec ${this.container} sh -c ${shellEscape(command)}`;
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
	// Escape for passing to sh -c
	return `'${s.replace(/'/g, "'\\''")}'`;
}
