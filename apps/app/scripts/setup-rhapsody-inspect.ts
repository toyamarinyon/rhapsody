import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

type CommandCheck = {
	name: string;
	available: boolean;
	version?: string;
	error?: string;
};

type AuthCheck = {
	name: string;
	ok: boolean;
	detail: string;
};

function run(command: string, args: string[], timeout = 10_000) {
	return spawnSync(command, args, {
		encoding: "utf8",
		timeout,
	});
}

function summarizeCommandFailure(
	error: Error | null,
	command: string,
	args: string[],
	timeoutMs: number,
) {
	const errnoError = error as NodeJS.ErrnoException | null;

	if (errnoError?.code === "ETIMEDOUT") {
		const invokedCommand = `${command} ${args.join(" ")}`.trim();
		return `${invokedCommand} timed out after ${timeoutMs}ms; rerun when the CLI is responsive`;
	}

	return errnoError?.message ?? "Command execution failed";
}

export function summarizeAuthResult(
	result: ReturnType<typeof run>,
	command: string,
	timeoutMs: number,
) {
	const errnoError = result.error as NodeJS.ErrnoException | null;

	if (result.error) {
		if (errnoError?.code === "ETIMEDOUT") {
			return `${command} timed out after ${timeoutMs}ms; run ${
				command.startsWith("vercel") ? "vercel login" : "gh auth login"
			} or rerun when the CLI is responsive`;
		}
		return errnoError?.message ?? "Authentication check failed";
	}

	const output = (result.stderr || result.stdout || "").trim();

	if (!output) {
		return result.status === 0 ? "authenticated" : `exit ${result.status}`;
	}

	const lines = output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (result.status !== 0) {
		const diagnostic = lines.find(
			(line) => !/^[\w.-]+$/.test(line) || line.includes(" "),
		);
		return diagnostic ?? lines[0] ?? output;
	}

	return lines[0] ?? output;
}

function checkCommand(
	name: string,
	args: string[] = ["--version"],
	timeout = 10_000,
): CommandCheck {
	const result = run(name, args, timeout);

	if (result.error) {
		return {
			name,
			available: false,
			error: summarizeCommandFailure(result.error, name, args, timeout),
		};
	}

	if (result.status !== 0) {
		return {
			name,
			available: false,
			error: (result.stderr || result.stdout || `exit ${result.status}`).trim(),
		};
	}

	return {
		name,
		available: true,
		version: (result.stdout || result.stderr).trim().split("\n")[0],
	};
}

function checkGitHubAuth(): AuthCheck {
	const result = run("gh", ["auth", "status"], 10_000);

	return {
		name: "github",
		ok: result.status === 0,
		detail: summarizeAuthResult(result, "gh auth status", 10_000),
	};
}

function parseEnvFileKeys(filePath: string) {
	if (!existsSync(filePath)) {
		return new Set<string>();
	}

	const keys = new Set<string>();
	for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) {
			continue;
		}

		const entry = line.startsWith("export ") ? line.slice(7).trim() : line;
		const equalsIndex = entry.indexOf("=");
		if (equalsIndex <= 0) {
			continue;
		}

		const key = entry.slice(0, equalsIndex).trim();
		if (key) {
			keys.add(key);
		}
	}

	return keys;
}

function hasEnvKey(key: string, envLocalKeys: ReadonlySet<string>) {
	return Boolean(process.env[key]?.trim()) || envLocalKeys.has(key);
}

function checkGitHubAuthWithToken(
	envLocalKeys: ReadonlySet<string>,
): AuthCheck {
	if (hasEnvKey("GITHUB_TOKEN", envLocalKeys)) {
		const result = run("gh", ["api", "user", "--jq", ".login"], 10_000);
		return {
			name: "github",
			ok: result.status === 0,
			detail:
				result.status === 0
					? "GITHUB_TOKEN valid"
					: summarizeAuthResult(result, "gh api user", 10_000),
		};
	}

	return checkGitHubAuth();
}

function checkVercelAuth(envLocalKeys: ReadonlySet<string>): AuthCheck {
	if (hasEnvKey("VERCEL_TOKEN", envLocalKeys)) {
		return {
			name: "vercel",
			ok: true,
			detail: "VERCEL_TOKEN present",
		};
	}

	const result = run("vercel", ["whoami"], 10_000);

	return {
		name: "vercel",
		ok: result.status === 0,
		detail: summarizeAuthResult(result, "vercel whoami", 10_000),
	};
}

function readGitContext() {
	const remote = run("git", ["remote", "get-url", "origin"]);
	const branch = run("git", ["branch", "--show-current"]);

	const remoteUrl = remote.status === 0 ? remote.stdout.trim() : null;
	const currentBranch = branch.status === 0 ? branch.stdout.trim() : null;

	return {
		remoteUrl: redactGitRemoteUrl(remoteUrl),
		currentBranch,
		repository: parseGitHubRepository(remoteUrl),
	};
}

function parseGitHubRepository(remoteUrl: string | null) {
	if (!remoteUrl) {
		return null;
	}

	const redactedRemoteUrl = redactGitRemoteUrl(remoteUrl);
	const httpsMatch = remoteUrl.match(
		/^https:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?$/,
	);
	const sshMatch = remoteUrl.match(
		/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/,
	);
	const match = httpsMatch ?? sshMatch;

	if (!match) {
		return {
			owner: null,
			name: null,
			parseError: `Unsupported GitHub remote format: ${redactedRemoteUrl}`,
		};
	}

	return {
		owner: match[1],
		name: match[2],
	};
}

function redactGitRemoteUrl(remoteUrl: string | null) {
	if (!remoteUrl) {
		return null;
	}

	return remoteUrl.replace(
		/^https:\/\/([^/@]+(?::[^/@]*)?)@github\.com\//,
		"https://<redacted>@github.com/",
	);
}

function buildNeedsUser(args: { commands: CommandCheck[]; auth: AuthCheck[] }) {
	const needsUser: string[] = [];
	if (!args.commands.find((command) => command.name === "gh")?.available) {
		needsUser.push(
			"Install the GitHub CLI (`gh`) before GitHub Project setup.",
		);
	}
	if (!args.commands.find((command) => command.name === "vercel")?.available) {
		needsUser.push(
			"Install the Vercel CLI or provide VERCEL_TOKEN before deploy setup.",
		);
	}
	if (!args.auth.find((item) => item.name === "github")?.ok) {
		needsUser.push(
			"Refresh or replace GITHUB_TOKEN/GH_TOKEN with repository and ProjectV2 access, or run `gh auth login`, then rerun `pnpm setup:inspect`.",
		);
	}
	if (!args.auth.find((item) => item.name === "vercel")?.ok) {
		needsUser.push(
			"Run `vercel login` or provide VERCEL_TOKEN in process env or .env.local, then rerun `pnpm setup:inspect`.",
		);
	}
	return needsUser;
}

function buildNextActions(args: { needsUser: string[] }) {
	if (args.needsUser.length > 0) {
		return args.needsUser;
	}

	return [
		"Proceed to configure-local, configure-github, and configure-deploy dry-runs.",
	];
}

function main() {
	const envLocalKeys = parseEnvFileKeys(path.join(process.cwd(), ".env.local"));
	const commands = [
		checkCommand("gh"),
		checkCommand("vercel", ["--version"]),
		checkCommand("pnpm", ["--version"]),
		checkCommand("node", ["--version"]),
	];

	const auth = [
		commands.find((command) => command.name === "gh")?.available
			? checkGitHubAuthWithToken(envLocalKeys)
			: { name: "github", ok: false, detail: "gh is not available" },
		commands.find((command) => command.name === "vercel")?.available
			? checkVercelAuth(envLocalKeys)
			: { name: "vercel", ok: false, detail: "vercel is not available" },
	];
	const needsUser = buildNeedsUser({ commands, auth });

	const report = {
		ok:
			commands.every((command) => command.available) &&
			auth.every((item) => item.ok),
		phase: "inspect",
		commands,
		auth,
		git: readGitContext(),
		needsUser,
		nextActions: buildNextActions({ needsUser }),
	};

	console.log(JSON.stringify(report, null, 2));

	if (!report.ok) {
		process.exitCode = 1;
	}
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
	main();
}
