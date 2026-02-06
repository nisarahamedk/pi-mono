import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function docker(args: string[], options: { cwd?: string } = {}) {
	const { stdout, stderr } = await execFileAsync("docker", args, {
		cwd: options.cwd,
	});
	return { stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function dockerQuiet(args: string[]) {
	try {
		await docker(args);
	} catch {
		// ignore
	}
}

export async function dockerSpawn(args: string[]) {
	return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
		const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});

		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		child.on("error", (err) => reject(err));
		child.on("close", (code) => {
			resolve({
				stdout: stdout.trim(),
				stderr: stderr.trim(),
				exitCode: code ?? 0,
			});
		});
	});
}
