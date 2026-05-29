import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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

type AppliedChange = {
	key: string;
	target: string;
	action: string;
	wrote: boolean;
};

type Report = {
	ok: boolean;
	mode: "dry-run" | "apply";
	phase: "configure-local";
	facts: Facts;
	checks: Check[];
	plannedChanges: PlannedChange[];
	appliedChanges?: AppliedChange[];
	needsUser: string[];
	blocked: string[];
	nextActions: string[];
	error?: string;
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
	const flags = argv.slice(2);
	if (flags.length === 0 || (flags.length === 1 && flags[0] === "--")) {
		return "dry-run" as const;
	}

	if (flags.length === 2 && flags[0] === "--" && flags[1] === "--dry-run") {
		return "dry-run" as const;
	}

	if (
		flags.length === 3 &&
		flags[0] === "--" &&
		flags[1] === "--apply" &&
		flags[2] === "--yes"
	) {
		return "apply" as const;
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

function readEnvFile(filePath: string) {
	return existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
}

function ensureTrailingNewline(content: string) {
	return content.endsWith("\n") ? content : `${content}\n`;
}

function formatGeneratedSecretValue() {
	return randomBytes(32).toString("base64url");
}

function buildEnvAppendLines(missingKeys: readonly string[]) {
	return missingKeys.map((key) => `${key}=${formatGeneratedSecretValue()}`);
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

function buildChecks(args: {
	branch: string | null;
	remote: {
		url: string | null;
		owner: string | null;
		repository: string | null;
	} | null;
	files: Facts["files"];
	generatedSecretsPresence: ReturnType<typeof readEnvPresence>;
	externalInputsPresence: ReturnType<typeof readEnvPresence>;
}): Check[] {
	const {
		branch,
		remote,
		files,
		generatedSecretsPresence,
		externalInputsPresence,
	} = args;

	return [
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
			ok: !files.envLocalExists || files.envLocalIgnoredByGit !== false,
			detail: files.envLocalExists
				? files.envLocalIgnoredByGit === true
					? ".env.local is ignored by git"
					: files.envLocalIgnoredByGit === false
						? ".env.local is not ignored by git"
						: "git ignore status unavailable"
				: files.envLocalIgnoredByGit === true
					? ".env.local is missing but ignored by git"
					: files.envLocalIgnoredByGit === false
						? ".env.local is missing and not ignored by git"
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
}

function buildFacts(args: {
	branch: string | null;
	remote: {
		url: string | null;
		owner: string | null;
		repository: string | null;
	} | null;
	files: Facts["files"];
	generatedSecretsPresence: ReturnType<typeof readEnvPresence>;
	externalInputsPresence: ReturnType<typeof readEnvPresence>;
}): Facts {
	return {
		git: {
			branch: args.branch,
			remote: args.remote,
		},
		files: args.files,
		env: {
			generatedSecrets: {
				present: args.generatedSecretsPresence.present,
				missingGeneratedSecrets: args.generatedSecretsPresence.missing,
			},
			externalInputs: {
				present: args.externalInputsPresence.present,
				missingExternalInputs: args.externalInputsPresence.missing,
			},
		},
	};
}

function buildPlannedChanges(args: {
	pendingGeneratedSecrets: string[];
	files: Facts["files"];
}) {
	const { pendingGeneratedSecrets, files } = args;
	return [
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
		...(!files.rhapsodyInstructionsExists
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
		...(!files.rhapsodyConfigTomlExists
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
		...(files.envLocalIgnoredByGit === true
			? [
					{
						kind: "env-file",
						target: ".env.local",
						action:
							pendingGeneratedSecrets.length > 0
								? files.envLocalExists
									? `Update only the missing generated secrets in .env.local: ${pendingGeneratedSecrets.join(", ")}.`
									: `Create .env.local with the missing generated secrets: ${pendingGeneratedSecrets.join(", ")}.`
								: files.envLocalExists
									? "Preserve .env.local without writing new values."
									: "Create .env.local without external inputs.",
						reason:
							"Local env files must stay untracked; any .env.local update requires confirmation and only writes missing generated secrets.",
						requiresUserConfirmation: true,
						wouldWrite: pendingGeneratedSecrets.length > 0,
					},
				]
			: []),
	];
}

function buildPostWritePlannedChanges(args: { files: Facts["files"] }) {
	return buildPlannedChanges({
		pendingGeneratedSecrets: [],
		files: args.files,
	}).filter(
		(change) =>
			change.kind !== "secret-generation" &&
			!(change.kind === "env-file" && change.target === ".env.local"),
	);
}

function reportJSON(report: Report, exitCode = 0) {
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	process.exitCode = exitCode;
}

function main() {
	const mode = parseMode(process.argv);
	if (!mode) {
		process.stdout.write(
			`${JSON.stringify(
				{
					ok: false,
					mode: "dry-run",
					phase: "configure-local",
					error:
						"Unsupported arguments. This helper supports no args, --dry-run, or --apply --yes.",
				},
				null,
				2,
			)}\n`,
		);
		process.exitCode = 1;
		return;
	}

	const remote = readGitRemote();
	const branch = readGitBranch();
	const envLocalPath = path.join(process.cwd(), ".env.local");
	const envLocalExists = existsSync(envLocalPath);
	const envLocalIgnoredByGit = isIgnoredByGit(".env.local");
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

	const needsUser = externalInputsPresence.missing.map(
		(key) => `Provide ${key} in process env or .env.local.`,
	);
	if (!remote?.owner || !remote.repository) {
		needsUser.push(
			"Confirm the GitHub owner/repository if the remote is not a GitHub origin.",
		);
	}

	const pendingGeneratedSecrets = generatedSecretsPresence.missing;
	const plannedChanges = buildPlannedChanges({
		pendingGeneratedSecrets,
		files,
	});

	const localWriteBlocked: string[] = [];
	if (envLocalExists && envLocalIgnoredByGit === false) {
		localWriteBlocked.push(
			".env.local is not ignored by git, so future write steps must not create or modify it until ignore rules are fixed.",
		);
	}
	if (!envLocalExists && envLocalIgnoredByGit !== true) {
		localWriteBlocked.push(
			".env.local is missing and is not ignored by git, so it must not be created until ignore rules are fixed.",
		);
	}

	const setupBlocked: string[] = [];
	if (!remote?.owner || !remote.repository) {
		setupBlocked.push(
			"GitHub repository owner and repository name could not be inferred from origin remote.",
		);
	}

	const checks = buildChecks({
		branch,
		remote,
		files,
		generatedSecretsPresence,
		externalInputsPresence,
	});

	const ok = localWriteBlocked.length === 0 && setupBlocked.length === 0;

	if (mode === "apply") {
		if (localWriteBlocked.length > 0) {
			const report: Report = {
				ok: false,
				mode,
				phase: "configure-local",
				facts: buildFacts({
					branch,
					remote,
					files,
					generatedSecretsPresence,
					externalInputsPresence,
				}),
				checks,
				plannedChanges,
				appliedChanges: [],
				needsUser,
				blocked: localWriteBlocked,
				nextActions: ["Resolve blocked items before any write step."],
			};
			reportJSON(report, 1);
			return;
		}

		const envLocalContent = readEnvFile(envLocalPath);
		const appendKeys = readEnvPresence(
			GENERATED_SECRET_KEYS,
			parseEnvFile(envLocalPath),
		).missing.filter((key) => !envLocalKeys.has(key));
		const envLocalWasCreated = envLocalContent === null;

		if (envLocalWasCreated) {
			if (appendKeys.length > 0) {
				writeFileSync(
					envLocalPath,
					ensureTrailingNewline(buildEnvAppendLines(appendKeys).join("\n")),
					{ encoding: "utf8", flag: "wx" },
				);
			}
		} else if (appendKeys.length > 0) {
			const prefix =
				envLocalContent.endsWith("\n") || envLocalContent.length === 0
					? ""
					: "\n";
			const appended = buildEnvAppendLines(appendKeys).join("\n");
			writeFileSync(
				envLocalPath,
				ensureTrailingNewline(`${envLocalContent}${prefix}${appended}`),
				{ encoding: "utf8" },
			);
		}

		const postWriteEnvLocalKeys = parseEnvFile(envLocalPath);
		const postWriteGeneratedSecretsPresence = readEnvPresence(
			GENERATED_SECRET_KEYS,
			postWriteEnvLocalKeys,
		);
		const postWriteExternalInputsPresence = readEnvPresence(
			EXTERNAL_INPUT_KEYS,
			postWriteEnvLocalKeys,
		);
		const postWriteFiles = {
			...files,
			envLocalExists: existsSync(envLocalPath),
			envLocalIgnoredByGit: isIgnoredByGit(".env.local"),
		};
		const postWritePlannedChanges = buildPostWritePlannedChanges({
			files: postWriteFiles,
		});
		const postWriteChecks = buildChecks({
			branch,
			remote,
			files: postWriteFiles,
			generatedSecretsPresence: postWriteGeneratedSecretsPresence,
			externalInputsPresence: postWriteExternalInputsPresence,
		});
		const postWriteAppliedChanges = GENERATED_SECRET_KEYS.map((key) => ({
			key,
			target: ".env.local",
			action: appendKeys.includes(key)
				? envLocalWasCreated
					? "Created .env.local with missing generated secret."
					: "Appended missing generated secret to .env.local."
				: "No write needed; key already present in process env or .env.local.",
			wrote: appendKeys.includes(key),
		}));

		const applyReport: Report = {
			ok: true,
			mode,
			phase: "configure-local",
			facts: buildFacts({
				branch,
				remote,
				files: postWriteFiles,
				generatedSecretsPresence: postWriteGeneratedSecretsPresence,
				externalInputsPresence: postWriteExternalInputsPresence,
			}),
			checks: postWriteChecks,
			plannedChanges: postWritePlannedChanges,
			appliedChanges: postWriteAppliedChanges,
			needsUser,
			blocked: [],
			nextActions: postWriteAppliedChanges.some((change) => change.wrote)
				? ["Re-run dry-run to confirm the final env state."]
				: [
						"No generated secrets were missing; proceed to the next setup phase.",
					],
		};
		process.stdout.write(`${JSON.stringify(applyReport, null, 2)}\n`);
		return;
	}

	const report: Report = {
		ok,
		mode,
		phase: "configure-local",
		facts: buildFacts({
			branch,
			remote,
			files,
			generatedSecretsPresence,
			externalInputsPresence,
		}),
		checks,
		plannedChanges,
		needsUser,
		blocked: [...localWriteBlocked, ...setupBlocked],
		nextActions: [
			...([...localWriteBlocked, ...setupBlocked].length > 0
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
