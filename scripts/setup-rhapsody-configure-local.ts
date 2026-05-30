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
	vercelProjectLink: {
		exists: boolean;
		orgIdPresent: boolean;
		projectIdPresent: boolean;
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
		codexSeed: {
			present: Record<string, boolean>;
			missingCodexSeedInputs: string[];
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

type ParsedMode =
	| {
			mode: "dry-run";
			projectNumber?: number;
	  }
	| {
			mode: "apply";
			projectNumber?: number;
	  };

type TrackerEditPlan = {
	kind: "replace" | "insert" | "blocked";
	content: string | null;
	wouldWrite: boolean;
	action: string;
	blockedReason: string | null;
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
] as const;

const CODEX_SEED_KEYS = ["INITIAL_CHATGPT_AUTH_JSON"] as const;

function run(command: string, args: string[]) {
	return spawnSync(command, args, { encoding: "utf8" });
}

function normalizeFlags(argv: string[]) {
	const flags = argv.slice(2);
	return flags.length > 0 && flags[0] === "--" ? flags.slice(1) : flags;
}

function parseMode(argv: string[]): ParsedMode | null {
	const flags = normalizeFlags(argv);
	const args = flags;
	if (args.length === 0) {
		return { mode: "dry-run" } as const;
	}

	if (args.length === 1 && args[0] === "--dry-run") {
		return { mode: "dry-run" } as const;
	}

	if (
		args.length === 3 &&
		args[0] === "--dry-run" &&
		args[1] === "--project-number" &&
		/^\d+$/.test(args[2] ?? "")
	) {
		const parsedNumber = Number(args[2]);
		if (Number.isInteger(parsedNumber) && parsedNumber > 0) {
			return {
				mode: "dry-run",
				projectNumber: parsedNumber,
			} as const;
		}
	}

	const [apply, yes, projectNumberFlag, projectNumberValue] = args;
	if (apply !== "--apply" || yes !== "--yes") {
		return null;
	}

	if (args.length === 2) {
		return { mode: "apply" } as const;
	}

	if (
		args.length === 4 &&
		projectNumberFlag === "--project-number" &&
		/^\d+$/.test(projectNumberValue ?? "")
	) {
		const parsedNumber = Number(projectNumberValue);
		if (Number.isInteger(parsedNumber) && parsedNumber > 0) {
			return {
				mode: "apply",
				projectNumber: parsedNumber,
			} as const;
		}
	}

	return null;
}

function buildTrackerEditPlan(
	content: string,
	projectNumber: number,
): TrackerEditPlan {
	const tracker = extractTrackerBlock(content);
	if (!tracker) {
		return {
			kind: "blocked",
			content,
			wouldWrite: false,
			action: "No change",
			blockedReason:
				"Could not locate tracker block in rhapsody.config.ts; refusing to perform a brittle edit.",
		};
	}

	const match = tracker.blockContent.match(
		/^(\s*)projectNumber\s*:\s*(\d+)\s*,?\s*$/m,
	);
	if (match) {
		const replacementLine = `${match[1]}projectNumber: ${projectNumber},`;
		const updatedBlockContent = tracker.blockContent.replace(
			/^(\s*)projectNumber\s*:\s*(\d+)\s*,?\s*$/m,
			replacementLine,
		);
		const updated = `${content.slice(0, tracker.blockStart + 1)}${updatedBlockContent}${content.slice(tracker.blockEnd)}`;
		return {
			kind: "replace",
			content: updated,
			wouldWrite: true,
			action:
				"Replaced tracker.projectNumber with the provided project number in rhapsody.config.ts.",
			blockedReason: null,
		};
	}

	const insertMatch = findTrackerInsertOffset(tracker.blockContent);
	if (!insertMatch) {
		return {
			kind: "blocked",
			content,
			wouldWrite: false,
			action: "No change",
			blockedReason:
				"Could not safely determine where to insert tracker.projectNumber in rhapsody.config.ts.",
		};
	}

	const insertOffset = insertMatch.offset;
	const insertLine = `${insertMatch.indent}projectNumber: ${projectNumber},\n`;
	const updatedBlockContent =
		insertOffset === 0
			? `${insertLine}${tracker.blockContent}`
			: `${tracker.blockContent.slice(0, insertOffset)}${insertLine}${tracker.blockContent.slice(insertOffset)}`;

	const updated = `${content.slice(0, tracker.blockStart + 1)}${updatedBlockContent}${content.slice(tracker.blockEnd)}`;

	return {
		kind: "insert",
		content: updated,
		wouldWrite: true,
		action:
			"Inserted tracker.projectNumber into the tracker block in rhapsody.config.ts.",
		blockedReason: null,
	};
}

function findTrackerInsertOffset(blockContent: string) {
	const lines = blockContent.split(/\r?\n/);
	let propertyIndent = "";
	for (const line of lines) {
		const match = line.match(/^(\s*)[A-Za-z_][A-Za-z0-9_]*\s*:/);
		if (match?.[1]) {
			propertyIndent = match[1];
			break;
		}
	}

	if (!propertyIndent) {
		return null;
	}

	const statusFieldIndex = blockContent.match(/^\s*statusField\s*:/m)?.index;
	if (typeof statusFieldIndex === "number") {
		return { indent: propertyIndent, offset: statusFieldIndex };
	}

	const closeMatch = blockContent.lastIndexOf("\n");
	const insertOffset = closeMatch >= 0 ? closeMatch + 1 : 0;
	return { indent: propertyIndent, offset: insertOffset };
}

function applyTrackerProjectNumber(
	content: string,
	projectNumber: number,
): TrackerEditPlan {
	return buildTrackerEditPlan(content, projectNumber);
}

function extractTrackerBlock(content: string): {
	blockStart: number;
	blockEnd: number;
	blockContent: string;
} | null {
	const trackerMatch = content.match(/(^|\n)([ \t]*)tracker\s*:\s*\{/m);
	if (!trackerMatch) {
		return null;
	}

	const openBraceIndex =
		(trackerMatch.index || 0) + trackerMatch[0].indexOf("{");
	let depth = 0;
	let inString: "'" | '"' | "`" | null = null;
	let escaped = false;
	let blockStart = -1;

	for (let index = openBraceIndex; index < content.length; index += 1) {
		const char = content[index];

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === inString) {
				inString = null;
			}
			continue;
		}

		if (char === "'" || char === '"' || char === "`") {
			inString = char;
			continue;
		}

		if (char === "{") {
			if (depth === 0) {
				blockStart = index;
			}
			depth += 1;
			continue;
		}

		if (char === "}") {
			depth -= 1;
			if (depth === 0 && blockStart !== -1) {
				const blockEnd = index;
				return {
					blockStart,
					blockEnd,
					blockContent: content.slice(blockStart + 1, blockEnd),
				};
			}
		}
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

function readVercelProjectLink() {
	const filePath = path.join(process.cwd(), ".vercel", "project.json");
	if (!existsSync(filePath)) {
		return {
			exists: false,
			orgIdPresent: false,
			projectIdPresent: false,
		};
	}

	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
			orgId?: string;
			projectId?: string;
		};

		return {
			exists: true,
			orgIdPresent: Boolean(parsed.orgId?.trim()),
			projectIdPresent: Boolean(parsed.projectId?.trim()),
		};
	} catch {
		return {
			exists: true,
			orgIdPresent: false,
			projectIdPresent: false,
		};
	}
}

function readEnvPresence(
	keys: readonly string[],
	envLocalKeys: Set<string>,
	vercelProjectLink: ReturnType<typeof readVercelProjectLink>,
) {
	const present: Record<string, boolean> = {};
	const missing: string[] = [];

	for (const key of keys) {
		const isPresent =
			Boolean(process.env[key]?.trim()) ||
			envLocalKeys.has(key) ||
			(key === "VERCEL_TEAM_ID" && vercelProjectLink.orgIdPresent) ||
			(key === "VERCEL_PROJECT_ID" && vercelProjectLink.projectIdPresent);
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
	vercelProjectLink: Facts["vercelProjectLink"];
	generatedSecretsPresence: ReturnType<typeof readEnvPresence>;
	externalInputsPresence: ReturnType<typeof readEnvPresence>;
	codexSeedPresence: ReturnType<typeof readEnvPresence>;
}): Facts {
	return {
		git: {
			branch: args.branch,
			remote: args.remote,
		},
		files: args.files,
		vercelProjectLink: args.vercelProjectLink,
		env: {
			generatedSecrets: {
				present: args.generatedSecretsPresence.present,
				missingGeneratedSecrets: args.generatedSecretsPresence.missing,
			},
			externalInputs: {
				present: args.externalInputsPresence.present,
				missingExternalInputs: args.externalInputsPresence.missing,
			},
			codexSeed: {
				present: args.codexSeedPresence.present,
				missingCodexSeedInputs: args.codexSeedPresence.missing,
			},
		},
	};
}

function buildPlannedChanges(args: {
	pendingGeneratedSecrets: string[];
	files: Facts["files"];
	projectNumberPlan: TrackerEditPlan | null;
	applyProjectNumber: boolean;
}) {
	const {
		pendingGeneratedSecrets,
		files,
		projectNumberPlan,
		applyProjectNumber,
	} = args;

	if (applyProjectNumber) {
		return [
			projectNumberPlan
				? {
						kind: "config-update",
						target: "rhapsody.config.ts",
						action: projectNumberPlan.action,
						reason: projectNumberPlan.wouldWrite
							? "Persist a board number created by configure-github into the local tracker config."
							: "Preserve local config unchanged until tracker block changes can be made safely.",
						requiresUserConfirmation: true,
						wouldWrite: projectNumberPlan.wouldWrite,
					}
				: {
						kind: "config-update",
						target: "rhapsody.config.ts",
						action:
							"Persist the configured project number in tracker.projectNumber.",
						reason:
							"Persisting the project number is required for later setup steps.",
						requiresUserConfirmation: true,
						wouldWrite: false,
					},
		];
	}

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

function buildExternalInputGuidance(missingExternalInputs: readonly string[]) {
	const guidance = missingExternalInputs.map(
		(key) => `Provide ${key} in process env or .env.local.`,
	);

	if (missingExternalInputs.includes("VERCEL_TOKEN")) {
		guidance.push(
			"Create a Vercel API token in Vercel account settings, then expose it as VERCEL_TOKEN for configure-deploy and deploy-preview.",
		);
	}

	return guidance;
}

function buildDryRunNextActions(args: {
	blocked: string[];
	planProjectNumber: boolean;
	projectNumberWouldWrite: boolean;
	missingGeneratedSecrets: readonly string[];
	missingExternalInputs: readonly string[];
	needsUser: readonly string[];
}) {
	const nextActions: string[] = [];

	if (args.blocked.length > 0) {
		nextActions.push("Resolve blocked items before any write step.");
	}

	if (args.planProjectNumber && args.projectNumberWouldWrite) {
		nextActions.push(
			"Review the planned rhapsody.config.ts project number change, then rerun with --apply --yes --project-number <number>.",
		);
	}

	if (args.missingGeneratedSecrets.length > 0 && args.blocked.length === 0) {
		nextActions.push(
			`Missing generated local secrets: ${args.missingGeneratedSecrets.join(", ")}.`,
			"After reviewing this dry-run, run pnpm setup:configure-local -- --apply --yes to write only missing generated local secrets.",
		);
	}

	if (args.missingExternalInputs.length > 0) {
		nextActions.push(...buildExternalInputGuidance(args.missingExternalInputs));
	}

	if (nextActions.length === 0 && args.needsUser.length === 0) {
		nextActions.push(
			"Proceed to configure-github, then configure-deploy when the operator is ready.",
		);
	}

	return nextActions;
}

function buildPostWritePlannedChanges(args: { files: Facts["files"] }) {
	return buildPlannedChanges({
		pendingGeneratedSecrets: [],
		files: args.files,
		projectNumberPlan: null,
		applyProjectNumber: false,
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
						"Unsupported arguments. Supported forms: no args, --dry-run, -- --dry-run, --dry-run --project-number <number>, -- --dry-run --project-number <number>, --apply --yes, -- --apply --yes, --apply --yes --project-number <number>, -- --apply --yes --project-number <number>.",
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
	const vercelProjectLink = readVercelProjectLink();

	const generatedSecretsPresence = readEnvPresence(
		GENERATED_SECRET_KEYS,
		envLocalKeys,
		vercelProjectLink,
	);
	const externalInputsPresence = readEnvPresence(
		EXTERNAL_INPUT_KEYS,
		envLocalKeys,
		vercelProjectLink,
	);
	const codexSeedPresence = readEnvPresence(
		CODEX_SEED_KEYS,
		envLocalKeys,
		vercelProjectLink,
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
	if (externalInputsPresence.missing.includes("VERCEL_TOKEN")) {
		needsUser.push(
			"Create a Vercel API token in Vercel account settings, then expose it as VERCEL_TOKEN for configure-deploy and deploy-preview.",
		);
	}
	if (!remote?.owner || !remote.repository) {
		needsUser.push(
			"Confirm the GitHub owner/repository if the remote is not a GitHub origin.",
		);
	}

	const pendingGeneratedSecrets = generatedSecretsPresence.missing;
	const applyProjectNumber =
		mode.mode === "apply" && mode.projectNumber !== undefined;
	const planProjectNumber =
		mode.mode === "dry-run" && mode.projectNumber !== undefined;
	const projectConfigPath = path.join(process.cwd(), "rhapsody.config.ts");
	const projectConfigContent = existsSync(projectConfigPath)
		? readFileSync(projectConfigPath, "utf8")
		: null;
	const projectNumberPlan =
		mode.projectNumber !== undefined &&
		(applyProjectNumber || planProjectNumber)
			? applyTrackerProjectNumber(
					projectConfigContent ?? "",
					mode.projectNumber,
				)
			: null;
	const plannedChanges = buildPlannedChanges({
		pendingGeneratedSecrets,
		files,
		projectNumberPlan,
		applyProjectNumber: applyProjectNumber || planProjectNumber,
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
	const dryRunBlocked = [
		...localWriteBlocked,
		...setupBlocked,
		...(planProjectNumber && projectNumberPlan?.blockedReason
			? [projectNumberPlan.blockedReason]
			: []),
	];

	if (mode.mode === "apply") {
		if (applyProjectNumber) {
			if (!files.rhapsodyConfigTsExists) {
				const report: Report = {
					ok: false,
					mode: mode.mode,
					phase: "configure-local",
					facts: buildFacts({
						branch,
						remote,
						files,
						vercelProjectLink,
						generatedSecretsPresence,
						externalInputsPresence,
						codexSeedPresence,
					}),
					checks,
					plannedChanges,
					appliedChanges: [],
					needsUser,
					blocked: [
						"rhapsody.config.ts is required for project-number persistence, but was not found.",
					],
					nextActions: [
						"Create or restore rhapsody.config.ts before applying project-number updates.",
					],
				};
				reportJSON(report, 1);
				return;
			}

			if (!projectNumberPlan || projectNumberPlan.blockedReason) {
				const report: Report = {
					ok: false,
					mode: mode.mode,
					phase: "configure-local",
					facts: buildFacts({
						branch,
						remote,
						files,
						vercelProjectLink,
						generatedSecretsPresence,
						externalInputsPresence,
						codexSeedPresence,
					}),
					checks,
					plannedChanges,
					appliedChanges: [],
					needsUser,
					blocked: [
						projectNumberPlan?.blockedReason ??
							"Unable to build a safe tracker.projectNumber edit plan.",
					],
					nextActions: [
						"Open rhapsody.config.ts and update tracker.projectNumber manually.",
					],
				};
				reportJSON(report, 1);
				return;
			}

			const updatedConfigContent = projectNumberPlan.content;
			if (!updatedConfigContent) {
				const report: Report = {
					ok: false,
					mode: mode.mode,
					phase: "configure-local",
					facts: buildFacts({
						branch,
						remote,
						files,
						vercelProjectLink,
						generatedSecretsPresence,
						externalInputsPresence,
						codexSeedPresence,
					}),
					checks,
					plannedChanges,
					appliedChanges: [],
					needsUser,
					blocked: ["Unable to build tracker.projectNumber content update."],
					nextActions: [
						"Open rhapsody.config.ts and update tracker.projectNumber manually.",
					],
				};
				reportJSON(report, 1);
				return;
			}

			writeFileSync(
				projectConfigPath,
				ensureTrailingNewline(updatedConfigContent),
			);

			const postWriteChecks = buildChecks({
				branch,
				remote,
				files,
				generatedSecretsPresence,
				externalInputsPresence,
			});
			const postWritePlannedChanges = buildPlannedChanges({
				pendingGeneratedSecrets: [],
				files,
				projectNumberPlan,
				applyProjectNumber: true,
			});
			const applyReport: Report = {
				ok: true,
				mode: mode.mode,
				phase: "configure-local",
				facts: buildFacts({
					branch,
					remote,
					files,
					vercelProjectLink,
					generatedSecretsPresence,
					externalInputsPresence,
					codexSeedPresence,
				}),
				checks: postWriteChecks,
				plannedChanges: postWritePlannedChanges,
				appliedChanges: [
					{
						key: "projectNumber",
						target: "rhapsody.config.ts",
						action:
							projectNumberPlan.kind === "replace"
								? "Replaced tracker.projectNumber in rhapsody.config.ts."
								: "Inserted tracker.projectNumber in rhapsody.config.ts.",
						wrote: true,
					},
				],
				needsUser,
				blocked: [],
				nextActions: [
					"Proceed to configure-github, then configure-deploy after project persistence.",
				],
			};
			process.stdout.write(`${JSON.stringify(applyReport, null, 2)}\n`);
			return;
		}

		if (localWriteBlocked.length > 0) {
			const report: Report = {
				ok: false,
				mode: mode.mode,
				phase: "configure-local",
				facts: buildFacts({
					branch,
					remote,
					files,
					vercelProjectLink,
					generatedSecretsPresence,
					externalInputsPresence,
					codexSeedPresence,
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
			vercelProjectLink,
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
			vercelProjectLink,
		);
		const postWriteExternalInputsPresence = readEnvPresence(
			EXTERNAL_INPUT_KEYS,
			postWriteEnvLocalKeys,
			vercelProjectLink,
		);
		const postWriteCodexSeedPresence = readEnvPresence(
			CODEX_SEED_KEYS,
			postWriteEnvLocalKeys,
			vercelProjectLink,
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
			mode: mode.mode,
			phase: "configure-local",
			facts: buildFacts({
				branch,
				remote,
				files: postWriteFiles,
				vercelProjectLink,
				generatedSecretsPresence: postWriteGeneratedSecretsPresence,
				externalInputsPresence: postWriteExternalInputsPresence,
				codexSeedPresence: postWriteCodexSeedPresence,
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
		mode: mode.mode,
		phase: "configure-local",
		facts: buildFacts({
			branch,
			remote,
			files,
			vercelProjectLink,
			generatedSecretsPresence,
			externalInputsPresence,
			codexSeedPresence,
		}),
		checks,
		plannedChanges,
		needsUser,
		blocked: [...dryRunBlocked],
		nextActions: buildDryRunNextActions({
			blocked: dryRunBlocked,
			planProjectNumber: Boolean(planProjectNumber),
			projectNumberWouldWrite: Boolean(projectNumberPlan?.wouldWrite),
			missingGeneratedSecrets: generatedSecretsPresence.missing,
			missingExternalInputs: externalInputsPresence.missing,
			needsUser,
		}),
	};

	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	process.exitCode = 0;
}

main();
