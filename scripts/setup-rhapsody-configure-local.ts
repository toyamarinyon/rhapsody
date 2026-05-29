import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

type Check = {
	name: string;
	ok: boolean;
	detail: string;
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
	files: {
		envLocalExists: boolean;
		envLocalIgnoredByGit: boolean | null;
		rhapsodyInstructionsExists: boolean;
		rhapsodyConfigTomlExists: boolean;
		rhapsodyConfigTsExists: boolean;
	};
	env: {
		generatedSecrets: {
			present: Record<string, boolean>;
			missingGeneratedSecrets: string[];
		};
		externalInputs: {
			present: Record<string, boolean>;
			missingExternalInputs: string[];
		};
	};
};

type PlannedChange = {
	kind: string;
	target: string;
	action: string;
	reason: string;
	requiresUserConfirmation: boolean;
	wouldWrite: boolean;
};

type Report = {
	ok: boolean;
	mode: "dry-run";
	phase: "configure-local";
	facts: Facts;
	checks: Check[];
	plannedChanges: PlannedChange[];
	needsUser: string[];
	blocked: string[];
	nextActions: string[];
};

const GENERATED_SECRET_KEYS = [
	"ROOT_PASSWORD",
	"AUTH_SECRET",
	"CRON_SECRET",
	"MEDIATOR_SECRET",
] as const;

const EXTERNAL_INPUT_KEYS = [
	"TURSO_DATABASE_URL",
	"TURSO_AUTH_TOKEN",
	"GITHUB_TOKEN",
	"VERCEL_TOKEN",
	"VERCEL_TEAM_ID",
	"VERCEL_PROJECT_ID",
	"INITIAL_CHATGPT_AUTH_JSON",
] as const;

function run(command: string, args: string[]) {
	return spawnSync(command, args, { encoding: "utf8" });
}

function parseMode(argv: string[]) {
	const flags = argv.slice(2).filter((flag) => flag !== "--");
	if (flags.length === 0) {
		return "dry-run" as const;
	}

	if (flags.length === 1 && flags[0] === "--dry-run") {
		return "dry-run" as const;
	}

	return null;
}

function readGitRemote() {
	const remote = run("git", ["remote", "get-url", "origin"]);
	if (remote.status !== 0) {
		return null;
	}

	const rawUrl = remote.stdout.trim();
	const httpsMatch = rawUrl.match(
		/^https:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
	);
	const sshMatch = rawUrl.match(
		/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/,
	);
	const match = httpsMatch ?? sshMatch;

	if (!match) {
		return { url: redactGitRemoteUrl(rawUrl), owner: null, repository: null };
	}

	return {
		url: redactGitRemoteUrl(rawUrl),
		owner: match[1] ?? null,
		repository: match[2] ?? null,
	};
}

function readGitBranch() {
	const branch = run("git", ["branch", "--show-current"]);
	return branch.status === 0 ? branch.stdout.trim() || null : null;
}

function isIgnoredByGit(filePath: string) {
	const result = run("git", ["check-ignore", "-q", "--", filePath]);
	if (result.status === 0) {
		return true;
	}

	if (result.status === 1) {
		return false;
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

function parseEnvFile(filePath: string) {
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

function readEnvPresence(keys: readonly string[], envLocalKeys: Set<string>) {
	const present: Record<string, boolean> = {};
	const missing: string[] = [];

	for (const key of keys) {
		const isPresent =
			Boolean(process.env[key]?.trim()) || envLocalKeys.has(key);
		present[key] = isPresent;
		if (!isPresent) {
			missing.push(key);
		}
	}

	return { present, missing };
}

function main() {
	const mode = parseMode(process.argv);
	if (!mode) {
		process.stdout.write(
			JSON.stringify(
				{
					ok: false,
					mode: "dry-run",
					phase: "configure-local",
					error:
						"Unsupported arguments. This helper currently supports only dry-run mode.",
				},
				null,
				2,
			),
		);
		process.exitCode = 1;
		return;
	}

	const remote = readGitRemote();
	const branch = readGitBranch();
	const envLocalPath = path.join(process.cwd(), ".env.local");
	const envLocalExists = existsSync(envLocalPath);
	const envLocalIgnoredByGit = envLocalExists
		? isIgnoredByGit(".env.local")
		: null;
	const envLocalKeys = parseEnvFile(envLocalPath);

	const generatedSecretsPresence = readEnvPresence(
		GENERATED_SECRET_KEYS,
		envLocalKeys,
	);
	const externalInputsPresence = readEnvPresence(
		EXTERNAL_INPUT_KEYS,
		envLocalKeys,
	);

	const files = {
		envLocalExists,
		envLocalIgnoredByGit,
		rhapsodyInstructionsExists: existsSync(
			path.join(process.cwd(), ".rhapsody/INSTRUCTIONS.md"),
		),
		rhapsodyConfigTomlExists: existsSync(
			path.join(process.cwd(), ".rhapsody/config.toml"),
		),
		rhapsodyConfigTsExists: existsSync(
			path.join(process.cwd(), "rhapsody.config.ts"),
		),
	};

	const blocked: string[] = [];
	if (envLocalExists && envLocalIgnoredByGit === false) {
		blocked.push(
			".env.local is not ignored by git, so future write steps must not create or modify it until ignore rules are fixed.",
		);
	}
	if (!remote?.owner || !remote.repository) {
		blocked.push(
			"GitHub repository owner and repository name could not be inferred from origin remote.",
		);
	}

	const needsUser = externalInputsPresence.missing.map(
		(key) => `Provide ${key} in process env or .env.local.`,
	);
	if (!remote?.owner || !remote.repository) {
		needsUser.push(
			"Confirm the GitHub owner/repository if the remote is not a GitHub origin.",
		);
	}

	const checks: Check[] = [
		{
			name: "git-branch",
			ok: Boolean(branch),
			detail: branch ?? "current branch unavailable",
		},
		{
			name: "git-remote",
			ok: Boolean(remote?.owner && remote?.repository),
			detail: remote
				? remote.owner && remote.repository
					? `${remote.owner}/${remote.repository} (${remote.url})`
					: `unrecognized remote: ${remote.url}`
				: "origin remote unavailable",
		},
		{
			name: "env.local",
			ok: !envLocalExists || envLocalIgnoredByGit !== false,
			detail: envLocalExists
				? envLocalIgnoredByGit === true
					? ".env.local is ignored by git"
					: envLocalIgnoredByGit === false
						? ".env.local is not ignored by git"
						: "git ignore status unavailable"
				: ".env.local is missing",
		},
		{
			name: "rhapsody.instructions",
			ok: files.rhapsodyInstructionsExists,
			detail: files.rhapsodyInstructionsExists ? "present" : "missing",
		},
		{
			name: "rhapsody.config.toml",
			ok: files.rhapsodyConfigTomlExists,
			detail: files.rhapsodyConfigTomlExists ? "present" : "missing",
		},
		{
			name: "rhapsody.config.ts",
			ok: files.rhapsodyConfigTsExists,
			detail: files.rhapsodyConfigTsExists ? "present" : "missing",
		},
		{
			name: "generated-secrets",
			ok: generatedSecretsPresence.missing.length === 0,
			detail:
				generatedSecretsPresence.missing.length === 0
					? "all generated secrets present"
					: `missing generated secrets: ${generatedSecretsPresence.missing.join(", ")}`,
		},
		{
			name: "external-inputs",
			ok: externalInputsPresence.missing.length === 0,
			detail:
				externalInputsPresence.missing.length === 0
					? "all external inputs present"
					: `missing external inputs: ${externalInputsPresence.missing.join(", ")}`,
		},
	];

	const pendingGeneratedSecrets = generatedSecretsPresence.missing;
	const pendingRepositoryFiles = [
		!files.rhapsodyInstructionsExists ? ".rhapsody/INSTRUCTIONS.md" : null,
		!files.rhapsodyConfigTomlExists ? ".rhapsody/config.toml" : null,
	].filter((item): item is string => Boolean(item));

	const plannedChanges: PlannedChange[] = [
		...(pendingGeneratedSecrets.length > 0
			? [
					{
						kind: "secret-generation",
						target: "local-secret-values",
						action: `Generate candidate local secret values for: ${pendingGeneratedSecrets.join(", ")}.`,
						reason:
							"Generated local secrets can be prepared in memory before any .env.local write is confirmed.",
						requiresUserConfirmation: false,
						wouldWrite: false,
					},
				]
			: []),
		...(pendingRepositoryFiles.includes(".rhapsody/INSTRUCTIONS.md")
			? [
					{
						kind: "repository-file",
						target: ".rhapsody/INSTRUCTIONS.md",
						action:
							"Create the repository-owned instruction file if it remains absent.",
						reason:
							"Rhapsody cannot render repository workflow instructions without this file.",
						requiresUserConfirmation: false,
						wouldWrite: true,
					},
				]
			: [
					{
						kind: "repository-file",
						target: ".rhapsody/INSTRUCTIONS.md",
						action:
							"Preserve and verify the existing repository-owned instruction file.",
						reason:
							"An existing instruction file should be kept unless the operator chooses to edit it.",
						requiresUserConfirmation: false,
						wouldWrite: false,
					},
				]),
		...(pendingRepositoryFiles.includes(".rhapsody/config.toml")
			? [
					{
						kind: "repository-file",
						target: ".rhapsody/config.toml",
						action:
							"Create the repository-owned policy file if it remains absent.",
						reason:
							"Repository policy defaults need a tracked policy file when none exists.",
						requiresUserConfirmation: false,
						wouldWrite: true,
					},
				]
			: [
					{
						kind: "repository-file",
						target: ".rhapsody/config.toml",
						action:
							"Preserve and verify the existing repository-owned policy file.",
						reason:
							"An existing policy file should be kept unless the operator chooses to edit it.",
						requiresUserConfirmation: false,
						wouldWrite: false,
					},
				]),
		{
			kind: "config-update",
			target: "rhapsody.config.ts",
			action:
				"Update the scheduler boundary from the inferred GitHub repository and ProjectV2 settings.",
			reason:
				"The deployment configuration must point at the intended repository and board.",
			requiresUserConfirmation: true,
			wouldWrite: true,
		},
		...(envLocalExists && envLocalIgnoredByGit === true
			? [
					{
						kind: "env-file",
						target: ".env.local",
						action:
							pendingGeneratedSecrets.length > 0
								? `Update only the missing generated secrets in .env.local: ${pendingGeneratedSecrets.join(", ")}.`
								: "Preserve .env.local without writing new values.",
						reason:
							"Local env files must stay untracked; any .env.local update requires confirmation and only writes missing generated secrets.",
						requiresUserConfirmation: true,
						wouldWrite: pendingGeneratedSecrets.length > 0,
					},
				]
			: []),
	];

	const ok = blocked.length === 0;

	const report: Report = {
		ok,
		mode,
		phase: "configure-local",
		facts: {
			git: {
				branch,
				remote,
			},
			files,
			env: {
				generatedSecrets: {
					present: generatedSecretsPresence.present,
					missingGeneratedSecrets: generatedSecretsPresence.missing,
				},
				externalInputs: {
					present: externalInputsPresence.present,
					missingExternalInputs: externalInputsPresence.missing,
				},
			},
		},
		checks,
		plannedChanges,
		needsUser,
		blocked,
		nextActions: [
			...(blocked.length > 0
				? ["Resolve blocked items before any write step."]
				: []),
			...(needsUser.length > 0
				? ["Provide the missing external inputs before remote configuration."]
				: ["Proceed to configure-remotes when the operator is ready."]),
		],
	};

	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	process.exitCode = 0;
}

main();
