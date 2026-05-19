import {
	loadRhapsodyConfig,
	loadRhapsodyCodexBaseSnapshotEnv,
	loadRhapsodyMediatorEnv,
	loadRhapsodyProtectionBypassEnv,
} from "@/lib/config";
import {
	buildInstructionContext,
	InstructionTemplateError,
	loadRepositoryInstructions,
	renderRepositoryInstructions,
} from "@/lib/instructions";
import {
	createVercelSandbox,
	buildVercelSandboxCallbackNetworkPolicy,
	getVercelSandboxId,
	runVercelSandboxCommand,
	stopVercelSandbox,
	writeVercelSandboxFiles,
	type RhapsodyVercelSandbox,
} from "@/lib/sandbox/vercel";
import { isRecord } from "@/lib/server/json";
import {
	createEvent,
	applyAttemptTerminalCallback,
	markAttemptStarted,
	getRunDetail,
} from "@/lib/state";
import { type RunnerRouteContext } from "./types";

const SANDBOX_FAKE_RUNNER_COMMAND = "sandbox-fake-runner";
const SANDBOX_WORKDIR = "/vercel/sandbox";
const WRAPPER_PATH = "wrapper.js";
const PROMPT_PATH = "prompt.txt";
const METADATA_PATH = "metadata.json";
const PROMPT_PREVIEW_LENGTH = 500;
const OUTPUT_PREVIEW_LENGTH = 1000;

type SandboxFakeRunnerRequest = {
	callbackBaseUrl?: string;
};

export async function runSandboxFakeRunner(context: RunnerRouteContext): Promise<Response> {
	const { client, request, runId, attemptId, detail, attempt } = context;
	const parsedBody = await readOptionalSandboxFakeRunnerRequest(request);

	if (!parsedBody.ok) {
		return Response.json({ error: parsedBody.error }, { status: 400 });
	}

	const callbackBaseUrl = parsedBody.value.callbackBaseUrl ?? new URL(request.url).origin;
	const callbackUrl = new URL("/api/internal/runs/callback", callbackBaseUrl).toString();
	let sandbox: RhapsodyVercelSandbox | null = null;

	try {
		const config = loadRhapsodyConfig();
		const mediatorEnv = loadRhapsodyMediatorEnv();
		const protectionBypassEnv = loadRhapsodyProtectionBypassEnv();
		const codexBaseSnapshotEnv = loadRhapsodyCodexBaseSnapshotEnv();
		const sourceSnapshotId = codexBaseSnapshotEnv.RHAPSODY_CODEX_BASE_SNAPSHOT_ID ?? null;
		const instructions = await loadRepositoryInstructions();
		const prompt = renderRepositoryInstructions({
			template: instructions.template,
			context: buildInstructionContext({ detail, attempt, config }),
		});
		const promptSummary = {
			instructionPath: instructions.instructionPath,
			length: prompt.length,
			preview: prompt.slice(0, PROMPT_PREVIEW_LENGTH),
		};

		if (isTerminalRunStatus(detail.run.status) || isTerminalAttemptStatus(attempt.status)) {
			return Response.json({
				idempotent: true,
				runStatus: detail.run.status,
				attemptStatus: attempt.status,
				prompt: promptSummary,
			});
		}

		const claimToken = detail.run.claimToken;

		sandbox = await createVercelSandbox({
			networkPolicy: buildVercelSandboxCallbackNetworkPolicy({
				callbackUrl,
				mediatorSecret: mediatorEnv.MEDIATOR_SECRET,
				vercelProtectionBypassSecret: protectionBypassEnv.VERCEL_PROTECTION_BYPASS_SECRET,
			}),
			...(sourceSnapshotId
				? {
						source: {
							type: "snapshot",
							snapshotId: sourceSnapshotId,
						},
					}
				: {}),
		});

		await writeVercelSandboxFiles(sandbox, [
			{
				path: WRAPPER_PATH,
				content: Buffer.from(buildWrapperSource(), "utf8"),
				mode: 0o644,
			},
			{
				path: PROMPT_PATH,
				content: Buffer.from(prompt, "utf8"),
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
							command: SANDBOX_FAKE_RUNNER_COMMAND,
							prompt_path: PROMPT_PATH,
							callback_url: callbackUrl,
							source_snapshot_id: sourceSnapshotId,
						},
						null,
						2,
					),
					"utf8",
				),
				mode: 0o600,
			},
		]);

		const startResult = await markAttemptStarted(client, {
			runId,
			attemptId,
			claimToken,
			sandboxId: getVercelSandboxId(sandbox),
			command: SANDBOX_FAKE_RUNNER_COMMAND,
		});

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

		const promptEvent = await createEvent(client, {
			runId,
			attemptId,
			level: "info",
			type: "sandbox_fake_runner.prompt_rendered",
			message: "Sandbox fake runner rendered prompt.",
			data: {
				instructionPath: instructions.instructionPath,
				promptLength: prompt.length,
				previewLength: promptSummary.preview.length,
				sandboxId: getVercelSandboxId(sandbox),
				sourceSnapshotId,
			},
		});
		const command = await runVercelSandboxCommand(sandbox, {
			cmd: "node",
			args: [WRAPPER_PATH],
			cwd: SANDBOX_WORKDIR,
			env: {
				RHAPSODY_CALLBACK_URL: callbackUrl,
				RHAPSODY_RUN_ID: runId,
				RHAPSODY_ATTEMPT_ID: attemptId,
				RHAPSODY_CLAIM_TOKEN: claimToken,
				RHAPSODY_SANDBOX_ID: getVercelSandboxId(sandbox),
				RHAPSODY_COMMAND_ID: SANDBOX_FAKE_RUNNER_COMMAND,
			},
		});
		const wrapperCallback = parseWrapperStdout(command.stdout);
		const terminalFallback =
			command.exitCode === 0
				? null
				: await applyAttemptTerminalCallback(client, {
						runId,
						attemptId,
						claimToken,
						executionStatus: "failed",
						exitCode: command.exitCode,
						sandboxId: getVercelSandboxId(sandbox),
						command: SANDBOX_FAKE_RUNNER_COMMAND,
						error:
							wrapperCallback?.callback_ok === false
								? `Sandbox callback failed with HTTP ${String(wrapperCallback.callback_status)}.`
								: "Sandbox fake runner command failed before recording a successful callback.",
					});
		const refreshedDetail = await getRunDetail(client, runId);

		return Response.json({
			sandboxId: getVercelSandboxId(sandbox),
			command: summarizeCommand(command),
			sourceSnapshotId,
			prompt: {
				...promptSummary,
				eventId: promptEvent.id,
			},
			startResult,
			callback: {
				url: callbackUrl,
				stdout: wrapperCallback,
				terminalFallback,
				currentRunStatus: refreshedDetail?.run.status ?? null,
				currentAttemptStatus:
					refreshedDetail?.attempts.find((candidate) => candidate.id === attemptId)?.status ?? null,
			},
		});
	} catch (error) {
		if (error instanceof InstructionTemplateError) {
			return Response.json({ error: error.message }, { status: 422 });
		}

		return Response.json(
			{
				error: "Sandbox fake runner failed.",
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

async function readOptionalSandboxFakeRunnerRequest(
	request: Request,
): Promise<{ ok: true; value: SandboxFakeRunnerRequest } | { ok: false; error: string }> {
	const text = await request.text();

	if (!text.trim()) {
		return { ok: true, value: {} };
	}

	let value: unknown;

	try {
		value = JSON.parse(text);
	} catch {
		return { ok: false, error: "Request body must be valid JSON when provided." };
	}

	if (!isRecord(value)) {
		return { ok: false, error: "Request body must be a JSON object." };
	}

	if (value.callbackBaseUrl === undefined) {
		return { ok: true, value: {} };
	}

	if (typeof value.callbackBaseUrl !== "string" || !value.callbackBaseUrl.trim()) {
		return { ok: false, error: "callbackBaseUrl must be a non-empty string when provided." };
	}

	try {
		const parsed = new URL(value.callbackBaseUrl);

		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return { ok: false, error: "callbackBaseUrl must use http or https." };
		}

		return { ok: true, value: { callbackBaseUrl: parsed.origin } };
	} catch {
		return { ok: false, error: "callbackBaseUrl must be a valid URL." };
	}
}

function serializeError(error: unknown) {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
		};
	}

	return {
		name: "UnknownError",
		message: String(error),
	};
}

function buildWrapperSource() {
	return `const required = (name) => {
	const value = process.env[name];

	if (!value) {
		throw new Error(\`Missing required environment variable: \${name}\`);
	}

	return value;
};

const callbackUrl = required("RHAPSODY_CALLBACK_URL");
const payload = {
	run_id: required("RHAPSODY_RUN_ID"),
	attempt_id: required("RHAPSODY_ATTEMPT_ID"),
	claim_token: required("RHAPSODY_CLAIM_TOKEN"),
	execution_status: "completed",
	exit_code: 0,
	sandbox_id: required("RHAPSODY_SANDBOX_ID"),
	command_id: process.env.RHAPSODY_COMMAND_ID ?? null,
	completed_at: new Date().toISOString(),
	error: null,
};

const response = await fetch(callbackUrl, {
	method: "POST",
	headers: {
		"content-type": "application/json",
	},
	body: JSON.stringify(payload),
});
const text = await response.text();

console.log(JSON.stringify({
	callback_status: response.status,
	callback_ok: response.ok,
	callback_body: safeJson(text),
}));

if (!response.ok) {
	process.exitCode = 1;
}

function safeJson(text) {
	if (!text) {
		return null;
	}

	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}
`;
}

function summarizeCommand(command: Awaited<ReturnType<typeof runVercelSandboxCommand>>) {
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

function parseWrapperStdout(stdout: string) {
	const line = stdout
		.trim()
		.split("\n")
		.findLast((candidate) => candidate.trim().startsWith("{"));

	if (!line) {
		return null;
	}

	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

function isTerminalRunStatus(status: string) {
	return status === "completed" || status === "failed" || status === "canceled" || status === "timed_out" || status === "stale";
}

function isTerminalAttemptStatus(status: string) {
	return status === "completed" || status === "failed" || status === "canceled" || status === "timed_out" || status === "stale";
}
