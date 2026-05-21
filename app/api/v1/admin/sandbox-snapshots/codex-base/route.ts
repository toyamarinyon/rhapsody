import {
	createVercelSandbox,
	createVercelSandboxSnapshot,
	getVercelSandboxId,
	runVercelSandboxCommand,
	stopVercelSandbox,
	type RhapsodyVercelSandbox,
	type VercelSandboxCommandSummary,
} from "@/lib/sandbox/vercel";
import { requireAdminAuth } from "@/lib/server/admin-auth";
import { isRecord } from "@/lib/server/json";

export const runtime = "nodejs";

const SANDBOX_WORKDIR = "/";
const DEFAULT_CODEX_PACKAGE = "@openai/codex@0.130.0";
const BASE_COMMAND = "codex --version";

type CodexBaseRequest = {
	codexPackage?: string;
};

type CommandSummary = {
	command: string;
	summary: VercelSandboxCommandSummary;
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
	const parsed = parseCodexBaseRequest(body);

	if (!parsed.ok) {
		return Response.json({ error: parsed.error }, { status: 400 });
	}

	const commandSummaries: CommandSummary[] = [];
	const startedAt = Date.now();
	let sandbox: RhapsodyVercelSandbox | null = null;

	try {
		sandbox = await createVercelSandbox();
		const codexVersionInitial = await runCodexVersion(sandbox);
		commandSummaries.push({
			command: BASE_COMMAND,
			summary: codexVersionInitial,
		});

		let codexVersion = normalizeVersionOutput(codexVersionInitial.stdout);
		let codexVersionExitCode = codexVersionInitial.exitCode;

		if (codexVersionInitial.exitCode !== 0) {
			const codexPackage = parsed.value.codexPackage ?? DEFAULT_CODEX_PACKAGE;
			const installResult = await installCodexPackage(sandbox, codexPackage);
			commandSummaries.push({
				command: `npm install -g ${codexPackage}`,
				summary: installResult,
			});

			const codexVersionAfterInstall = await runCodexVersion(sandbox);
			commandSummaries.push({
				command: BASE_COMMAND,
				summary: codexVersionAfterInstall,
			});
			codexVersion = normalizeVersionOutput(codexVersionAfterInstall.stdout);
			codexVersionExitCode = codexVersionAfterInstall.exitCode;
		}

		if (codexVersionExitCode !== 0) {
			return Response.json(
				{
					error: "Codex CLI is not available in the sandbox.",
					codexVersion: {
						exitCode: codexVersionExitCode,
						output: codexVersion,
					},
					commands: commandSummaries,
					timing: buildTiming(startedAt),
				},
				{ status: 502 },
			);
		}

		const snapshot = await createVercelSandboxSnapshot(sandbox);

		return Response.json({
			sandboxId: getVercelSandboxId(sandbox),
			snapshotId: snapshot.snapshotId,
			codexVersion: {
				exitCode: codexVersionExitCode,
				output: codexVersion,
			},
			commands: commandSummaries,
			timing: buildTiming(startedAt),
		});
	} catch (error) {
		return Response.json(
			{
				error: "Failed to create Codex base snapshot.",
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

async function runCodexVersion(sandbox: RhapsodyVercelSandbox) {
	return runVercelSandboxCommand(sandbox, {
		cmd: "sh",
		args: ["-lc", "codex --version"],
		cwd: SANDBOX_WORKDIR,
	});
}

async function installCodexPackage(
	sandbox: RhapsodyVercelSandbox,
	codexPackage: string,
) {
	return runVercelSandboxCommand(sandbox, {
		cmd: "npm",
		args: ["install", "-g", codexPackage],
		cwd: SANDBOX_WORKDIR,
	});
}

function normalizeVersionOutput(value: string) {
	return value.trim();
}

function parseCodexBaseRequest(
	body: string,
): { ok: true; value: CodexBaseRequest } | { ok: false; error: string } {
	if (!body.trim()) {
		return { ok: true, value: {} };
	}

	let parsed: unknown;

	try {
		parsed = JSON.parse(body);
	} catch {
		return { ok: false, error: "Request body must be a valid JSON object." };
	}

	if (!isRecord(parsed)) {
		return { ok: false, error: "Request body must be a JSON object." };
	}

	if (parsed.codexPackage === undefined) {
		return { ok: true, value: {} };
	}

	if (typeof parsed.codexPackage !== "string" || !parsed.codexPackage.trim()) {
		return {
			ok: false,
			error: "codexPackage must be a non-empty string when provided.",
		};
	}

	const codexPackage = parsed.codexPackage.trim();

	if (!isAllowedCodexPackage(codexPackage)) {
		return {
			ok: false,
			error:
				"codexPackage must be @openai/codex or @openai/codex@<version-or-tag>.",
		};
	}

	return { ok: true, value: { codexPackage } };
}

function isAllowedCodexPackage(value: string) {
	return /^@openai\/codex(?:@[A-Za-z0-9._~+-]+)?$/.test(value);
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
		return { name: error.name, message: error.message };
	}

	return { name: "UnknownError", message: String(error) };
}
