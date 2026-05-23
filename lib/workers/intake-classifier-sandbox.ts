import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildCodexChatGPTDummyAuthFile } from "@/lib/codex/auth";
import { buildCodexExecCommand } from "@/lib/codex/cli";
import { loadMediatorCredentialState } from "@/lib/codex/credentials";
import {
	loadRhapsodyCodexBaseSnapshotEnv,
	loadRhapsodyMediatorEnv,
	loadRhapsodyProtectionBypassEnv,
} from "@/lib/config";
import {
	buildVercelSandboxCodexNetworkPolicy,
	createVercelSandbox,
	type RhapsodyVercelSandbox,
	runVercelSandboxCommand,
	stopVercelSandbox,
	writeVercelSandboxFiles,
} from "@/lib/sandbox/vercel";

const SANDBOX_WORKDIR = "/vercel/sandbox";
const CODEX_HOME_PATH = `${SANDBOX_WORKDIR}/.codex`;
const PROMPT_PATH = "intake-classifier/prompt.txt";
const SCHEMA_PATH = "intake-classifier/schema.json";
const WRAPPER_PATH = "intake-classifier/wrapper.cjs";
const METADATA_PATH = "intake-classifier/metadata.json";
const OUTPUT_MESSAGE_PATH = "intake-classifier/output.json";
const DUMMY_CHATGPT_ACCOUNT_ID = "acct_dummy";
const DEFAULT_CLASSIFIER_TIMEOUT_MS = 120_000;
const PREVIEW_LENGTH = 500;
const DEFAULT_WRAPPER_TIMEOUT_BUFFER_MS = 5_000;

const INTAKE_CLASSIFIER_WRAPPER_SOURCE = `
(async () => {
	const { spawn } = require("node:child_process");
	const { readFile } = require("node:fs/promises");

	const PROMPT_PATH = process.env.RHAPSODY_PROMPT_PATH;
	const METADATA_PATH = process.env.RHAPSODY_INTAKE_CLASSIFIER_METADATA_PATH;
	const PREVIEW_LENGTH = Number.parseInt(
		process.env.RHAPSODY_OUTPUT_PREVIEW_LENGTH ?? "500",
	);
	const COMMAND_TIMEOUT_MS = Number.parseInt(
		process.env.RHAPSODY_CODEX_TIMEOUT_MS ?? "120000",
	);

	if (!PROMPT_PATH || !METADATA_PATH) {
		throw new Error(
			"Missing required intake classifier wrapper environment variables.",
		);
	}

	function buildCodexChildEnv() {
		const env = { ...process.env };

		for (const name of Object.keys(env)) {
			if (name.startsWith("RHAPSODY_")) {
				delete env[name];
			}
		}

		env.CODEX_HOME = process.env.CODEX_HOME;
		return env;
	}

	const rawMetadata = await readFile(METADATA_PATH, "utf8");
	const metadata = JSON.parse(rawMetadata);

	const child = spawn(metadata.command.command, metadata.command.argv, {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: metadata.command.cwd,
		env: buildCodexChildEnv(),
	});

	let stdout = "";
	let stderr = "";
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

	const prompt = await readFile(PROMPT_PATH, "utf8");
	child.stdin.end(prompt);

	const timeout = setTimeout(() => {
		timedOut = true;
		child.kill("SIGTERM");
		setTimeout(() => {
			if (!child.exitCode) {
				child.kill("SIGKILL");
			}
		}, 5_000);
	}, COMMAND_TIMEOUT_MS);

	const exitCode = await new Promise((resolve) => {
		child.on("close", (code) => {
			resolve(code);
		});
	});

	clearTimeout(timeout);

	console.log(
		JSON.stringify({
			exit_code: typeof exitCode === "number" ? exitCode : -1,
			timed_out: timedOut,
			stdout: stdout.slice(0, PREVIEW_LENGTH),
			stderr: stderr.slice(0, PREVIEW_LENGTH),
			error:
				spawnError ??
				(timedOut
					? "Codex execution timed out in intake wrapper."
					: null),
		}),
	);

	if (spawnError || timedOut || exitCode !== 0) {
		process.exitCode = 1;
	}
})();
`;

export type IntakeClassifierSandboxResult = {
	raw: string;
	command: string;
	rawOutputAvailable: boolean;
	runner: {
		exitCode: number;
		signal: string | null;
		timedOut: boolean;
		durationMs: number;
		stdoutPreview?: string;
		stderrPreview?: string;
		error?: string;
	};
};

export type IntakeClassifierSandboxDependencies = {
	createVercelSandbox: typeof createVercelSandbox;
	runVercelSandboxCommand: typeof runVercelSandboxCommand;
	stopVercelSandbox: typeof stopVercelSandbox;
	writeVercelSandboxFiles: typeof writeVercelSandboxFiles;
	loadMediatorCredentialState: typeof loadMediatorCredentialState;
	loadRhapsodyMediatorEnv: typeof loadRhapsodyMediatorEnv;
	loadRhapsodyProtectionBypassEnv: typeof loadRhapsodyProtectionBypassEnv;
	loadRhapsodyCodexBaseSnapshotEnv: typeof loadRhapsodyCodexBaseSnapshotEnv;
};

export type IntakeClassifierSandboxOptions = {
	prompt: string;
	schemaFilePath: string;
	workerRunId?: string;
	workItemId?: string;
	dependencies?: Partial<IntakeClassifierSandboxDependencies>;
};

const defaultDependencies: IntakeClassifierSandboxDependencies = {
	createVercelSandbox,
	runVercelSandboxCommand,
	stopVercelSandbox,
	writeVercelSandboxFiles,
	loadMediatorCredentialState,
	loadRhapsodyMediatorEnv,
	loadRhapsodyProtectionBypassEnv,
	loadRhapsodyCodexBaseSnapshotEnv,
};

function buildOutputReadPath() {
	return path.join(SANDBOX_WORKDIR, OUTPUT_MESSAGE_PATH);
}

function sanitizePathSegment(value: string) {
	if (!value) {
		return value;
	}

	try {
		return encodeURIComponent(value);
	} catch {
		return value;
	}
}

export async function runIntakeClassifierInSandbox(
	input: IntakeClassifierSandboxOptions,
): Promise<IntakeClassifierSandboxResult> {
	const dependencies = {
		...defaultDependencies,
		...input.dependencies,
	} as IntakeClassifierSandboxDependencies;
	const origin = buildMediatorOrigin();
	const callbackUrl = new URL("/api/internal/runs/callback", origin).toString();
	const codexProxyUrl = new URL(
		`/api/internal/codex-chatgpt-proxy/runs/${input.workerRunId || "intake-worker-run"}/attempts/${sanitizePathSegment(
			input.workItemId || "intake",
		)}`,
		origin,
	).toString();

	const mediatorEnv = dependencies.loadRhapsodyMediatorEnv();
	const protectionBypassEnv = dependencies.loadRhapsodyProtectionBypassEnv();
	const codexBaseSnapshotEnv = dependencies.loadRhapsodyCodexBaseSnapshotEnv();
	const mediatorCredentialState =
		await dependencies.loadMediatorCredentialState();
	const sourceSnapshotId =
		codexBaseSnapshotEnv.RHAPSODY_CODEX_BASE_SNAPSHOT_ID ?? null;

	const schemaText = await readFile(input.schemaFilePath, "utf8");
	const authPayload = buildCodexChatGPTDummyAuthFile(
		mediatorCredentialState?.accountId ?? DUMMY_CHATGPT_ACCOUNT_ID,
	);

	let sandbox: RhapsodyVercelSandbox | null = null;
	const startedAt = Date.now();
	const outputMessagePath = buildOutputReadPath();
	const promptPath = path.join(SANDBOX_WORKDIR, PROMPT_PATH);
	const metadataPath = path.join(SANDBOX_WORKDIR, METADATA_PATH);
	const wrapperPath = path.join(SANDBOX_WORKDIR, WRAPPER_PATH);
	const command = buildCodexExecCommand({
		cwd: SANDBOX_WORKDIR,
		prompt: input.prompt,
		approvalPolicy: "never",
		sandboxMode: "workspace-write",
		json: true,
		skipGitRepoCheck: true,
		outputSchemaFile: path.join(SANDBOX_WORKDIR, SCHEMA_PATH),
		outputLastMessageFile: outputMessagePath,
		timeoutMs: DEFAULT_CLASSIFIER_TIMEOUT_MS,
		configOverrides: {
			model: "gpt-5.4-mini",
		},
	});
	const metadata = {
		command: {
			command: command.command,
			argv: command.argv,
			cwd: command.cwd,
		},
	};

	try {
		sandbox = await dependencies.createVercelSandbox({
			timeout: DEFAULT_CLASSIFIER_TIMEOUT_MS + 30_000,
			networkPolicy: buildVercelSandboxCodexNetworkPolicy({
				callbackUrl,
				mediatorSecret: mediatorEnv.MEDIATOR_SECRET,
				codexProxyUrl,
				vercelProtectionBypassSecret:
					protectionBypassEnv.VERCEL_PROTECTION_BYPASS_SECRET,
				proxyChatGPTAccountApi: false,
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

		await dependencies.writeVercelSandboxFiles(sandbox, [
			{
				path: WRAPPER_PATH,
				content: Buffer.from(INTAKE_CLASSIFIER_WRAPPER_SOURCE, "utf8"),
				mode: 0o700,
			},
			{
				path: PROMPT_PATH,
				content: Buffer.from(input.prompt, "utf8"),
				mode: 0o600,
			},
			{
				path: SCHEMA_PATH,
				content: Buffer.from(schemaText, "utf8"),
				mode: 0o600,
			},
			{
				path: METADATA_PATH,
				content: Buffer.from(JSON.stringify(metadata, null, 2), "utf8"),
				mode: 0o600,
			},
			{
				path: `${CODEX_HOME_PATH}/auth.json`,
				content: Buffer.from(JSON.stringify(authPayload, null, 2), "utf8"),
				mode: 0o600,
			},
		]);

		const commandSummary = await dependencies.runVercelSandboxCommand(sandbox, {
			cmd: "node",
			args: [wrapperPath],
			cwd: SANDBOX_WORKDIR,
			timeoutMs:
				DEFAULT_CLASSIFIER_TIMEOUT_MS + DEFAULT_WRAPPER_TIMEOUT_BUFFER_MS,
			env: {
				RHAPSODY_PROMPT_PATH: promptPath,
				RHAPSODY_INTAKE_CLASSIFIER_METADATA_PATH: metadataPath,
				RHAPSODY_OUTPUT_PREVIEW_LENGTH: String(PREVIEW_LENGTH),
				RHAPSODY_CODEX_TIMEOUT_MS: String(DEFAULT_CLASSIFIER_TIMEOUT_MS),
				CODEX_HOME: CODEX_HOME_PATH,
			},
		});
		const durationMs = Date.now() - startedAt;
		const commandMeta = {
			exitCode: commandSummary.exitCode,
			signal: null,
			timedOut: Boolean(commandSummary.timedOut),
			durationMs,
			stdoutPreview: boundedRedactedOutputPreview(commandSummary.stdout),
			stderrPreview: boundedRedactedOutputPreview(commandSummary.stderr),
			error:
				typeof commandSummary.error === "string"
					? boundedRedactedText(commandSummary.error)
					: undefined,
		};

		if (commandSummary.exitCode !== 0 || commandSummary.timedOut) {
			return {
				raw: "",
				command: command.argv.join(" "),
				rawOutputAvailable: false,
				runner: commandMeta,
			};
		}

		const outputReadCommand = await dependencies.runVercelSandboxCommand(
			sandbox,
			{
				cmd: "cat",
				args: [outputMessagePath],
				cwd: SANDBOX_WORKDIR,
			},
		);

		if (outputReadCommand.exitCode !== 0) {
			const readError = `Output read failed for ${outputMessagePath}: ${
				typeof outputReadCommand.error === "string"
					? outputReadCommand.error
					: "command failed"
			}`;
			return {
				raw: "",
				command: command.argv.join(" "),
				rawOutputAvailable: false,
				runner: {
					exitCode: outputReadCommand.exitCode,
					signal: null,
					timedOut: false,
					durationMs,
					stdoutPreview: commandMeta.stdoutPreview,
					stderrPreview: boundedRedactedOutputPreview(outputReadCommand.stderr),
					error: boundedRedactedText(readError),
				},
			};
		}

		return {
			raw: outputReadCommand.stdout,
			command: command.argv.join(" "),
			rawOutputAvailable: outputReadCommand.exitCode === 0,
			runner: commandMeta,
		};
	} finally {
		if (sandbox) {
			await dependencies.stopVercelSandbox(sandbox);
		}
	}
}

function buildMediatorOrigin() {
	const raw =
		process.env.VERCEL_URL ||
		process.env.RHAPSODY_ORIGIN ||
		"http://localhost:3000";

	if (raw.startsWith("http://") || raw.startsWith("https://")) {
		return raw;
	}

	return `https://${raw}`;
}

function boundedRedactedOutputPreview(text: string): string {
	return boundedRedactedText(text, PREVIEW_LENGTH);
}

function boundedRedactedText(
	text: string,
	maxCharacters = PREVIEW_LENGTH,
): string {
	const redacted = text
		.replace(
			/\b(?:api[_-]?key|token|secret|password|credential|pat|bearer)\s*[:=]\s*[^\s,"]{4,}/gi,
			"[redacted]",
		)
		.replace(
			/\b(?:access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\s,"]{4,}/gi,
			"[redacted]",
		)
		.replace(/\bbearer\s+[\w-]+/gi, "bearer [redacted]");
	const normalized = redacted.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxCharacters) {
		return normalized;
	}

	return `${normalized.slice(0, maxCharacters - 1)}…`;
}
