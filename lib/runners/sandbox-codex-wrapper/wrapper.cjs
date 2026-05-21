/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn } = require("node:child_process");
const { readFile } = require("node:fs/promises");

function requiredEnv(name) {
	const value = process.env[name];

	if (!value) {
		throw new Error("Missing required environment variable: " + name);
	}

	return value;
}

function readOptionalInteger(name, fallback) {
	const value = process.env[name];

	if (value === undefined) {
		return fallback;
	}

	const parsed = Number.parseInt(value, 10);

	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error("Invalid integer environment variable: " + name);
	}

	return parsed;
}

function buildCodexChildEnv() {
	const env = { ...process.env };

	for (const name of Object.keys(env)) {
		if (name.startsWith("RHAPSODY_")) {
			delete env[name];
		}
	}

	env.CODEX_HOME = process.env.CODEX_HOME;
	return env;
}

const PROMPT_PATH = requiredEnv("RHAPSODY_PROMPT_PATH");
const METADATA_PATH = requiredEnv("RHAPSODY_METADATA_PATH");
const PR_SPEC_PATH = requiredEnv("RHAPSODY_PR_SPEC_PATH");
const OUTPUT_PREVIEW_LENGTH = readOptionalInteger(
	"RHAPSODY_OUTPUT_PREVIEW_LENGTH",
	1000,
);
const CODEX_TIMEOUT_MS = readOptionalInteger(
	"RHAPSODY_CODEX_TIMEOUT_MS",
	600000,
);

function runCommand(command, args, cwd) {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			cwd,
		});
		let stdout = "";
		let stderr = "";
		let spawnError = null;

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});

		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});

		child.on("error", (error) => {
			spawnError = error.message;
		});

		child.on("close", (code) => {
			resolve({
				command,
				args,
				exit_code: code,
				stdout: stdout.slice(0, OUTPUT_PREVIEW_LENGTH),
				stderr: stderr.slice(0, OUTPUT_PREVIEW_LENGTH),
				error: spawnError,
			});
		});
	});
}

async function readJsonPrSpec() {
	try {
		const rawPrSpec = await readFile(PR_SPEC_PATH, "utf8");
		const parsed = JSON.parse(rawPrSpec);

		if (
			typeof parsed !== "object" ||
			parsed === null ||
			typeof parsed.title !== "string" ||
			!parsed.title.trim() ||
			typeof parsed.body !== "string" ||
			!parsed.body.trim()
		) {
			return {
				ok: false,
				error:
					"PR spec was present but not a valid non-empty { title, body } object.",
			};
		}

		return { ok: true, value: parsed };
	} catch (error) {
		return {
			ok: false,
			error:
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code === "ENOENT"
					? "Could not find PR spec at " + PR_SPEC_PATH + "."
					: "PR spec must be readable JSON with non-empty title and body.",
		};
	}
}

async function sendTerminalCallback(payload) {
	const callbackUrl = requiredEnv("RHAPSODY_CALLBACK_URL");
	let lastResult = null;

	for (const delayMs of [0, 1_000, 3_000]) {
		if (delayMs > 0) {
			await sleep(delayMs);
		}

		try {
			const response = await fetch(callbackUrl, {
				method: "POST",
				headers: {
					"content-type": "application/json",
				},
				body: JSON.stringify(payload),
			});
			const text = await response.text();
			lastResult = {
				status: response.status,
				ok: response.ok,
				body: safeJson(text),
			};

			if (response.ok) {
				return lastResult;
			}
		} catch (error) {
			lastResult = {
				status: null,
				ok: false,
				body: error instanceof Error ? error.message : String(error),
			};
		}
	}

	return lastResult;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJson(text) {
	if (!text) {
		return null;
	}

	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

async function runWritePostflight(metadata) {
	if (metadata.codex_mode !== "write") {
		return null;
	}

	const cwd = metadata.repository_path;
	const targetBranch = metadata.target_branch;
	const baseBranch = metadata.base_branch;
	if (typeof baseBranch !== "string" || baseBranch.length === 0) {
		return {
			ok: false,
			error: "Sandbox metadata did not include a base branch.",
			commands: {},
		};
	}

	const commitCountCommand = await runCommand(
		"git",
		["rev-list", "--count", "origin/" + baseBranch + "..HEAD"],
		cwd,
	);
	const commitCount = Number.parseInt(commitCountCommand.stdout.trim(), 10);

	if (commitCountCommand.exit_code !== 0 || !Number.isFinite(commitCount)) {
		return {
			ok: false,
			error: "Could not determine whether Codex created a commit.",
			commands: { commit_count: commitCountCommand },
		};
	}

	if (commitCount < 1) {
		return {
			ok: false,
			error: "Codex did not create a commit beyond origin/" + baseBranch + ".",
			commands: { commit_count: commitCountCommand },
		};
	}

	const pushCommand = await runCommand(
		"git",
		["push", "origin", "HEAD:" + targetBranch],
		cwd,
	);

	if (pushCommand.exit_code !== 0) {
		return {
			ok: false,
			error: "Could not push the assigned branch.",
			commands: {
				commit_count: commitCountCommand,
				push: pushCommand,
			},
		};
	}

	const verifyCommand = await runCommand(
		"git",
		["ls-remote", "--heads", "origin", targetBranch],
		cwd,
	);

	if (verifyCommand.exit_code !== 0 || !verifyCommand.stdout.trim()) {
		return {
			ok: false,
			error: "Remote branch verification failed after push.",
			commands: {
				commit_count: commitCountCommand,
				push: pushCommand,
				verify: verifyCommand,
			},
		};
	}

	const prSpecResult = await readJsonPrSpec();

	if (!prSpecResult.ok) {
		return {
			ok: false,
			error: prSpecResult.error,
			commands: {
				commit_count: commitCountCommand,
				push: pushCommand,
				verify: verifyCommand,
			},
		};
	}

	return {
		ok: true,
		error: null,
		commands: {
			commit_count: commitCountCommand,
			push: pushCommand,
			verify: verifyCommand,
		},
		pr_spec: prSpecResult.value,
		changed_files: await changedFilesFromGit(metadata.command.cwd, baseBranch),
	};
}

async function changedFilesFromGit(workdir, baseBranch) {
	const changedFilesCommand = await runCommand(
		"git",
		["diff", "--name-only", "origin/" + baseBranch + "..HEAD"],
		workdir,
	);

	if (changedFilesCommand.exit_code !== 0) {
		return [];
	}

	return changedFilesCommand.stdout
		.trim()
		.split("\n")
		.map((path) => path.trim())
		.filter((path) => path.length > 0);
}

(async () => {
	const metadata = JSON.parse(await readFile(METADATA_PATH, "utf8"));
	const prompt = await readFile(PROMPT_PATH, "utf8");
	const startedAt = new Date().toISOString();

	const child = spawn(metadata.command.command, metadata.command.argv, {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: metadata.command.cwd,
		env: buildCodexChildEnv(),
	});

	let stdout = "";
	let stderr = "";
	let exitCode = null;
	let spawnError = null;
	let timedOut = false;

	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString("utf8");
	});

	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString("utf8");
	});

	child.on("error", (error) => {
		spawnError = error.message;
	});

	child.stdin.end(prompt);

	const timeout = setTimeout(() => {
		timedOut = true;
		child.kill("SIGTERM");
		setTimeout(() => {
			if (exitCode === null) {
				child.kill("SIGKILL");
			}
		}, 5_000);
	}, CODEX_TIMEOUT_MS);

	const wrappedExitCode = await new Promise((resolve) => {
		child.on("close", (code) => {
			resolve(code);
		});
	});
	clearTimeout(timeout);

	exitCode = wrappedExitCode;
	const postflight =
		!spawnError && !timedOut && exitCode === 0
			? await runWritePostflight(metadata)
			: null;
	const postflightError =
		postflight && !postflight.ok ? postflight.error : null;
	const executionStatus = timedOut
		? "timed_out"
		: !spawnError && exitCode === 0 && postflight && postflight.ok
			? "completed"
			: "failed";
	const completedAt = new Date().toISOString();
	const callbackPayload = {
		run_id: requiredEnv("RHAPSODY_RUN_ID"),
		attempt_id: requiredEnv("RHAPSODY_ATTEMPT_ID"),
		claim_token: requiredEnv("RHAPSODY_CLAIM_TOKEN"),
		execution_status: executionStatus,
		exit_code: typeof exitCode === "number" ? exitCode : null,
		sandbox_id: requiredEnv("RHAPSODY_SANDBOX_ID"),
		command_id: process.env.RHAPSODY_COMMAND_ID ?? null,
		started_at: startedAt,
		completed_at: completedAt,
		error:
			spawnError ??
			(timedOut ? "Codex timed out." : null) ??
			postflightError ??
			(exitCode === 0
				? null
				: "Codex runner failed before completing postflight."),
		postflight,
		pr_spec: postflight ? (postflight.pr_spec ?? null) : null,
		branch_name: metadata.target_branch,
		hook_token: requiredEnv("RHAPSODY_HOOK_TOKEN"),
	};
	const callback = await sendTerminalCallback(callbackPayload);

	console.log(
		JSON.stringify({
			codex_exit_code: exitCode,
			codex_timed_out: timedOut,
			codex_stdout: stdout.slice(0, OUTPUT_PREVIEW_LENGTH),
			codex_stderr: stderr.slice(0, OUTPUT_PREVIEW_LENGTH),
			postflight,
			pr_spec: postflight ? (postflight.pr_spec ?? null) : null,
			callback,
		}),
	);

	if (
		!callback.ok ||
		spawnError ||
		timedOut ||
		postflightError ||
		exitCode !== 0
	) {
		process.exitCode = 1;
	}
})();
