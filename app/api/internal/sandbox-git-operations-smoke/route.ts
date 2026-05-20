import { isRecord } from "@/lib/server/json";
import {
	createVercelSandbox,
	buildVercelSandboxGitHubNetworkPolicy,
	getVercelSandboxId,
	runVercelSandboxCommand,
	stopVercelSandbox,
	type RhapsodyVercelSandbox,
	type VercelSandboxCommandSummary,
} from "@/lib/sandbox/vercel";
import { loadRhapsodyConfig, loadRhapsodyGitHubEnv } from "@/lib/config";
import { requireAdminAuth } from "@/lib/server/admin-auth";

export const runtime = "nodejs";

const SANDBOX_WORKDIR = "/";
const NETWORK_POLICY_DOMAINS = ["github.com", "*.github.com", "api.github.com"];
const DEFAULT_AUTH_HEADER_PREFIX = "basic" as const;
const SMOKE_BRANCH_PREFIX = "rhapsody-smoke/";
const GIT_SMOKE_REMOTE_OPERATION = "git ls-remote <repositoryUrl>";
const GIT_SMOKE_CLONE_OPERATION = "git clone --depth 1 <repositoryUrl> repo";
const GIT_SMOKE_STATUS_OPERATION = "git status --short";
const GIT_SMOKE_PUSH_OPERATION = "git push HEAD:<branchName>";

type SmokeOperation = "ls-remote" | "clone" | "push";

type SmokeRequest = {
	operation?: SmokeOperation;
	repositoryUrl?: string;
	authorizationHeaderPrefix?: "token" | "bearer" | "basic";
	branchName?: string;
};

type SmokeOperationCommand = {
	command: string;
	summary: VercelSandboxCommandSummary;
};

type SmokeOperationResult = {
	command: VercelSandboxCommandSummary;
	commands: SmokeOperationCommand[];
};

type Timing = {
	startedAt: number;
	finishedAt: number;
	durationMs: number;
};

export async function POST(request: Request) {
	const auth = requireAdminAuth(request);

	if (!auth.ok) {
		return auth.response;
	}

	const body = await request.text();
	const parsed = parseSmokeRequest(body);

	if (!parsed.ok) {
		return Response.json({ error: parsed.error }, { status: 400 });
	}

	let repoUrl = "";
	let sandbox: RhapsodyVercelSandbox | null = null;
	const startedAt = Date.now();
	const operation = parsed.value.operation ?? "ls-remote";

	try {
		const config = loadRhapsodyConfig();
		const defaultRepoUrl = `https://github.com/${config.repository.owner}/${config.repository.name}.git`;
		const githubEnv = loadRhapsodyGitHubEnv();
		repoUrl = parsed.value.repositoryUrl ?? defaultRepoUrl;

		const repositoryUrl = new URL(repoUrl);
		if (!/^https?:$/.test(repositoryUrl.protocol)) {
			return Response.json(
				{ error: "repositoryUrl must use http or https." },
				{ status: 400 },
			);
		}
		if (!isAllowedRepositoryHost(repositoryUrl.hostname)) {
			return Response.json(
				{
					error:
						"repositoryUrl host must be github.com or a github.com subdomain.",
				},
				{ status: 400 },
			);
		}

		const policy = buildVercelSandboxGitHubNetworkPolicy({
			githubToken: githubEnv.GITHUB_TOKEN,
			authorizationHeaderPrefix:
				parsed.value.authorizationHeaderPrefix ?? DEFAULT_AUTH_HEADER_PREFIX,
		});

		sandbox = await createVercelSandbox({ networkPolicy: policy });
		const result = await runOperation(
			sandbox,
			operation,
			repositoryUrl.toString(),
			parsed.value.branchName,
		);

		return Response.json({
			sandboxId: getVercelSandboxId(sandbox),
			repositoryUrl: repositoryUrl.toString(),
			networkPolicy: {
				allowedHosts: NETWORK_POLICY_DOMAINS,
				headerTransform: "Authorization",
				authorizationHeaderPrefix:
					parsed.value.authorizationHeaderPrefix ?? DEFAULT_AUTH_HEADER_PREFIX,
			},
			command: {
				exitCode: result.command.exitCode,
				operation,
				stdoutLines: result.command.stdout.trim().split("\n").length,
			},
			commands: result.commands,
			timing: buildTiming(startedAt),
		});
	} catch (error) {
		return Response.json(
			{
				error: "GitHub network-policy smoke test failed.",
				repositoryUrl: repoUrl,
				detail: serializeError(error),
			},
			{ status: 500 },
		);
	} finally {
		if (sandbox) {
			await stopVercelSandbox(sandbox);
		}
	}
}

function parseSmokeRequest(
	body: string,
): { ok: true; value: SmokeRequest } | { ok: false; error: string } {
	if (!body.trim()) {
		return parseOperation({}, {});
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return {
			ok: false,
			error: "Request body must be valid JSON when provided.",
		};
	}

	if (!isRecord(parsed)) {
		return { ok: false, error: "Request body must be a JSON object." };
	}

	const repositoryResult = parseRepositoryUrl(parsed);
	if (!repositoryResult.ok) {
		return repositoryResult;
	}

	const operationResult = parseOperation(parsed, repositoryResult.value);
	if (!operationResult.ok) {
		return operationResult;
	}

	const authorizationPrefixResult = parseAuthorizationHeaderPrefix(
		parsed,
		operationResult.value,
	);
	if (!authorizationPrefixResult.ok) {
		return authorizationPrefixResult;
	}

	return parseBranchName(parsed, authorizationPrefixResult.value);
}

function parseRepositoryUrl(
	parsed: Record<string, unknown>,
): { ok: true; value: SmokeRequest } | { ok: false; error: string } {
	if (parsed.repositoryUrl === undefined) {
		return { ok: true, value: {} };
	}

	if (
		typeof parsed.repositoryUrl !== "string" ||
		!parsed.repositoryUrl.trim()
	) {
		return {
			ok: false,
			error: "repositoryUrl must be a non-empty string when provided.",
		};
	}

	const trimmed = parsed.repositoryUrl.trim();
	if (!/^https?:\/\/[^/]+/.test(trimmed)) {
		return {
			ok: false,
			error: "repositoryUrl must be a valid URL when provided.",
		};
	}

	return { ok: true, value: { repositoryUrl: trimmed } };
}

function parseOperation(
	parsed: Record<string, unknown>,
	value: SmokeRequest,
): { ok: true; value: SmokeRequest } | { ok: false; error: string } {
	if (parsed.operation === undefined) {
		return { ok: true, value };
	}

	if (
		parsed.operation !== "ls-remote" &&
		parsed.operation !== "clone" &&
		parsed.operation !== "push"
	) {
		return {
			ok: false,
			error: "operation must be one of: ls-remote, clone, push.",
		};
	}

	return { ok: true, value: { ...value, operation: parsed.operation } };
}

function parseAuthorizationHeaderPrefix(
	parsed: Record<string, unknown>,
	value: SmokeRequest,
): { ok: true; value: SmokeRequest } | { ok: false; error: string } {
	if (parsed.authorizationHeaderPrefix === undefined) {
		return { ok: true, value };
	}

	if (
		parsed.authorizationHeaderPrefix !== "token" &&
		parsed.authorizationHeaderPrefix !== "bearer" &&
		parsed.authorizationHeaderPrefix !== "basic"
	) {
		return {
			ok: false,
			error: "authorizationHeaderPrefix must be one of: token, bearer, basic.",
		};
	}

	return {
		ok: true,
		value: {
			...value,
			authorizationHeaderPrefix: parsed.authorizationHeaderPrefix,
		},
	};
}

function parseBranchName(
	parsed: Record<string, unknown>,
	value: SmokeRequest,
): { ok: true; value: SmokeRequest } | { ok: false; error: string } {
	if (value.operation !== "push") {
		return { ok: true, value };
	}

	if (typeof parsed.branchName !== "string" || !parsed.branchName.trim()) {
		return {
			ok: false,
			error: "branchName is required for push operation.",
		};
	}

	const branchName = parsed.branchName.trim();
	if (!branchName.startsWith(SMOKE_BRANCH_PREFIX)) {
		return {
			ok: false,
			error: `branchName for push must start with "${SMOKE_BRANCH_PREFIX}".`,
		};
	}
	if (!/^rhapsody-smoke\/[A-Za-z0-9._/-]+$/.test(branchName)) {
		return {
			ok: false,
			error:
				"branchName for push may contain only ASCII letters, numbers, dot, underscore, slash, and hyphen.",
		};
	}

	return { ok: true, value: { ...value, branchName } };
}

function buildTiming(startedAt: number): Timing {
	const finishedAt = Date.now();

	return {
		startedAt,
		finishedAt,
		durationMs: finishedAt - startedAt,
	};
}

function serializeError(error: unknown) {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
		};
	}

	return { name: "UnknownError", message: String(error) };
}

function isAllowedRepositoryHost(hostname: string) {
	const lowered = hostname.toLowerCase();
	return (
		lowered === "github.com" ||
		lowered === "api.github.com" ||
		lowered.endsWith(".github.com")
	);
}

async function runOperation(
	sandbox: RhapsodyVercelSandbox,
	operation: SmokeOperation,
	repositoryUrl: string,
	branchName?: string,
): Promise<SmokeOperationResult> {
	const commands: SmokeOperationCommand[] = [];

	if (operation === "ls-remote") {
		const command = await runVercelSandboxCommand(sandbox, {
			cmd: "git",
			args: ["ls-remote", repositoryUrl],
			cwd: SANDBOX_WORKDIR,
		});
		commands.push({ command: GIT_SMOKE_REMOTE_OPERATION, summary: command });
		return { command, commands };
	}

	const workspace = await runVercelSandboxCommand(sandbox, {
		cmd: "mktemp",
		args: ["-d", "/tmp/rhapsody-smoke.XXXXXX"],
		cwd: SANDBOX_WORKDIR,
	});
	commands.push({
		command: "mktemp -d /tmp/rhapsody-smoke.XXXXXX",
		summary: workspace,
	});
	if (workspace.exitCode !== 0) {
		return { command: workspace, commands };
	}

	const tempWorkdir = workspace.stdout.trim();
	if (!tempWorkdir) {
		const failure = {
			...workspace,
			exitCode: 1,
			stderr: "sandbox clone command returned no workdir.",
			stdout: "",
		};
		commands.push({
			command: "mktemp -d /tmp/rhapsody-smoke.XXXXXX",
			summary: failure,
		});
		return {
			command: failure,
			commands,
		};
	}

	const repoPath = `${tempWorkdir}/repo`;
	const clone = await runVercelSandboxCommand(sandbox, {
		cmd: "git",
		args: ["clone", "--depth", "1", repositoryUrl, "repo"],
		cwd: tempWorkdir,
	});
	commands.push({
		command: GIT_SMOKE_CLONE_OPERATION.replace("<repositoryUrl>", repositoryUrl),
		summary: clone,
	});
	if (clone.exitCode !== 0) {
		return { command: clone, commands };
	}

	const status = await runVercelSandboxCommand(sandbox, {
		cmd: "git",
		args: ["status", "--short"],
		cwd: repoPath,
	});
	commands.push({ command: GIT_SMOKE_STATUS_OPERATION, summary: status });
	if (operation === "clone") {
		return { command: status, commands };
	}

	if (!branchName) {
		const failure = {
			...status,
			exitCode: 1,
			stderr: "branchName is required for push operation.",
		};
		return {
			command: failure,
			commands,
		};
	}

	const checkout = await runVercelSandboxCommand(sandbox, {
		cmd: "git",
		args: ["checkout", "-B", branchName],
		cwd: repoPath,
	});
	commands.push({ command: `git checkout -B ${branchName}`, summary: checkout });
	if (checkout.exitCode !== 0) {
		return { command: checkout, commands };
	}

	const smokePath = `.rhapsody-smoke/${Date.now()}.txt`;
	const writeSmokeFile = await runVercelSandboxCommand(sandbox, {
		cmd: "sh",
		args: [
			"-lc",
			`mkdir -p .rhapsody-smoke && date +%FT%TZ > ${smokePath}`,
		],
		cwd: repoPath,
	});
	commands.push({
		command: `write smoke file ${smokePath}`,
		summary: writeSmokeFile,
	});
	if (writeSmokeFile.exitCode !== 0) {
		return { command: writeSmokeFile, commands };
	}

	const add = await runVercelSandboxCommand(sandbox, {
		cmd: "git",
		args: ["add", smokePath],
		cwd: repoPath,
	});
	commands.push({ command: `git add ${smokePath}`, summary: add });
	if (add.exitCode !== 0) {
		return { command: add, commands };
	}

	const statusBeforeCommit = await runVercelSandboxCommand(sandbox, {
		cmd: "git",
		args: ["status", "--short"],
		cwd: repoPath,
	});
	commands.push({
		command: GIT_SMOKE_STATUS_OPERATION,
		summary: statusBeforeCommit,
	});
	if (statusBeforeCommit.exitCode !== 0) {
		return { command: statusBeforeCommit, commands };
	}

	const commit = await runVercelSandboxCommand(sandbox, {
		cmd: "git",
		args: [
			"-c",
			"user.name=Rhapsody Smoke Test",
			"-c",
			"user.email=smoke@localhost",
			"commit",
			"-m",
			`chore(smoke): test write ${Date.now()}`,
		],
		cwd: repoPath,
	});
	commands.push({ command: "git commit", summary: commit });
	if (commit.exitCode !== 0) {
		return { command: commit, commands };
	}

	const push = await runVercelSandboxCommand(sandbox, {
		cmd: "git",
		args: ["push", "origin", `HEAD:${branchName}`],
		cwd: repoPath,
	});
	commands.push({
		command: GIT_SMOKE_PUSH_OPERATION.replace("<branchName>", branchName),
		summary: push,
	});
	return { command: push, commands };
}
