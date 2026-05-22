#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
const { readFile } = require("node:fs/promises");
const { spawn } = require("node:child_process");

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

function runCommand(command, args, cwd) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});

		child.on("error", (error) => {
			reject(error);
		});

		child.on("close", (code) => {
			resolve({
				command,
				args,
				exitCode: code,
				stdout,
				stderr,
			});
		});
	});
}

async function detectFormatterCommand(packageManager) {
	try {
		const pkgRaw = await readFile("package.json", "utf8");
		const pkg = JSON.parse(pkgRaw);
		const scripts =
			typeof pkg.scripts === "object" && pkg.scripts !== null
				? pkg.scripts
				: null;
		if (scripts && typeof scripts.format === "string") {
			switch (packageManager) {
				case "pnpm":
					return ["pnpm", "run", "format"];
				case "yarn":
					return ["yarn", "format"];
				default:
					return ["npm", "run", "format"];
			}
		}
	} catch {
		// ignore
	}

	return ["npm", "run", "format"];
}

function detectInstallCommand(packageManager) {
	switch (packageManager) {
		case "pnpm":
			return ["pnpm", "install", "--frozen-lockfile"];
		case "yarn":
			return ["yarn", "install", "--frozen-lockfile"];
		default:
			return ["npm", "install", "--no-fund", "--no-audit"];
	}
}

async function detectPackageManager() {
	try {
		await readFile("pnpm-lock.yaml", "utf8");
		return "pnpm";
	} catch {
		// ignore
	}

	try {
		await readFile("yarn.lock", "utf8");
		return "yarn";
	} catch {
		// ignore
	}

	try {
		await readFile("package-lock.json", "utf8");
		return "npm";
	} catch {
		// ignore
	}

	return "npm";
}

async function enableCorepackIfNeeded(packageManager, repositoryPath) {
	if (packageManager !== "pnpm" && packageManager !== "yarn") {
		return null;
	}

	const corepack = await runCommand("corepack", ["enable"], repositoryPath);
	if (corepack.exitCode !== 0) {
		return `Corepack enable failed: ${corepack.stderr || corepack.stdout}`;
	}

	return null;
}

function parseChangedFilesFromGitStatus(raw) {
	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => line.replace(/^[ MADRCU]+/, "").trim())
		.map((line) => line.split(/\s+->\s*/)[0] ?? line)
		.filter((line) => line.length > 0);
}

function isAllowedChangedFiles(expected, actual) {
	const expectedSet = new Set(
		expected.map((file) => file.trim()).filter(Boolean),
	);

	const unexpected = actual.filter((file) => !expectedSet.has(file));
	if (unexpected.length > 0) {
		return {
			ok: false,
			unexpected,
		};
	}

	return {
		ok: true,
		unexpected: [],
	};
}

function emitOutput(payload) {
	process.stdout.write(JSON.stringify(payload));
}

(async () => {
	const metadataPath = requiredEnv("RHAPSODY_METADATA_PATH");
	const metadata = await readJson(metadataPath);

	const repositoryPath =
		metadata.repositoryPath || "/vercel/sandbox/repository";
	const owner = metadata.owner;
	const repository = metadata.repository;
	const headRef = metadata.headRef;
	const allowedChangedFiles = Array.isArray(metadata.allowedChangedFiles)
		? metadata.allowedChangedFiles.filter(
				(file) => typeof file === "string" && file.trim().length > 0,
			)
		: [];

	if (typeof owner !== "string" || !owner) {
		emitOutput({
			ok: false,
			outcome: "repair_failed",
			error: "Missing owner in metadata.",
		});
		return;
	}

	if (typeof repository !== "string" || !repository) {
		emitOutput({
			ok: false,
			outcome: "repair_failed",
			error: "Missing repository in metadata.",
		});
		return;
	}

	if (typeof headRef !== "string" || !headRef) {
		emitOutput({
			ok: false,
			outcome: "repair_failed",
			error: "Missing head ref in metadata.",
		});
		return;
	}

	if (allowedChangedFiles.length === 0) {
		emitOutput({
			ok: false,
			outcome: "repair_failed",
			error: "No allowed changed files were provided for repair.",
		});
		return;
	}

	try {
		const cloneUrl = `https://github.com/${owner}/${repository}.git`;
		const clone = await runCommand(
			"git",
			["clone", cloneUrl, repositoryPath],
			"/vercel/sandbox",
		);
		if (clone.exitCode !== 0) {
			emitOutput({
				ok: false,
				outcome: "repair_failed",
				error: `Could not clone repository: ${clone.stderr || clone.stdout}`,
			});
			return;
		}

		const fetch = await runCommand(
			"git",
			["fetch", "origin", headRef],
			repositoryPath,
		);
		if (fetch.exitCode !== 0) {
			emitOutput({
				ok: false,
				outcome: "repair_failed",
				error: `Could not fetch head ref ${headRef}: ${fetch.stderr || fetch.stdout}`,
			});
			return;
		}

		const checkout = await runCommand(
			"git",
			["checkout", `origin/${headRef}`],
			repositoryPath,
		);
		if (checkout.exitCode !== 0) {
			emitOutput({
				ok: false,
				outcome: "repair_failed",
				error: `Could not checkout ${headRef}: ${checkout.stderr || checkout.stdout}`,
			});
			return;
		}

		const packageManager = await detectPackageManager();
		const corepackError = await enableCorepackIfNeeded(
			packageManager,
			repositoryPath,
		);
		if (corepackError) {
			emitOutput({
				ok: false,
				outcome: "repair_failed",
				error: corepackError,
			});
			return;
		}

		const installCommand = detectInstallCommand(packageManager);
		const install = await runCommand(
			installCommand[0],
			installCommand.slice(1),
			repositoryPath,
		);
		if (install.exitCode !== 0) {
			emitOutput({
				ok: false,
				outcome: "repair_failed",
				error: `Install failed: ${install.stderr || install.stdout}`,
			});
			return;
		}

		const formatter = await detectFormatterCommand(packageManager);
		const format = await runCommand(
			formatter[0],
			formatter.slice(1),
			repositoryPath,
		);
		if (format.exitCode !== 0) {
			emitOutput({
				ok: false,
				outcome: "repair_failed",
				error: `Formatter failed: ${format.stderr || format.stdout}`,
			});
			return;
		}

		const diff = await runCommand(
			"git",
			["status", "--porcelain"],
			repositoryPath,
		);
		const changedFiles = parseChangedFilesFromGitStatus(diff.stdout);

		const allowedCheck = isAllowedChangedFiles(
			allowedChangedFiles,
			changedFiles,
		);
		if (!allowedCheck.ok) {
			emitOutput({
				ok: false,
				outcome: "repair_failed",
				error: `Formatter changed unexpected files: ${allowedCheck.unexpected.join(", ")}`,
			});
			return;
		}

		if (changedFiles.length === 0) {
			emitOutput({
				ok: true,
				outcome: "repair_noop",
			});
			return;
		}

		const add = await runCommand(
			"git",
			["add", ...changedFiles],
			repositoryPath,
		);
		if (add.exitCode !== 0) {
			emitOutput({
				ok: false,
				outcome: "repair_failed",
				error: `Could not stage formatting changes: ${add.stderr || add.stdout}`,
			});
			return;
		}

		const gitUserName = await runCommand(
			"git",
			["config", "user.name", "Rhapsody Codex"],
			repositoryPath,
		);
		if (gitUserName.exitCode !== 0) {
			emitOutput({
				ok: false,
				outcome: "repair_failed",
				error: `Could not configure git user.name: ${gitUserName.stderr || gitUserName.stdout}`,
			});
			return;
		}

		const gitUserEmail = await runCommand(
			"git",
			["config", "user.email", "rhapsody-codex@localhost"],
			repositoryPath,
		);
		if (gitUserEmail.exitCode !== 0) {
			emitOutput({
				ok: false,
				outcome: "repair_failed",
				error: `Could not configure git user.email: ${gitUserEmail.stderr || gitUserEmail.stdout}`,
			});
			return;
		}

		const commit = await runCommand(
			"git",
			["commit", "-m", "chore: fix formatting"],
			repositoryPath,
		);
		if (commit.exitCode !== 0) {
			emitOutput({
				ok: false,
				outcome: "repair_failed",
				error: `Could not commit formatting changes: ${commit.stderr || commit.stdout}`,
			});
			return;
		}

		const headSha = (
			await runCommand("git", ["rev-parse", "HEAD"], repositoryPath)
		).stdout
			.trim()
			.split("\n")[0];

		const push = await runCommand(
			"git",
			["push", "origin", `HEAD:refs/heads/${headRef}`],
			repositoryPath,
		);
		if (push.exitCode !== 0) {
			emitOutput({
				ok: false,
				outcome: "repair_failed",
				error: `Could not push repair commit: ${push.stderr || push.stdout}`,
			});
			return;
		}

		emitOutput({
			ok: true,
			outcome: "repair_applied",
			artifact: {
				sha: headSha,
				htmlUrl: `https://github.com/${owner}/${repository}/commit/${headSha}`,
				changedFiles,
			},
		});
	} catch (error) {
		emitOutput({
			ok: false,
			outcome: "repair_failed",
			error: error instanceof Error ? error.message : String(error),
		});
	}
})();
