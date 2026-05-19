import { spawn } from "node:child_process";

export type CodexCliSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexCliApprovalPolicy = "untrusted" | "on-request" | "never";

export type CodexCliConfigValue = string | number | boolean | null;

export type CodexCliOptions = {
	cwd: string;
	prompt: string;
	sandboxMode?: CodexCliSandboxMode;
	approvalPolicy?: CodexCliApprovalPolicy;
	json?: boolean;
	outputLastMessageFile?: string;
	skipGitRepoCheck?: boolean;
	ephemeral?: boolean;
	configOverrides?: Record<string, CodexCliConfigValue>;
	timeoutMs?: number;
};

export type CodexCliCommand = {
	command: "codex";
	globalArgv: string[];
	execArgv: string[];
	argv: string[];
	cwd: string;
	stdinLength: number;
};

export type CodexCliResult = {
	command: CodexCliCommand;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	stdout: string;
	stderr: string;
	durationMs: number;
	error: string | null;
};

export function buildCodexExecCommand(options: CodexCliOptions): CodexCliCommand {
	const globalArgv: string[] = [];
	const execArgv = ["exec", "--cd", options.cwd];

	if (options.approvalPolicy) {
		globalArgv.push("--ask-for-approval", options.approvalPolicy);
	}

	if (options.json) {
		execArgv.push("--json");
	}

	if (options.outputLastMessageFile) {
		execArgv.push("--output-last-message", options.outputLastMessageFile);
	}

	if (options.skipGitRepoCheck) {
		execArgv.push("--skip-git-repo-check");
	}

	if (options.ephemeral) {
		execArgv.push("--ephemeral");
	}

	if (options.sandboxMode) {
		execArgv.push("--sandbox", options.sandboxMode);
	}

	for (const [key, value] of Object.entries(options.configOverrides ?? {}).sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		execArgv.push("--config", `${key}=${formatConfigValue(value)}`);
	}

	return {
		command: "codex",
		globalArgv,
		execArgv,
		argv: [...globalArgv, ...execArgv],
		cwd: options.cwd,
		stdinLength: options.prompt.length,
	};
}

export async function runCodexExec(options: CodexCliOptions): Promise<CodexCliResult> {
	const command = buildCodexExecCommand(options);
	const startedAt = Date.now();

	return new Promise((resolve) => {
		const child = spawn(command.command, command.argv, {
			cwd: options.cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let timedOut = false;
		let settled = false;
		let spawnError: string | null = null;
		let forceKillTimeout: NodeJS.Timeout | null = null;

		const timeout =
			options.timeoutMs && options.timeoutMs > 0
				? setTimeout(() => {
						timedOut = true;
						child.kill("SIGTERM");
						forceKillTimeout = setTimeout(() => {
							child.kill("SIGKILL");
						}, 5_000);
					}, options.timeoutMs)
				: null;

		child.stdout.on("data", (chunk: Buffer) => {
			stdoutChunks.push(chunk);
		});

		child.stderr.on("data", (chunk: Buffer) => {
			stderrChunks.push(chunk);
		});

		child.on("error", (error) => {
			spawnError = error.message;
		});

		child.on("close", (exitCode, signal) => {
			if (settled) {
				return;
			}

			settled = true;

			if (timeout) {
				clearTimeout(timeout);
			}

			if (forceKillTimeout) {
				clearTimeout(forceKillTimeout);
			}

			resolve({
				command,
				exitCode,
				signal,
				timedOut,
				stdout: Buffer.concat(stdoutChunks).toString("utf8"),
				stderr: Buffer.concat(stderrChunks).toString("utf8"),
				durationMs: Date.now() - startedAt,
				error: spawnError,
			});
		});

		child.stdin.end(options.prompt);
	});
}

function formatConfigValue(value: CodexCliConfigValue): string {
	if (typeof value === "string") {
		return JSON.stringify(value);
	}

	return String(value);
}
