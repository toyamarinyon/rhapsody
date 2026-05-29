import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

type Check = {
	name: string;
	ok: boolean;
	detail: string;
};

type PlannedChange = {
	kind: string;
	target: string;
	action: string;
	reason: string;
	requiresUserConfirmation: boolean;
	wouldWrite: boolean;
};

type Facts = {
	git: {
		branch: string | null;
		remote: {
			url: string | null;
			owner: string | null;
			repository: string | null;
		} | null;
	};
	cli: {
		gh: {
			available: boolean;
			version: string | null;
		};
		auth: {
			ok: boolean;
			summary: string;
		};
	};
	repo: {
		accessible: boolean;
		nameWithOwner: string | null;
		url: string | null;
		defaultBranch: string | null;
	};
	localConfig: {
		rhapsodyConfigTsExists: boolean;
		rhapsodyConfigTomlExists: boolean;
		projectTarget: {
			kind: string | null;
			owner: string | null;
			repository: string | null;
			projectNumber: number | string | null;
			statusField: string | null;
			activeStatuses: string[];
			terminalStatuses: string[];
		};
	};
	project: {
		identified: boolean;
		summary: string;
		listingAvailable: boolean;
		listingSummary: string | null;
	};
};

type Report = {
	ok: boolean;
	mode: "dry-run";
	phase: "configure-github";
	error?: string;
	facts: Facts;
	checks: Check[];
	plannedChanges: PlannedChange[];
	needsUser: string[];
	blocked: string[];
	nextActions: string[];
};

function run(command: string, args: string[], timeout = 12_000) {
	return spawnSync(command, args, {
		encoding: "utf8",
		timeout,
	});
}

function emitJSON(report: Report, exitCode = 0) {
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	process.exitCode = exitCode;
}

function unsupportedArgsError() {
	emitJSON(
		{
			ok: false,
			mode: "dry-run",
			phase: "configure-github",
			error:
				"Unsupported arguments. This helper supports no args or --dry-run.",
			facts: {
				git: {
					branch: null,
					remote: null,
				},
				cli: {
					gh: {
						available: false,
						version: null,
					},
					auth: {
						ok: false,
						summary: "unsupported arguments",
					},
				},
				repo: {
					accessible: false,
					nameWithOwner: null,
					url: null,
					defaultBranch: null,
				},
				localConfig: {
					rhapsodyConfigTsExists: false,
					rhapsodyConfigTomlExists: false,
					projectTarget: {
						kind: null,
						owner: null,
						repository: null,
						projectNumber: null,
						statusField: null,
						activeStatuses: [],
						terminalStatuses: [],
					},
				},
				project: {
					identified: false,
					summary: "unsupported arguments",
					listingAvailable: false,
					listingSummary: null,
				},
			},
			checks: [],
			plannedChanges: [],
			needsUser: [],
			blocked: [],
			nextActions: [],
		},
		1,
	);
}

function parseMode(argv: string[]) {
	const flags = argv.slice(2);

	if (flags.length === 0) {
		return "dry-run" as const;
	}

	if (
		(flags.length === 1 && flags[0] === "--dry-run") ||
		(flags.length === 2 && flags[0] === "--" && flags[1] === "--dry-run")
	) {
		return "dry-run" as const;
	}

	return null;
}

function redactGitRemoteUrl(remoteUrl: string | null) {
	if (!remoteUrl) {
		return null;
	}

	const redactedCredentialUrl = remoteUrl.replace(
		/^https:\/\/([^/@]+(?::[^/@]*)?)@github\.com\//,
		"https://<redacted>@github.com/",
	);

	if (redactedCredentialUrl.startsWith("https://github.com/")) {
		return "https://github.com/<redacted>/<redacted>.git";
	}

	if (redactedCredentialUrl.startsWith("git@github.com:")) {
		return "git@github.com:<redacted>/<redacted>.git";
	}

	return redactedCredentialUrl;
}

function readGitRemote() {
	const result = run("git", ["remote", "get-url", "origin"]);
	if (result.status !== 0) {
		return null;
	}

	const rawUrl = result.stdout.trim();
	const httpsMatch = rawUrl.match(
		/^https:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
	);
	const sshMatch = rawUrl.match(
		/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/,
	);
	const match = httpsMatch ?? sshMatch;

	if (!match) {
		return {
			url: redactGitRemoteUrl(rawUrl),
			owner: null,
			repository: null,
		};
	}

	return {
		url: redactGitRemoteUrl(rawUrl),
		owner: match[1] ?? null,
		repository: match[2] ?? null,
	};
}

function readGitBranch() {
	const result = run("git", ["branch", "--show-current"]);
	return result.status === 0 ? result.stdout.trim() || null : null;
}

function checkCommandAvailability(
	command: string,
	args: string[] = ["--version"],
) {
	const result = run(command, args);
	return {
		available: result.status === 0,
		version:
			result.status === 0
				? ((result.stdout || result.stderr).trim().split("\n")[0] ?? null)
				: null,
		error:
			result.status === 0
				? null
				: (
						result.stderr ||
						result.stdout ||
						result.error?.message ||
						`exit ${result.status}`
					).trim(),
	};
}

function summarizeAuthResult(result: ReturnType<typeof run>) {
	if (result.error) {
		return result.error.message;
	}

	if (result.status === 0) {
		return "authenticated";
	}

	const output = (result.stderr || result.stdout || "").trim();
	if (!output) {
		return `unauthenticated (exit ${result.status})`;
	}

	const firstLine = output.split("\n")[0] ?? output;
	if (firstLine === "github.com") {
		return "unauthenticated (github.com)";
	}

	return firstLine;
}

function readLocalConfigHints() {
	const projectTarget = {
		kind: null as string | null,
		owner: null as string | null,
		repository: null as string | null,
		projectNumber: null as number | string | null,
		statusField: null as string | null,
		activeStatuses: [] as string[],
		terminalStatuses: [] as string[],
	};
	const rhapsodyConfigTsPath = path.join(process.cwd(), "rhapsody.config.ts");
	const rhapsodyConfigTomlPath = path.join(
		process.cwd(),
		".rhapsody/config.toml",
	);
	const tsExists = existsSync(rhapsodyConfigTsPath);
	const tomlExists = existsSync(rhapsodyConfigTomlPath);

	if (tsExists) {
		const content = readFileSync(rhapsodyConfigTsPath, "utf8");
		const kindMatch = content.match(
			/tracker\s*:\s*\{[\s\S]*?kind\s*:\s*["'`]([^"'`]+)["'`]/,
		);
		if (kindMatch?.[1]) {
			projectTarget.kind = kindMatch[1];
		}

		const ownerMatch = content.match(
			/tracker\s*:\s*\{[\s\S]*?owner\s*:\s*["'`]([^"'`]+)["'`]/,
		);
		if (ownerMatch?.[1]) {
			projectTarget.owner = ownerMatch[1];
		}

		const repositoryMatch = content.match(
			/tracker\s*:\s*\{[\s\S]*?repository\s*:\s*["'`]([^"'`]+)["'`]/,
		);
		if (repositoryMatch?.[1]) {
			projectTarget.repository = repositoryMatch[1];
		}

		const projectNumberMatch = content.match(
			/tracker\s*:\s*\{[\s\S]*?projectNumber\s*:\s*(["'`]?)(\d+)\1/,
		);
		if (projectNumberMatch?.[2]) {
			projectTarget.projectNumber = Number(projectNumberMatch[2]);
		}

		const statusFieldMatch = content.match(
			/tracker\s*:\s*\{[\s\S]*?statusField\s*:\s*["'`]([^"'`]+)["'`]/,
		);
		if (statusFieldMatch?.[1]) {
			projectTarget.statusField = statusFieldMatch[1];
		}

		const activeStatusesMatch = content.match(
			/tracker\s*:\s*\{[\s\S]*?activeStatuses\s*:\s*\[([\s\S]*?)\]/,
		);
		if (activeStatusesMatch?.[1]) {
			projectTarget.activeStatuses = Array.from(
				activeStatusesMatch[1].matchAll(/["'`]([^"'`]+)["'`]/g),
				(match) => match[1] ?? "",
			).filter(Boolean);
		}

		const terminalStatusesMatch = content.match(
			/tracker\s*:\s*\{[\s\S]*?terminalStatuses\s*:\s*\[([\s\S]*?)\]/,
		);
		if (terminalStatusesMatch?.[1]) {
			projectTarget.terminalStatuses = Array.from(
				terminalStatusesMatch[1].matchAll(/["'`]([^"'`]+)["'`]/g),
				(match) => match[1] ?? "",
			).filter(Boolean);
		}
	}

	return {
		rhapsodyConfigTsExists: tsExists,
		rhapsodyConfigTomlExists: tomlExists,
		projectTarget,
	};
}

function checkGhAuth() {
	const result = run("gh", ["auth", "status"], 12_000);
	return {
		ok: result.status === 0,
		summary: summarizeAuthResult(result),
	};
}

function readRepoView(owner: string, repository: string) {
	const result = run("gh", [
		"repo",
		"view",
		`${owner}/${repository}`,
		"--json",
		"nameWithOwner,defaultBranchRef,url",
	]);

	if (result.status !== 0) {
		return {
			accessible: false,
			nameWithOwner: null,
			url: null,
			defaultBranch: null,
			error: summarizeAuthResult(result),
		};
	}

	try {
		const parsed = JSON.parse(result.stdout) as {
			nameWithOwner?: string;
			defaultBranchRef?: { name?: string | null } | null;
			url?: string;
		};

		return {
			accessible: true,
			nameWithOwner: parsed.nameWithOwner ?? `${owner}/${repository}`,
			url: parsed.url ?? null,
			defaultBranch: parsed.defaultBranchRef?.name ?? null,
			error: null,
		};
	} catch (error) {
		return {
			accessible: false,
			nameWithOwner: null,
			url: null,
			defaultBranch: null,
			error:
				error instanceof Error
					? error.message
					: "invalid JSON from gh repo view",
		};
	}
}

function readProjectListing(owner: string) {
	const result = run("gh", [
		"project",
		"list",
		"--owner",
		owner,
		"--format",
		"json",
	]);

	if (result.status !== 0) {
		return {
			available: false,
			summary: summarizeAuthResult(result),
		};
	}

	try {
		const parsed = JSON.parse(result.stdout) as
			| Array<{
					title?: string;
					number?: number;
					url?: string;
			  }>
			| {
					projects?: Array<{
						title?: string;
						number?: number;
						url?: string;
					}>;
			  };
		const projects = Array.isArray(parsed) ? parsed : (parsed.projects ?? []);

		return {
			available: true,
			summary:
				projects.length > 0
					? `found ${projects.length} project(s) for ${owner}`
					: `no projects listed for ${owner}`,
		};
	} catch (error) {
		return {
			available: false,
			summary:
				error instanceof Error
					? error.message
					: "invalid JSON from gh project list",
		};
	}
}

function main() {
	const mode = parseMode(process.argv);
	if (!mode) {
		unsupportedArgsError();
		return;
	}

	const remote = readGitRemote();
	const branch = readGitBranch();
	const ghAvailability = checkCommandAvailability("gh");
	const ghAuth = ghAvailability.available
		? checkGhAuth()
		: {
				ok: false,
				summary: "gh is not available",
			};
	const localConfig = readLocalConfigHints();

	const repoView =
		remote?.owner && remote.repository && ghAvailability.available && ghAuth.ok
			? readRepoView(remote.owner, remote.repository)
			: {
					accessible: false,
					nameWithOwner: null,
					url: null,
					defaultBranch: null,
					error: !ghAvailability.available
						? "gh is not available"
						: !ghAuth.ok
							? "gh authentication required"
							: !remote?.owner || !remote.repository
								? "repository could not be inferred from origin remote"
								: null,
				};

	const projectListing =
		remote?.owner && ghAvailability.available && ghAuth.ok
			? readProjectListing(remote.owner)
			: {
					available: false,
					summary: !ghAvailability.available
						? "gh is not available"
						: !ghAuth.ok
							? "gh authentication required"
							: !remote?.owner
								? "repository owner could not be inferred"
								: "project listing unavailable",
				};

	const projectIdentified =
		localConfig.projectTarget.kind === "github_project" &&
		typeof localConfig.projectTarget.projectNumber === "number";
	const checks: Check[] = [
		{
			name: "gh-cli",
			ok: ghAvailability.available,
			detail: ghAvailability.available
				? `gh available${ghAvailability.version ? ` (${ghAvailability.version})` : ""}`
				: (ghAvailability.error ?? "gh unavailable"),
		},
		{
			name: "gh-auth",
			ok: ghAuth.ok,
			detail: ghAuth.summary,
		},
		{
			name: "git-remote",
			ok: Boolean(remote?.owner && remote.repository),
			detail: remote
				? remote.owner && remote.repository
					? `${remote.owner}/${remote.repository} (${remote.url})`
					: `unrecognized remote: ${remote.url}`
				: "origin remote unavailable",
		},
		{
			name: "repo-access",
			ok: repoView.accessible,
			detail: repoView.accessible
				? `${repoView.nameWithOwner} (${repoView.url})`
				: (repoView.error ?? "repository view unavailable"),
		},
		{
			name: "local-config-rhapsody.config.ts",
			ok: localConfig.rhapsodyConfigTsExists,
			detail: localConfig.rhapsodyConfigTsExists ? "present" : "missing",
		},
		{
			name: "local-config-.rhapsody/config.toml",
			ok: localConfig.rhapsodyConfigTomlExists,
			detail: localConfig.rhapsodyConfigTomlExists ? "present" : "missing",
		},
		{
			name: "project-config-identified",
			ok: projectIdentified,
			detail: projectIdentified
				? `github_project #${localConfig.projectTarget.projectNumber}`
				: localConfig.projectTarget.kind === "github_project"
					? "github_project target present but project number could not be inferred"
					: "project id/number could not be inferred from local config",
		},
		{
			name: "project-listing",
			ok: projectListing.available,
			detail: projectListing.summary,
		},
	];

	const needsUser: string[] = [];
	const blocked: string[] = [];

	if (!remote?.owner || !remote.repository) {
		needsUser.push(
			"Confirm the GitHub repository owner and name, or fix the origin remote so it can be inferred.",
		);
	}

	if (!ghAvailability.available) {
		blocked.push("gh CLI is not available.");
	} else if (!ghAuth.ok) {
		blocked.push("gh auth status failed.");
	}

	if (
		ghAvailability.available &&
		ghAuth.ok &&
		remote?.owner &&
		remote.repository &&
		!repoView.accessible
	) {
		blocked.push("gh repo view could not read the repository.");
	}

	if (!projectIdentified) {
		if (localConfig.projectTarget.kind === "github_project") {
			needsUser.push(
				"Provide the GitHub ProjectV2 identifier or project selection in local config before an apply phase.",
			);
		} else {
			needsUser.push(
				"Set tracker.kind to github_project and provide the GitHub ProjectV2 number in local config before an apply phase.",
			);
		}
	}

	if (
		ghAvailability.available &&
		ghAuth.ok &&
		remote?.owner &&
		!projectListing.available
	) {
		blocked.push("gh project list could not read the owner project list.");
	}

	const plannedChanges: PlannedChange[] = [
		{
			kind: "project-bootstrap",
			target: "GitHub ProjectV2",
			action:
				"Inspect or prepare the repository's ProjectV2 configuration before any creation or mutation step.",
			reason:
				"This dry-run helper is read-only and exists to decide whether an apply phase can safely proceed.",
			requiresUserConfirmation: true,
			wouldWrite: false,
		},
		{
			kind: "config-resolution",
			target: "local config hints",
			action:
				"Use rhapsody.config.ts and .rhapsody/config.toml hints to resolve the intended project identity.",
			reason:
				"GitHub Project setup should only advance once the intended board is known.",
			requiresUserConfirmation: false,
			wouldWrite: false,
		},
	];

	const nextActions: string[] = [];
	if (blocked.length > 0) {
		nextActions.push(
			"Resolve the blocked CLI or auth issue, then rerun `pnpm setup:configure-github -- --dry-run`.",
		);
	}
	if (needsUser.length > 0) {
		nextActions.push(
			"Provide the GitHub ProjectV2 identifier or update the local config so the target board can be identified.",
		);
	}
	if (blocked.length === 0 && needsUser.length === 0) {
		nextActions.push(
			"Proceed to the apply phase only after presenting a redacted ProjectV2 plan.",
		);
	}

	const report: Report = {
		ok: blocked.length === 0,
		mode: "dry-run",
		phase: "configure-github",
		facts: {
			git: {
				branch,
				remote,
			},
			cli: {
				gh: {
					available: ghAvailability.available,
					version: ghAvailability.version,
				},
				auth: ghAuth,
			},
			repo: {
				accessible: repoView.accessible,
				nameWithOwner: repoView.nameWithOwner,
				url: repoView.url,
				defaultBranch: repoView.defaultBranch,
			},
			localConfig,
			project: {
				identified: projectIdentified,
				summary: projectIdentified
					? `github_project #${localConfig.projectTarget.projectNumber}`
					: "project id/number could not be inferred from local config",
				listingAvailable: projectListing.available,
				listingSummary: projectListing.available
					? projectListing.summary
					: null,
			},
		},
		checks,
		plannedChanges,
		needsUser,
		blocked,
		nextActions,
	};

	emitJSON(report, report.ok ? 0 : 1);
}

main();
