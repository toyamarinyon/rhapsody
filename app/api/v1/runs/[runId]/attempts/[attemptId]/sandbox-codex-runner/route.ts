import { buildCodexExecCommand } from "@/lib/codex/cli";
import {
	loadRhapsodyCodexBaseSnapshotEnv,
	loadRhapsodyConfig,
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
	runVercelSandboxCommand,
	stopVercelSandbox,
	writeVercelSandboxFiles,
	type RhapsodyVercelSandbox,
} from "@/lib/sandbox/vercel";
import { requireAdminAuth } from "@/lib/server/admin-auth";
import { isRecord } from "@/lib/server/json";
import {
	applyAttemptTerminalCallback,
	createEvent,
	createStateStoreClient,
	getRunDetail,
	markAttemptStarted,
} from "@/lib/state";

export const runtime = "nodejs";

const SANDBOX_WORKDIR = "/vercel/sandbox";
const COMMAND = "sandbox-codex-runner";
const WRAPPER_PATH = "wrapper.js";
const PROMPT_PATH = "prompt.txt";
const METADATA_PATH = "metadata.json";
const PROMPT_PREVIEW_LENGTH = 500;
const OUTPUT_PREVIEW_LENGTH = 1000;
const TIMEOUT_MS = 60_000;
const SMOKE_PROMPT_SUFFIX = `\n\nYou are running in smoke-test mode for Rhapsody.\n- Keep your response concise.\n- Do not edit files.\n`;

export async function POST(
	request: Request,
	context: { params: Promise<{ runId: string; attemptId: string }> },
) {
	const auth = requireAdminAuth(request);

	if (!auth.ok) {
		return auth.response;
	}

	const parsedBody = await readOptionalRequest(request);

	if (!parsedBody.ok) {
		return Response.json({ error: parsedBody.error }, { status: 400 });
	}

	const { runId, attemptId } = await context.params;
	const callbackBaseUrl = parsedBody.value.callbackBaseUrl ?? new URL(request.url).origin;
	const callbackUrl = new URL("/api/internal/runs/callback", callbackBaseUrl).toString();
	const client = createStateStoreClient();
	let sandbox: RhapsodyVercelSandbox | null = null;

	try {
		const detail = await getRunDetail(client, runId);

		if (!detail) {
			return Response.json({ error: "Run not found." }, { status: 404 });
		}

		const attempt = detail.attempts.find((candidate) => candidate.id === attemptId);

		if (!attempt) {
			return Response.json({ error: "Attempt not found." }, { status: 404 });
		}

		const config = loadRhapsodyConfig();
		const instructions = await loadRepositoryInstructions();
		const prompt = renderRepositoryInstructions({
			template: instructions.template,
			context: buildInstructionContext({ detail, attempt, config }),
		});
		const executionPrompt = `${prompt}${SMOKE_PROMPT_SUFFIX}`;
		const promptSummary = {
			instructionPath: instructions.instructionPath,
			length: executionPrompt.length,
			preview: executionPrompt.slice(0, PROMPT_PREVIEW_LENGTH),
		};

		if (isTerminalRunStatus(detail.run.status) || isTerminalAttemptStatus(attempt.status)) {
			return Response.json({
				idempotent: true,
				runStatus: detail.run.status,
				attemptStatus: attempt.status,
				prompt: promptSummary,
			});
		}

		const codexCommand = buildCodexExecCommand({
			cwd: SANDBOX_WORKDIR,
			prompt: executionPrompt,
			approvalPolicy: "never",
			sandboxMode: "read-only",
			json: true,
			skipGitRepoCheck: true,
			ephemeral: true,
			timeoutMs: TIMEOUT_MS,
		});
		const mediatorEnv = loadRhapsodyMediatorEnv();
		const protectionBypassEnv = loadRhapsodyProtectionBypassEnv();
		const codexBaseSnapshotEnv = loadRhapsodyCodexBaseSnapshotEnv();
		const sourceSnapshotId = codexBaseSnapshotEnv.RHAPSODY_CODEX_BASE_SNAPSHOT_ID ?? null;
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
							sandbox_id: sandbox.sandboxId,
							command: {
								command: codexCommand.command,
								argv: codexCommand.argv,
								cwd: codexCommand.cwd,
							},
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
			sandboxId: sandbox.sandboxId,
			command: COMMAND,
		});

		if (!startResult.applied) {
			return Response.json(
				{
					error: "Attempt could not be started.",
					prompt: promptSummary,
					sandboxId: sandbox.sandboxId,
					startResult,
				},
				{ status: 409 },
			);
		}

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
				sandboxId: sandbox.sandboxId,
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
				RHAPSODY_SANDBOX_ID: sandbox.sandboxId,
				RHAPSODY_COMMAND_ID: COMMAND,
			},
		});

		const wrapperCallback = parseWrapperStdout(command.stdout);
		const terminalFallback =
			command.exitCode === 0 && wrapperCallback?.callback_ok
				? null
				: await applyAttemptTerminalCallback(client, {
					runId,
					attemptId,
					claimToken,
					executionStatus: wrapperCallback?.codex_timed_out ? "timed_out" : command.exitCode === 0 ? "completed" : "failed",
					exitCode: command.exitCode,
					sandboxId: sandbox.sandboxId,
					command: COMMAND,
					error: buildFallbackError(command, wrapperCallback),
				});

		const refreshedDetail = await getRunDetail(client, runId);

		return Response.json({
			sandboxId: sandbox.sandboxId,
			command: summarizeCommand(command),
			sourceSnapshotId,
			prompt: {
				...promptSummary,
				eventId: promptEvent.id,
			},
			startResult,
			callback: {
				url: callbackUrl,
				parse: wrapperCallback,
				terminalFallback,
			},
			currentRunStatus: refreshedDetail?.run.status ?? null,
			currentAttemptStatus:
				refreshedDetail?.attempts.find((candidate) => candidate.id === attemptId)?.status ?? null,
		});
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
		client.close();

		if (sandbox) {
			await stopVercelSandbox(sandbox);
		}
	}
}

async function readOptionalRequest(
	request: Request,
): Promise<{ ok: true; value: { callbackBaseUrl?: string } } | { ok: false; error: string }> {
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

function buildWrapperSource() {
	return `const { spawn } = require("node:child_process");
const { readFile } = require("node:fs/promises");

function required(name) {
	const value = process.env[name];

	if (!value) {
		throw new Error("Missing required environment variable: " + name);
	}

	return value;
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

(async () => {
	const metadata = JSON.parse(await readFile("${METADATA_PATH}", "utf8"));
	const prompt = await readFile("${PROMPT_PATH}", "utf8");
	const callbackUrl = required("RHAPSODY_CALLBACK_URL");
	const runId = required("RHAPSODY_RUN_ID");
	const attemptId = required("RHAPSODY_ATTEMPT_ID");
	const claimToken = required("RHAPSODY_CLAIM_TOKEN");
	const sandboxId = required("RHAPSODY_SANDBOX_ID");
	const commandId = process.env.RHAPSODY_COMMAND_ID ?? "${COMMAND}";

	const child = spawn(metadata.command.command, metadata.command.argv, {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: metadata.command.cwd,
	});

	let stdout = "";
	let stderr = "";
	let exitCode = null;
	let spawnError = null;
	let timedOut = false;

	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString("utf8");
	});

	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString("utf8");
	});

	child.on("error", (error) => {
		spawnError = error.message;
	});

	child.stdin.end(prompt);

	const timeout = setTimeout(() => {
		timedOut = true;
		child.kill("SIGTERM");
		setTimeout(() => {
			if (exitCode === null) {
				child.kill("SIGKILL");
			}
		}, 5_000);
	}, ${TIMEOUT_MS});

	const wrappedExitCode = await new Promise((resolve) => {
		child.on("close", (code) => {
			resolve(code);
		});
	});
	clearTimeout(timeout);

	exitCode = wrappedExitCode;
	const callbackPayload = {
		run_id: runId,
		attempt_id: attemptId,
		claim_token: claimToken,
		execution_status: timedOut ? "timed_out" : exitCode === 0 ? "completed" : "failed",
		exit_code: exitCode,
		sandbox_id: sandboxId,
		command_id: commandId,
		completed_at: new Date().toISOString(),
		error:
			spawnError ??
			(timedOut
				? "Codex timed out after ${String(TIMEOUT_MS)}ms."
				: exitCode === 0
				? null
			: metadata.command && metadata.command.command
					? "Codex exited with code " + String(exitCode) + "."
					: "Codex command could not be launched."),
	};

	let callbackStatus = null;
	let callbackOk = false;
	let callbackBody = null;
	let callbackError = null;

	try {
		const response = await fetch(callbackUrl, {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify(callbackPayload),
		});
		const text = await response.text();
		callbackStatus = response.status;
		callbackOk = response.ok;
		callbackBody = safeJson(text);
	} catch (error) {
		callbackError = error instanceof Error ? error.message : String(error);
	}

	console.log(
		JSON.stringify({
			codex_exit_code: exitCode,
			codex_timed_out: timedOut,
			codex_stdout: stdout.slice(0, ${OUTPUT_PREVIEW_LENGTH}),
			codex_stderr: stderr.slice(0, ${OUTPUT_PREVIEW_LENGTH}),
			callback_status: callbackStatus,
			callback_ok: callbackOk,
			callback_body: callbackBody,
			callback_error: callbackError,
		}),
	);

	if (spawnError || timedOut || !callbackOk || exitCode !== 0) {
		process.exitCode = 1;
	}
})();
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

function buildFallbackError(
	command: Awaited<ReturnType<typeof runVercelSandboxCommand>>,
	wrapperCallback: ReturnType<typeof parseWrapperStdout>,
) {
	if (wrapperCallback && wrapperCallback.callback_ok === false) {
		return `Sandbox callback failed with HTTP ${String(wrapperCallback.callback_status)}.`;
	}

	if (command.exitCode === 0) {
		return "Sandbox runner wrapper exited successfully, but callback response was missing.";
	}

	return "Codex runner failed before recording a successful callback.";
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

function isTerminalRunStatus(status: string) {
	return status === "completed" || status === "failed" || status === "canceled" || status === "timed_out" || status === "stale";
}

function isTerminalAttemptStatus(status: string) {
	return status === "completed" || status === "failed" || status === "canceled" || status === "timed_out" || status === "stale";
}
