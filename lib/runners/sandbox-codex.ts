import path from "node:path";
import { readFile } from "node:fs/promises";
import { buildCodexExecCommand } from "@/lib/codex/cli";
import { buildCodexChatGPTDummyAuthFile } from "@/lib/codex/auth";
import { loadMediatorCredentialState } from "@/lib/codex/credentials";
import {
	loadRhapsodyCodexBaseSnapshotEnv,
	loadRhapsodyConfig,
	loadRhapsodyGitHubEnv,
	loadRhapsodyMediatorEnv,
	loadRhapsodyProtectionBypassEnv,
} from "@/lib/config";
import { loadRunnerCodexConfig } from "@/lib/runner-codex-config";
import {
	buildInstructionContext,
	InstructionTemplateError,
	loadRepositoryInstructions,
	renderRepositoryInstructions,
} from "@/lib/instructions";
import {
	createVercelSandbox,
	buildVercelSandboxCodexNetworkPolicy,
	buildVercelSandboxGitHubNetworkPolicy,
	mergeNetworkPolicies,
	getVercelSandboxId,
	runVercelSandboxCommand,
	startVercelSandboxCommand,
	stopVercelSandbox,
	writeVercelSandboxFiles,
	type RhapsodyVercelSandbox,
} from "@/lib/sandbox/vercel";
import { isRecord } from "@/lib/server/json";
import { createEvent, getRunDetail, markAttemptStarted } from "@/lib/state";
import {
	buildAttemptBranchName,
	parseWorkItemIssueNumber,
} from "@/lib/attempt-branch";
import { buildAttemptHookToken } from "@/lib/workflows/attempt-hook";
import { type RunnerRouteContext } from "./types";

const SANDBOX_WORKDIR = "/vercel/sandbox";
const CODEX_HOME_PATH = "/vercel/sandbox/.codex";
const COMMAND = "sandbox-codex-runner";
const WRAPPER_PATH = "wrapper.js";
const PROMPT_PATH = "prompt.txt";
const METADATA_PATH = "metadata.json";
const PR_SPEC_PATH = "/vercel/sandbox/rhapsody-output/pr.json";
const WRAPPER_SOURCE_PATH = path.join(
	process.cwd(),
	"lib",
	"runners",
	"sandbox-codex-wrapper",
	"wrapper.cjs",
);
const REPOSITORY_PATH = "/vercel/sandbox/repository";
const PROMPT_PREVIEW_LENGTH = 500;
const OUTPUT_PREVIEW_LENGTH = 1000;
const CODEX_TIMEOUT_MS = 10 * 60 * 1000;
const SANDBOX_SETUP_BUFFER_MS = 5 * 60 * 1000;
const SANDBOX_TIMEOUT_MS = CODEX_TIMEOUT_MS + SANDBOX_SETUP_BUFFER_MS;
const NETWORK_PROBE_URL =
	"https://chatgpt.com/backend-api/codex/models?client_version=0.130.0";
const NETWORK_PROBE_STDOUT_PREVIEW_LENGTH = 240;
const CODEX_MODE = "write";
const DUMMY_CHATGPT_ACCOUNT_ID = "acct_dummy";

type SourcePreparationSummary = {
	success: boolean;
	cloneCommand: Awaited<ReturnType<typeof runVercelSandboxCommand>>;
	checkoutCommand: Awaited<ReturnType<typeof runVercelSandboxCommand>> | null;
};

export async function runSandboxCodexRunner(
	context: RunnerRouteContext,
): Promise<Response> {
	const { client, request, runId, attemptId, detail, attempt } = context;
	const parsedBody = await readOptionalRequest(request);

	if (!parsedBody.ok) {
		return Response.json({ error: parsedBody.error }, { status: 400 });
	}

	const callbackBaseUrl =
		parsedBody.value.callbackBaseUrl ?? new URL(request.url).origin;
	const callbackUrl = new URL(
		"/api/internal/runs/callback",
		callbackBaseUrl,
	).toString();
	let sandbox: RhapsodyVercelSandbox | null = null;
	let shouldStopSandbox = true;

	try {
		const config = loadRhapsodyConfig();
		const runnerCodexConfig = await loadRunnerCodexConfig();
		const codexConfigOverrides = {
			model_provider: "openai-http",
			"model_providers.openai-http.name": "OpenAI without WebSockets",
			"model_providers.openai-http.requires_openai_auth": true,
			"model_providers.openai-http.supports_websockets": false,
			"model_providers.openai-http.wire_api": "responses",
			...(runnerCodexConfig.config
				? {
						model: runnerCodexConfig.config.model,
						...(runnerCodexConfig.config.reasoningEffort
							? {
									reasoning_effort:
										runnerCodexConfig.config.reasoningEffort,
								}
							: {}),
					}
				: {}),
		};
		const effectiveCodexConfig = {
			model: runnerCodexConfig.config?.model ?? null,
			reasoningEffort: runnerCodexConfig.config?.reasoningEffort ?? null,
			sourcePath: runnerCodexConfig.config
				? runnerCodexConfig.loadedFromPath
				: null,
		};
		const targetSandboxMode = "workspace-write";
		const instructions = await loadRepositoryInstructions();
		const prompt = renderRepositoryInstructions({
			template: instructions.template,
			context: buildInstructionContext({ detail, attempt, config }),
		});
		const expectedRepositoryUrl = `https://github.com/${config.repository.owner}/${config.repository.name}.git`;
		const fallbackBranchName = buildAttemptBranchName({
			branchPrefix: config.repository.branchPrefix,
			issueNumber: parseWorkItemIssueNumber({
				workItemId: detail.run.workItemId,
			}),
			attemptNumber: attempt.attemptNumber,
		});
		const requestedBranchName = attempt.gitBranchName ?? fallbackBranchName;
		const executionPrompt = buildExecutionPrompt({
			prompt,
			targetRepositoryUrl: expectedRepositoryUrl,
			targetBranchName: requestedBranchName,
			sandboxMode: targetSandboxMode,
		});
		const promptSummary = {
			instructionPath: instructions.instructionPath,
			length: executionPrompt.length,
			preview: executionPrompt.slice(0, PROMPT_PREVIEW_LENGTH),
		};

		if (
			isTerminalRunStatus(detail.run.status) ||
			isTerminalAttemptStatus(attempt.status)
		) {
			return Response.json({
				idempotent: true,
				runStatus: detail.run.status,
				attemptStatus: attempt.status,
				prompt: promptSummary,
			});
		}

		const codexCommand = buildCodexExecCommand({
			cwd: REPOSITORY_PATH,
			prompt: executionPrompt,
			approvalPolicy: "never",
			sandboxMode: targetSandboxMode,
			json: true,
			skipGitRepoCheck: true,
			ephemeral: true,
			dangerouslyBypassApprovalsAndSandbox: true,
			configOverrides: codexConfigOverrides,
			timeoutMs: CODEX_TIMEOUT_MS,
		});
		const mediatorEnv = loadRhapsodyMediatorEnv();
		const protectionBypassEnv = loadRhapsodyProtectionBypassEnv();
		const codexBaseSnapshotEnv = loadRhapsodyCodexBaseSnapshotEnv();
		const githubEnv = loadRhapsodyGitHubEnv();
		const mediatorCredentialState = await loadMediatorCredentialState();
		const sourceSnapshotId =
			parsedBody.value.useSnapshot === false
				? null
				: (codexBaseSnapshotEnv.RHAPSODY_CODEX_BASE_SNAPSHOT_ID ?? null);
		const claimToken = detail.run.claimToken;
		// Vercel Sandbox forwardURL requests must reach this mediator before OIDC can
		// authorize them. Preview Deployment Protection intercepts those requests, so
		// preview smoke tests temporarily disable Protection; production does not need
		// a workaround.
		const codexProxyUrl = new URL(
			`/api/internal/codex-chatgpt-proxy/runs/${runId}/attempts/${attemptId}`,
			callbackBaseUrl,
		).toString();
		const authPayload = buildCodexChatGPTDummyAuthFile(
			mediatorCredentialState?.accountId ?? DUMMY_CHATGPT_ACCOUNT_ID,
		);
		sandbox = await createVercelSandbox({
			timeout: SANDBOX_TIMEOUT_MS,
			networkPolicy: mergeNetworkPolicies(
				buildVercelSandboxCodexNetworkPolicy({
					callbackUrl,
					mediatorSecret: mediatorEnv.MEDIATOR_SECRET,
					codexProxyUrl,
					vercelProtectionBypassSecret:
						protectionBypassEnv.VERCEL_PROTECTION_BYPASS_SECRET,
					proxyChatGPTAccountApi: false,
				}),
				buildVercelSandboxGitHubNetworkPolicy({
					githubToken: githubEnv.GITHUB_TOKEN,
					authorizationHeaderPrefix: "basic",
				}),
			),
			...(sourceSnapshotId
				? {
						source: {
							type: "snapshot",
							snapshotId: sourceSnapshotId,
						},
					}
				: {}),
		});
		const wrapperSource = await readFile(WRAPPER_SOURCE_PATH, "utf8");

		await writeVercelSandboxFiles(sandbox, [
			{
				path: WRAPPER_PATH,
				content: Buffer.from(wrapperSource, "utf8"),
				mode: 0o644,
			},
			{
				path: PROMPT_PATH,
				content: Buffer.from(executionPrompt, "utf8"),
				mode: 0o600,
			},
			{
				path: METADATA_PATH,
				content: Buffer.from(
					JSON.stringify(
						{
							run_id: runId,
							attempt_id: attemptId,
							sandbox_id: getVercelSandboxId(sandbox),
							command: {
								command: codexCommand.command,
								argv: codexCommand.argv,
								cwd: codexCommand.cwd,
							},
							runner_codex_config: effectiveCodexConfig,
							codex_mode: CODEX_MODE,
							target_repository: expectedRepositoryUrl,
							target_branch: requestedBranchName,
							base_branch: config.repository.defaultBranch,
							repository_path: REPOSITORY_PATH,
							source_snapshot_id: sourceSnapshotId,
						},
						null,
						2,
					),
					"utf8",
				),
				mode: 0o600,
			},
			{
				path: `${CODEX_HOME_PATH}/auth.json`,
				content: Buffer.from(JSON.stringify(authPayload, null, 2), "utf8"),
				mode: 0o600,
			},
		]);

		const startResult = await markAttemptStarted(client, {
			runId,
			attemptId,
			gitBranchName: requestedBranchName,
			claimToken,
			sandboxId: getVercelSandboxId(sandbox),
			command: COMMAND,
		});

		const refreshedAttempt = (await getRunDetail(client, runId))?.attempts.find(
			(candidate) => candidate.id === attemptId,
		);
		const branchName =
			refreshedAttempt?.gitBranchName ||
			attempt.gitBranchName ||
			requestedBranchName;

		if (!startResult.applied) {
			return Response.json(
				{
					error: "Attempt could not be started.",
					prompt: promptSummary,
					sandboxId: getVercelSandboxId(sandbox),
					startResult,
				},
				{ status: 409 },
			);
		}

		if (!branchName) {
			return Response.json(
				{
					error:
						"Attempt branch name is required for source preparation. Retry start flow to seed a deterministic branch name.",
				},
				{ status: 409 },
			);
		}

		const sourcePreparationSummary = await prepareSourceInSandbox({
			sandbox,
			repositoryUrl: expectedRepositoryUrl,
			branchName,
		});
		await createEvent(client, {
			runId,
			attemptId,
			level: sourcePreparationSummary.success ? "info" : "error",
			type: "sandbox_codex_runner.source_preparation",
			message: "Prepared repository source for the attempt.",
			data: {
				repositoryUrl: expectedRepositoryUrl,
				branchName,
				codexMode: CODEX_MODE,
				commands: {
					clone: summarizeCommand(sourcePreparationSummary.cloneCommand),
					checkout: sourcePreparationSummary.checkoutCommand
						? summarizeCommand(sourcePreparationSummary.checkoutCommand)
						: null,
				},
				success: sourcePreparationSummary.success,
			},
		});

		if (!sourcePreparationSummary.success) {
			return Response.json(
				{
					error: "Source preparation failed.",
					repositoryUrl: expectedRepositoryUrl,
					branchName,
				},
				{ status: 500 },
			);
		}

		const networkProbeSummary = await runNetworkPolicyProbe(sandbox);
		await createEvent(client, {
			runId,
			attemptId,
			level: "info",
			type: "sandbox_codex_runner.network_probe",
			message: "Ran network policy probe for chatgpt backend path.",
			data: {
				...networkProbeSummary,
			},
		});

		const promptEvent = await createEvent(client, {
			runId,
			attemptId,
			level: "info",
			type: "sandbox_codex_runner.prompt_rendered",
			message: "Sandbox Codex runner rendered prompt.",
			data: {
				command: COMMAND,
				promptLength: executionPrompt.length,
				previewLength: promptSummary.preview.length,
				sandboxId: getVercelSandboxId(sandbox),
				sourceSnapshotId,
				codexMode: CODEX_MODE,
				runnerCodexConfig: effectiveCodexConfig,
				targetBranchName: branchName,
				targetRepositoryUrl: expectedRepositoryUrl,
				useSnapshot: sourceSnapshotId !== null,
			},
		});
		const hookToken =
			parsedBody.value.hookToken ?? buildAttemptHookToken(attemptId);
		const command = await startVercelSandboxCommand(sandbox, {
			cmd: "node",
			args: [WRAPPER_PATH],
			cwd: SANDBOX_WORKDIR,
			env: {
				CODEX_HOME: CODEX_HOME_PATH,
				RHAPSODY_CALLBACK_URL: callbackUrl,
				RHAPSODY_RUN_ID: runId,
				RHAPSODY_ATTEMPT_ID: attemptId,
				RHAPSODY_CLAIM_TOKEN: claimToken,
				RHAPSODY_SANDBOX_ID: getVercelSandboxId(sandbox),
				RHAPSODY_HOOK_TOKEN: hookToken,
				RHAPSODY_PROMPT_PATH: PROMPT_PATH,
				RHAPSODY_METADATA_PATH: METADATA_PATH,
				RHAPSODY_PR_SPEC_PATH: PR_SPEC_PATH,
				RHAPSODY_OUTPUT_PREVIEW_LENGTH: String(OUTPUT_PREVIEW_LENGTH),
				RHAPSODY_CODEX_TIMEOUT_MS: String(CODEX_TIMEOUT_MS),
			},
		});
		shouldStopSandbox = false;

		await createEvent(client, {
			runId,
			attemptId,
			level: "info",
			type: "sandbox_codex_runner.wrapper_started",
			message: "Sandbox Codex wrapper command started.",
			data: {
				sandboxId: getVercelSandboxId(sandbox),
				commandId: command.commandId,
				cwd: command.cwd,
				startedAt: command.startedAt,
				hookToken,
				callbackUrl,
			},
		});

		const refreshedDetail = await getRunDetail(client, runId);
		const responseBody = {
			sandboxId: getVercelSandboxId(sandbox),
			mode: CODEX_MODE,
			branchName,
			command,
			hookToken,
			sourceSnapshotId,
			runnerCodexConfig: effectiveCodexConfig,
			prompt: {
				...promptSummary,
				eventId: promptEvent.id,
			},
			startResult,
			callback: {
				url: callbackUrl,
			},
			currentRunStatus: refreshedDetail?.run.status ?? null,
			currentAttemptStatus:
				refreshedDetail?.attempts.find(
					(candidate) => candidate.id === attemptId,
				)?.status ?? null,
		};

		return Response.json(responseBody);
	} catch (error) {
		if (error instanceof InstructionTemplateError) {
			return Response.json({ error: error.message }, { status: 422 });
		}

		return Response.json(
			{
				error: "Sandbox Codex runner failed.",
				detail: serializeError(error),
			},
			{ status: 500 },
		);
	} finally {
		if (sandbox && shouldStopSandbox) {
			await stopVercelSandbox(sandbox);
		}
	}
}

async function readOptionalRequest(request: Request): Promise<
	| {
			ok: true;
			value: {
				callbackBaseUrl?: string;
				hookToken?: string;
				useSnapshot?: boolean;
			};
	  }
	| { ok: false; error: string }
> {
	const text = await request.text();

	if (!text.trim()) {
		return { ok: true, value: {} };
	}

	let value: unknown;

	try {
		value = JSON.parse(text);
	} catch {
		return {
			ok: false,
			error: "Request body must be valid JSON when provided.",
		};
	}

	if (!isRecord(value)) {
		return { ok: false, error: "Request body must be a JSON object." };
	}

	if (value.callbackBaseUrl === undefined) {
		return parseSandboxCodexRequestOptions(value);
	}

	if (
		typeof value.callbackBaseUrl !== "string" ||
		!value.callbackBaseUrl.trim()
	) {
		return {
			ok: false,
			error: "callbackBaseUrl must be a non-empty string when provided.",
		};
	}

	try {
		const parsed = new URL(value.callbackBaseUrl);

		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return { ok: false, error: "callbackBaseUrl must use http or https." };
		}
		return parseSandboxCodexRequestOptions({
			...value,
			callbackBaseUrl: parsed.origin,
		});
	} catch {
		return { ok: false, error: "callbackBaseUrl must be a valid URL." };
	}
}

function parseSandboxCodexRequestOptions(value: Record<string, unknown>):
	| {
			ok: true;
			value: {
				callbackBaseUrl?: string;
				hookToken?: string;
				useSnapshot?: boolean;
			};
	  }
	| { ok: false; error: string } {
	const result: {
		callbackBaseUrl?: string;
		hookToken?: string;
		useSnapshot?: boolean;
	} = {};

	if (value.callbackBaseUrl !== undefined) {
		result.callbackBaseUrl = value.callbackBaseUrl as string;
	}

	if (value.hookToken !== undefined) {
		if (typeof value.hookToken !== "string" || !value.hookToken.trim()) {
			return {
				ok: false,
				error: "hookToken must be a non-empty string when provided.",
			};
		}

		result.hookToken = value.hookToken;
	}

	if (value.useSnapshot !== undefined) {
		if (typeof value.useSnapshot !== "boolean") {
			return {
				ok: false,
				error: "useSnapshot must be a boolean when provided.",
			};
		}

		result.useSnapshot = value.useSnapshot;
	}

	if (value.mode !== undefined) {
		return {
			ok: false,
			error:
				"mode is no longer supported; sandbox-codex always runs write mode.",
		};
	}

	return { ok: true, value: result };
}

function buildExecutionPrompt(params: {
	prompt: string;
	targetRepositoryUrl: string;
	targetBranchName: string;
	sandboxMode: "read-only" | "workspace-write";
}) {
	const modeInstructions = `\n\nYou are running in write mode for this Rhapsody run.\n- Working repository: ${params.targetRepositoryUrl}\n- Assigned branch: ${params.targetBranchName}\n- Do not push to any branch other than the assigned branch.\n- Make focused changes only for the selected work item.\n- If git commit needs an identity, set local repository config only: user.name \"Rhapsody Codex\" and user.email \"rhapsody-codex@localhost\".\n- When changes are needed, you must create a commit and run: git push origin HEAD:${params.targetBranchName}\n- After pushing, verify the remote branch exists with: git ls-remote --heads origin ${params.targetBranchName}\n- After creating the commit and push, write a PR handoff file at ${PR_SPEC_PATH} containing JSON with this exact shape:\n  { \"title\": \"<string>\", \"body\": \"<string>\" }\n  both fields must be non-empty.\n- Do not call GitHub APIs or create PRs directly.\n`;

	return `${params.prompt}${modeInstructions}\n- Current sandbox mode: ${params.sandboxMode}.`;
}

async function prepareSourceInSandbox({
	sandbox,
	repositoryUrl,
	branchName,
}: {
	sandbox: RhapsodyVercelSandbox;
	repositoryUrl: string;
	branchName: string;
}): Promise<SourcePreparationSummary> {
	await runVercelSandboxCommand(sandbox, {
		cmd: "rm",
		args: ["-rf", REPOSITORY_PATH],
		cwd: SANDBOX_WORKDIR,
	});

	const cloneCommand = await runVercelSandboxCommand(sandbox, {
		cmd: "git",
		args: ["clone", "--depth", "1", repositoryUrl, REPOSITORY_PATH],
		cwd: SANDBOX_WORKDIR,
	});

	if (cloneCommand.exitCode !== 0) {
		return {
			success: false,
			cloneCommand,
			checkoutCommand: null,
		};
	}

	const checkoutCommand = await runVercelSandboxCommand(sandbox, {
		cmd: "git",
		args: ["-C", REPOSITORY_PATH, "checkout", "-B", branchName],
		cwd: SANDBOX_WORKDIR,
	});

	return {
		success: checkoutCommand.exitCode === 0,
		cloneCommand,
		checkoutCommand,
	};
}

function summarizeCommand(
	command: Awaited<ReturnType<typeof runVercelSandboxCommand>>,
) {
	return {
		commandId: command.commandId,
		cwd: command.cwd,
		startedAt: command.startedAt,
		exitCode: command.exitCode,
		stdoutLength: command.stdout.length,
		stdoutPreview: command.stdout.slice(0, OUTPUT_PREVIEW_LENGTH),
		stderrLength: command.stderr.length,
		stderrPreview: command.stderr.slice(0, OUTPUT_PREVIEW_LENGTH),
	};
}

async function runNetworkPolicyProbe(sandbox: RhapsodyVercelSandbox) {
	const command = await runVercelSandboxCommand(sandbox, {
		cmd: "node",
		args: ["-e", buildNetworkProbeScript()],
		cwd: SANDBOX_WORKDIR,
	});

	const probeOutput = parseProbeOutput(command.stdout);
	const responseSourceHint = probeOutput?.looksLikeRhapsodyProxy ?? null;
	const bodyPreview = probeOutput?.bodyPreview ?? null;
	const bodyLength = probeOutput?.bodyLength ?? null;
	const commandId = command.commandId;
	const cwd = command.cwd;

	return {
		exitCode: command.exitCode,
		commandId,
		cwd,
		startedAt: command.startedAt,
		probeStatus: probeOutput?.status ?? null,
		probeStatusText: probeOutput?.statusText ?? null,
		contentType: probeOutput?.contentType ?? null,
		bodyLength,
		bodyPreview,
		stdoutLength: command.stdout.length,
		stderrLength: command.stderr.length,
		stdoutPreview: command.stdout.slice(0, OUTPUT_PREVIEW_LENGTH),
		stderrPreview: command.stderr.slice(0, OUTPUT_PREVIEW_LENGTH),
		responseLooksLikeProxy: responseSourceHint,
	};
}

function buildNetworkProbeScript() {
	return `
const url = "${NETWORK_PROBE_URL}";

(async () => {
	try {
		const response = await fetch(url, { method: "GET" });
		const body = await response.text();
		const bodyPreview = body.slice(0, ${NETWORK_PROBE_STDOUT_PREVIEW_LENGTH});
		const contentType = response.headers.get("content-type");
		const looksLikeRhapsodyProxy = response.headers.get("x-rhapsody-proxy") === "codex-chatgpt";

		console.log(
			JSON.stringify({
				status: response.status,
				statusText: response.statusText,
				contentType,
				bodyLength: body.length,
				bodyPreview,
				looksLikeRhapsodyProxy,
			}),
		);
	} catch (error) {
		console.log(
			JSON.stringify({
				error: error instanceof Error ? error.message : String(error),
				status: null,
			}),
		);
	}
})();
`;
}

function parseProbeOutput(stdout: string) {
	const line = stdout
		.trim()
		.split("\\n")
		.findLast((candidate) => candidate.trim().startsWith("{"));

	if (!line) {
		return null;
	}

	try {
		const parsed = JSON.parse(line) as {
			status: number | null;
			statusText?: string | null;
			contentType?: string | null;
			bodyLength?: number | null;
			bodyPreview?: string | null;
			looksLikeRhapsodyProxy?: boolean;
			error?: string;
		};

		if (typeof parsed.error === "string") {
			return { status: null, error: parsed.error };
		}

		return {
			status: parsed.status ?? null,
			statusText: parsed.statusText ?? null,
			contentType: parsed.contentType ?? null,
			bodyLength: parsed.bodyLength ?? null,
			bodyPreview:
				typeof parsed.bodyPreview === "string" ? parsed.bodyPreview : null,
			looksLikeRhapsodyProxy: Boolean(parsed.looksLikeRhapsodyProxy),
		};
	} catch {
		return null;
	}
}

function serializeError(error: unknown) {
	if (error instanceof Error) {
		const maybeApiError = error as Error & {
			response?: { status?: number; statusText?: string };
			text?: string;
			json?: unknown;
		};

		return {
			name: error.name,
			message: error.message,
			responseStatus: maybeApiError.response?.status,
			responseStatusText: maybeApiError.response?.statusText,
			text: maybeApiError.text,
			json: maybeApiError.json,
		};
	}

	return {
		name: "UnknownError",
		message: String(error),
	};
}

function isTerminalRunStatus(status: string) {
	return (
		status === "completed" ||
		status === "failed" ||
		status === "canceled" ||
		status === "timed_out" ||
		status === "stale"
	);
}

function isTerminalAttemptStatus(status: string) {
	return (
		status === "completed" ||
		status === "failed" ||
		status === "canceled" ||
		status === "timed_out" ||
		status === "stale"
	);
}
