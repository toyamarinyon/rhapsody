import { spawnSync } from "node:child_process";

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

function summarizeAuthResult(
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

	const output = (result.stdout || result.stderr || "").trim();

	if (!output) {
		return result.status === 0 ? "authenticated" : `exit ${result.status}`;
	}

	return output.split("\n")[0] ?? output;
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

function checkVercelAuth(): AuthCheck {
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

const commands = [
	checkCommand("gh"),
	checkCommand("vercel", ["--version"]),
	checkCommand("pnpm", ["--version"]),
	checkCommand("node", ["--version"]),
];

const auth = [
	commands.find((command) => command.name === "gh")?.available
		? checkGitHubAuth()
		: { name: "github", ok: false, detail: "gh is not available" },
	commands.find((command) => command.name === "vercel")?.available
		? checkVercelAuth()
		: { name: "vercel", ok: false, detail: "vercel is not available" },
];

const report = {
	ok:
		commands.every((command) => command.available) &&
		auth.every((item) => item.ok),
	commands,
	auth,
	git: readGitContext(),
};

console.log(JSON.stringify(report, null, 2));

if (!report.ok) {
	process.exitCode = 1;
}
