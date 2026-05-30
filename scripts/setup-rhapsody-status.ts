import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

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

type EnvSource = "process" | ".env.local" | "vercel-link";

type EnvPresence = {
	present: Record<string, boolean>;
	sources: Record<string, EnvSource[]>;
	missing: string[];
};

function run(command: string, args: string[]) {
	return spawnSync(command, args, { encoding: "utf8" });
}

function readGitContext() {
	const remote = run("git", ["remote", "get-url", "origin"]);
	const branch = run("git", ["branch", "--show-current"]);

	const remoteUrl = remote.status === 0 ? remote.stdout.trim() : null;
	const currentBranch = branch.status === 0 ? branch.stdout.trim() : null;

	return {
		currentBranch,
		remote: {
			url: redactGitRemoteUrl(remoteUrl),
			repository: parseGitHubRepository(remoteUrl),
		},
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
	envLocalKeys: ReadonlySet<string>,
	vercelProjectLink: ReturnType<typeof readVercelProjectLink>,
): EnvPresence {
	const present: Record<string, boolean> = {};
	const sources: Record<string, EnvSource[]> = {};
	const missing: string[] = [];

	for (const key of keys) {
		const keySources: EnvSource[] = [];
		if (String(process.env[key] ?? "").trim()) {
			keySources.push("process");
		}
		if (envLocalKeys.has(key)) {
			keySources.push(".env.local");
		}
		if (key === "VERCEL_TEAM_ID" && vercelProjectLink.orgIdPresent) {
			keySources.push("vercel-link");
		}
		if (key === "VERCEL_PROJECT_ID" && vercelProjectLink.projectIdPresent) {
			keySources.push("vercel-link");
		}

		present[key] = keySources.length > 0;
		sources[key] = keySources;
		if (keySources.length === 0) {
			missing.push(key);
		}
	}

	return { present, sources, missing };
}

function buildRecommendedNextCommand(args: {
	files: {
		envLocalExists: boolean;
		rhapsodyConfigTsExists: boolean;
		rhapsodyInstructionsExists: boolean;
		rhapsodyConfigTomlExists: boolean;
	};
	generatedSecrets: EnvPresence;
	externalInputs: EnvPresence;
}) {
	const localFilesReady =
		args.files.envLocalExists &&
		args.files.rhapsodyConfigTsExists &&
		args.files.rhapsodyInstructionsExists &&
		args.files.rhapsodyConfigTomlExists;

	if (!localFilesReady || args.generatedSecrets.missing.length > 0) {
		return "pnpm setup:configure-local -- --dry-run";
	}

	if (args.externalInputs.missing.length > 0) {
		return "pnpm setup:configure-deploy -- --dry-run";
	}

	return "pnpm setup:inspect";
}

function buildNextActions(args: {
	recommendedNextCommand: string;
	codexSeed: EnvPresence;
}) {
	const { recommendedNextCommand, codexSeed } = args;
	if (recommendedNextCommand.includes("setup:configure-local")) {
		return [
			"Run pnpm setup:configure-local -- --dry-run to review missing local files and generated secrets.",
			"Apply local setup only after reviewing the planned file changes.",
		];
	}

	if (recommendedNextCommand.includes("setup:configure-deploy")) {
		return [
			"Provide missing external deploy inputs through process env or .env.local.",
			"Run pnpm setup:configure-deploy -- --dry-run before any Vercel env write.",
		];
	}

	const nextActions = [
		"Run pnpm setup:inspect to check local CLIs, authentication, and Git context.",
		"Then continue with configure-local, configure-github, and configure-deploy dry-runs.",
	];

	if (codexSeed.missing.length > 0) {
		nextActions.push(
			"Before the first sandbox-codex run, provide INITIAL_CHATGPT_AUTH_JSON only through the explicit Codex seed flow.",
		);
	}

	return nextActions;
}

const envLocalPath = path.join(process.cwd(), ".env.local");
const rhapsodyConfigTomlPath = path.join(
	process.cwd(),
	".rhapsody",
	"config.toml",
);
const rhapsodyInstructionsPath = path.join(
	process.cwd(),
	".rhapsody",
	"INSTRUCTIONS.md",
);
const envLocalKeys = parseEnvFileKeys(envLocalPath);
const vercelProjectLink = readVercelProjectLink();

const files = {
	envLocalExists: existsSync(envLocalPath),
	rhapsodyConfigTsExists: existsSync(
		path.join(process.cwd(), "rhapsody.config.ts"),
	),
	rhapsodyInstructionsExists: existsSync(rhapsodyInstructionsPath),
	rhapsodyConfigTomlExists: existsSync(rhapsodyConfigTomlPath),
};
const generatedSecrets = readEnvPresence(
	GENERATED_SECRET_KEYS,
	envLocalKeys,
	vercelProjectLink,
);
const externalInputs = readEnvPresence(
	EXTERNAL_INPUT_KEYS,
	envLocalKeys,
	vercelProjectLink,
);
const codexSeed = readEnvPresence(
	CODEX_SEED_KEYS,
	envLocalKeys,
	vercelProjectLink,
);
const recommendedNextCommand = buildRecommendedNextCommand({
	files,
	generatedSecrets,
	externalInputs,
});

const report = {
	ok:
		files.envLocalExists &&
		files.rhapsodyConfigTsExists &&
		files.rhapsodyInstructionsExists &&
		files.rhapsodyConfigTomlExists &&
		generatedSecrets.missing.length === 0 &&
		externalInputs.missing.length === 0,
	phase: "status",
	facts: {
		files,
		vercelProjectLink,
		git: readGitContext(),
		env: {
			generatedSecrets,
			externalInputs,
			codexSeed,
		},
	},
	recommendedNextCommand,
	nextActions: buildNextActions({
		recommendedNextCommand,
		codexSeed,
	}),
};

console.log(JSON.stringify(report, null, 2));
