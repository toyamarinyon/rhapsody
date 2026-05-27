import {
	createVercelSandbox,
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
const BASE_COMMAND = "codex --version";

type SmokeRequest = {
	snapshotId: string;
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
	const auth = await requireAdminAuth(request);

	if (!auth.ok) {
		return auth.response;
	}

	const body = await request.text();
	const parsed = parseSmokeRequest(body);

	if (!parsed.ok) {
		return Response.json({ error: parsed.error }, { status: 400 });
	}

	const startedAt = Date.now();
	let sandbox: RhapsodyVercelSandbox | null = null;
	const commandSummaries: CommandSummary[] = [];

	try {
		sandbox = await createVercelSandbox({
			source: {
				type: "snapshot",
				snapshotId: parsed.value.snapshotId,
			},
		});

		const codexVersion = await runVercelSandboxCommand(sandbox, {
			cmd: "sh",
			args: ["-lc", "codex --version"],
			cwd: SANDBOX_WORKDIR,
		});
		commandSummaries.push({ command: BASE_COMMAND, summary: codexVersion });

		return Response.json({
			sandboxId: getVercelSandboxId(sandbox),
			snapshotId: parsed.value.snapshotId,
			command: {
				exitCode: codexVersion.exitCode,
				output: codexVersion.stdout.trim(),
			},
			commands: commandSummaries,
			timing: buildTiming(startedAt),
		});
	} catch (error) {
		return Response.json(
			{
				error: "Smoke test failed.",
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
		return { ok: false, error: "Request body is required." };
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

	if (typeof parsed.snapshotId !== "string" || !parsed.snapshotId.trim()) {
		return { ok: false, error: "snapshotId must be a non-empty string." };
	}

	return {
		ok: true,
		value: {
			snapshotId: parsed.snapshotId,
		},
	};
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
