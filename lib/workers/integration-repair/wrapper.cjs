#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
const { readFile } = require("node:fs/promises");
const { spawn } = require("node:child_process");
const path = require("node:path");

function requiredEnv(name) {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

function readJson(path) {
	return readFile(path, "utf8").then((raw) => JSON.parse(raw));
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

function runCommand(command, args, cwd, options = {}) {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd,
			env: options.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let spawnError = null;
		let timedOut = false;
		let forceKillTimeout = null;
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
			if (timeout) {
				clearTimeout(timeout);
			}
			if (forceKillTimeout) {
				clearTimeout(forceKillTimeout);
			}
			resolve({
				command,
				args,
				exitCode: code,
				stdout,
				stderr,
				timedOut,
				error: spawnError,
			});
		});

		if (typeof options.input === "string") {
			child.stdin.end(options.input);
			return;
		}

		child.stdin.end();
	});
}

function parseFileList(raw) {
	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function parseStatusFileList(raw) {
	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => {
			const pathPart = line.slice(3);
			const renameSeparator = " -> ";
			if (pathPart.includes(renameSeparator)) {
				return pathPart.split(renameSeparator).at(-1) || pathPart;
			}
			return pathPart;
		});
}

function uniqueFileList(files) {
	return Array.from(new Set(files));
}

function summarizeCommand(result) {
	return {
		exitCode: result.exitCode,
		timedOut: Boolean(result.timedOut),
		stdoutPreview: result.stdout.slice(0, 4000),
		stderrPreview: result.stderr.slice(0, 4000),
		error: result.error,
	};
}

function emit(payload) {
	process.stdout.write(JSON.stringify(payload));
}

(async () => {
	const metadataPath = requiredEnv("RHAPSODY_METADATA_PATH");
	const promptPath = requiredEnv("RHAPSODY_PROMPT_PATH");
	const metadata = await readJson(metadataPath);
	const prompt = await readFile(promptPath, "utf8");

	const owner = metadata.owner;
	const repository = metadata.repository;
	const repositoryPath =
		metadata.repositoryPath || "/vercel/sandbox/repository";
	const sandboxWorkdir = path.dirname(repositoryPath);
	const repositoryUrl =
		metadata.repositoryUrl ||
		`https://github.com/${metadata.owner}/${metadata.repository}.git`;
	const headRef = metadata.headRef;
	const baseRef = metadata.baseRef;
	const commitMessage =
		metadata.commitMessage ||
		`chore: integrate latest ${baseRef} into ${headRef}`;
	const gitUserName = metadata.gitUserName || "Rhapsody Codex";
	const gitUserEmail = metadata.gitUserEmail || "rhapsody-codex@localhost";
	const codexTimeoutMs =
		typeof metadata.codexTimeoutMs === "number" ? metadata.codexTimeoutMs : 0;

	if (typeof owner !== "string" || !owner) {
		emit({
			ok: false,
			outcome: "integration_repair_failed",
			error: "Missing owner in metadata.",
		});
		return;
	}

	if (typeof repository !== "string" || !repository) {
		emit({
			ok: false,
			outcome: "integration_repair_failed",
			error: "Missing repository in metadata.",
		});
		return;
	}

	if (typeof headRef !== "string" || !headRef) {
		emit({
			ok: false,
			outcome: "integration_repair_failed",
			error: "Missing headRef in metadata.",
		});
		return;
	}

	if (typeof baseRef !== "string" || !baseRef) {
		emit({
			ok: false,
			outcome: "integration_repair_failed",
			error: "Missing baseRef in metadata.",
		});
		return;
	}

	if (
		typeof metadata.codexCommand !== "object" ||
		metadata.codexCommand === null ||
		typeof metadata.codexCommand.command !== "string" ||
		!Array.isArray(metadata.codexCommand.argv)
	) {
		emit({
			ok: false,
			outcome: "integration_repair_failed",
			error: "Missing codexCommand in metadata.",
		});
		return;
	}

	try {
		await runCommand("rm", ["-rf", repositoryPath], sandboxWorkdir);

		const clone = await runCommand(
			"git",
			["clone", repositoryUrl, repositoryPath],
			sandboxWorkdir,
		);
		if (clone.exitCode !== 0) {
			emit({
				ok: false,
				outcome: "integration_repair_failed",
				error: `Could not clone repository: ${clone.stderr || clone.stdout}`,
			});
			return;
		}

		const fetchHead = await runCommand(
			"git",
			["fetch", "origin", headRef],
			repositoryPath,
		);
		if (fetchHead.exitCode !== 0) {
			emit({
				ok: false,
				outcome: "integration_repair_failed",
				error: `Could not fetch head ref ${headRef}: ${fetchHead.stderr || fetchHead.stdout}`,
			});
			return;
		}

		const fetchBase = await runCommand(
			"git",
			["fetch", "origin", baseRef],
			repositoryPath,
		);
		if (fetchBase.exitCode !== 0) {
			emit({
				ok: false,
				outcome: "integration_repair_failed",
				error: `Could not fetch base ref ${baseRef}: ${fetchBase.stderr || fetchBase.stdout}`,
			});
			return;
		}

		const checkout = await runCommand(
			"git",
			["checkout", "-B", headRef, `origin/${headRef}`],
			repositoryPath,
		);
		if (checkout.exitCode !== 0) {
			emit({
				ok: false,
				outcome: "integration_repair_failed",
				error: `Could not checkout ${headRef}: ${checkout.stderr || checkout.stdout}`,
			});
			return;
		}

		const configureUserName = await runCommand(
			"git",
			["config", "user.name", gitUserName],
			repositoryPath,
		);
		if (configureUserName.exitCode !== 0) {
			emit({
				ok: false,
				outcome: "integration_repair_failed",
				error: `Could not configure git user.name: ${configureUserName.stderr || configureUserName.stdout}`,
			});
			return;
		}

		const configureUserEmail = await runCommand(
			"git",
			["config", "user.email", gitUserEmail],
			repositoryPath,
		);
		if (configureUserEmail.exitCode !== 0) {
			emit({
				ok: false,
				outcome: "integration_repair_failed",
				error: `Could not configure git user.email: ${configureUserEmail.stderr || configureUserEmail.stdout}`,
			});
			return;
		}

		const headBefore = await runCommand(
			"git",
			["rev-parse", "HEAD"],
			repositoryPath,
		);
		const previousHeadSha = headBefore.stdout.trim().split("\n")[0] || "";

		const merge = await runCommand(
			"git",
			["merge", "--no-ff", "-m", commitMessage, `origin/${baseRef}`],
			repositoryPath,
		);

		if (merge.exitCode === 0) {
			const headAfterMerge = await runCommand(
				"git",
				["rev-parse", "HEAD"],
				repositoryPath,
			);
			const currentHeadSha = headAfterMerge.stdout.trim().split("\n")[0] || "";
			const push = await runCommand(
				"git",
				["push", "origin", `HEAD:refs/heads/${headRef}`],
				repositoryPath,
			);
			if (push.exitCode !== 0) {
				emit({
					ok: false,
					outcome: "integration_repair_failed",
					error: `Could not push integration commit: ${push.stderr || push.stdout}`,
				});
				return;
			}

			const changedFiles = parseFileList(
				(
					await runCommand(
						"git",
						["show", "--pretty=", "--name-only", "HEAD"],
						repositoryPath,
					)
				).stdout,
			);

			emit({
				ok: true,
				outcome:
					currentHeadSha && currentHeadSha !== previousHeadSha
						? "integration_repair_applied"
						: "integration_repair_noop",
				artifact:
					currentHeadSha && currentHeadSha !== previousHeadSha
						? {
								sha: currentHeadSha,
								htmlUrl: `https://github.com/${owner}/${repository}/commit/${currentHeadSha}`,
								changedFiles,
							}
						: undefined,
			});
			return;
		}

		const conflictingFiles = parseFileList(
			(
				await runCommand(
					"git",
					["diff", "--name-only", "--diff-filter=U"],
					repositoryPath,
				)
			).stdout,
		);

		if (conflictingFiles.length === 0) {
			emit({
				ok: false,
				outcome: "integration_repair_failed",
				error: `Base integration failed without merge conflicts: ${merge.stderr || merge.stdout}`,
			});
			return;
		}

		const allowedChangedFiles = parseFileList(
			(await runCommand("git", ["diff", "--name-only", "HEAD"], repositoryPath))
				.stdout,
		);

		const codex = await runCommand(
			metadata.codexCommand.command,
			metadata.codexCommand.argv,
			metadata.codexCommand.cwd || repositoryPath,
			{
				input: prompt,
				env: buildCodexChildEnv(),
				timeoutMs: codexTimeoutMs,
			},
		);
		const remainingConflictingFiles = parseFileList(
			(
				await runCommand(
					"git",
					["diff", "--name-only", "--diff-filter=U"],
					repositoryPath,
				)
			).stdout,
		);
		const changedFilesAfterCodex = uniqueFileList([
			...parseFileList(
				(
					await runCommand(
						"git",
						["diff", "--name-only", "HEAD"],
						repositoryPath,
					)
				).stdout,
			),
			...parseStatusFileList(
				(
					await runCommand(
						"git",
						["status", "--porcelain", "--untracked-files=all"],
						repositoryPath,
					)
				).stdout,
			),
		]);
		const unexpectedChangedFiles = changedFilesAfterCodex.filter(
			(file) => !allowedChangedFiles.includes(file),
		);

		if (codex.exitCode !== 0 || remainingConflictingFiles.length > 0) {
			emit({
				ok: false,
				outcome: "integration_repair_conflict_unresolved",
				error:
					codex.error ||
					(codex.timedOut
						? "Codex timed out while resolving merge conflicts."
						: "Merge conflicts remain after conflict resolution attempt."),
				conflictingFiles,
				remainingConflictingFiles,
				codex: summarizeCommand(codex),
			});
			return;
		}

		if (unexpectedChangedFiles.length > 0) {
			emit({
				ok: false,
				outcome: "integration_repair_conflict_unresolved",
				error: `Conflict resolver changed unexpected files: ${unexpectedChangedFiles.join(", ")}`,
				conflictingFiles,
				remainingConflictingFiles,
				unexpectedChangedFiles,
				codex: summarizeCommand(codex),
			});
			return;
		}

		const add = await runCommand("git", ["add", "-A"], repositoryPath);
		if (add.exitCode !== 0) {
			emit({
				ok: false,
				outcome: "integration_repair_failed",
				error: `Could not stage resolved merge: ${add.stderr || add.stdout}`,
				conflictingFiles,
				codex: summarizeCommand(codex),
			});
			return;
		}

		const commit = await runCommand(
			"git",
			["commit", "--no-edit"],
			repositoryPath,
		);
		if (commit.exitCode !== 0) {
			emit({
				ok: false,
				outcome: "integration_repair_conflict_unresolved",
				error: `Could not commit resolved merge: ${commit.stderr || commit.stdout}`,
				conflictingFiles,
				codex: summarizeCommand(codex),
			});
			return;
		}

		const headAfter = await runCommand(
			"git",
			["rev-parse", "HEAD"],
			repositoryPath,
		);
		const currentHeadSha = headAfter.stdout.trim().split("\n")[0] || "";
		const push = await runCommand(
			"git",
			["push", "origin", `HEAD:refs/heads/${headRef}`],
			repositoryPath,
		);
		if (push.exitCode !== 0) {
			emit({
				ok: false,
				outcome: "integration_repair_failed",
				error: `Could not push resolved integration commit: ${push.stderr || push.stdout}`,
				conflictingFiles,
				codex: summarizeCommand(codex),
			});
			return;
		}

		const changedFiles = parseFileList(
			(
				await runCommand(
					"git",
					["show", "--pretty=", "--name-only", "HEAD"],
					repositoryPath,
				)
			).stdout,
		);

		emit({
			ok: true,
			outcome: "integration_repair_conflict_resolved",
			artifact: {
				sha: currentHeadSha,
				htmlUrl: `https://github.com/${owner}/${repository}/commit/${currentHeadSha}`,
				changedFiles,
			},
			conflictingFiles,
			codex: summarizeCommand(codex),
		});
	} catch (error) {
		emit({
			ok: false,
			outcome: "integration_repair_failed",
			error: error instanceof Error ? error.message : String(error),
		});
	}
})();
