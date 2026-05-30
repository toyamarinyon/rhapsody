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
const REPOSITORY_PATH = "/vercel/sandbox/repository";
const OUTPUT_PATH = "/vercel/sandbox/rhapsody-output";
const PR_SPEC_PATH = "/vercel/sandbox/rhapsody-output/pr.json";
const METADATA_PATH = "/vercel/sandbox/metadata.json";
const PROMPT_PATH = "/vercel/sandbox/prompt.txt";

type InspectRequest = {
	snapshotId: string;
};

type CommandResult = {
	label: string;
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
	const parsed = parseInspectRequest(body);

	if (!parsed.ok) {
		return Response.json({ error: parsed.error }, { status: 400 });
	}

	let sandbox: RhapsodyVercelSandbox | null = null;
	const startedAt = Date.now();

	try {
		sandbox = await createVercelSandbox({
			source: {
				type: "snapshot",
				snapshotId: parsed.value.snapshotId,
			},
		});

		const commands = await runInspectionCommands(sandbox);

		return Response.json({
			sandboxId: getVercelSandboxId(sandbox),
			snapshotId: parsed.value.snapshotId,
			paths: {
				repository: REPOSITORY_PATH,
				output: OUTPUT_PATH,
				prSpec: PR_SPEC_PATH,
				metadata: METADATA_PATH,
				prompt: PROMPT_PATH,
			},
			commands,
			timing: buildTiming(startedAt),
		});
	} catch (error) {
		return Response.json(
			{
				error: "Snapshot inspection failed.",
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

async function runInspectionCommands(
	sandbox: RhapsodyVercelSandbox,
): Promise<CommandResult[]> {
	return Promise.all([
		runInspectionCommand(sandbox, "filesystem", [
			"-lc",
			[
				"pwd",
				"echo '--- /vercel'",
				"ls -la /vercel || true",
				"echo '--- /vercel/sandbox'",
				"ls -la /vercel/sandbox || true",
				`echo '--- ${OUTPUT_PATH}'`,
				`ls -la ${OUTPUT_PATH} || true`,
				`echo '--- ${REPOSITORY_PATH}'`,
				`ls -la ${REPOSITORY_PATH} || true`,
			].join("\n"),
		]),
		runInspectionCommand(sandbox, "metadata", [
			"-lc",
			`if [ -f ${shellQuote(METADATA_PATH)} ]; then cat ${shellQuote(METADATA_PATH)}; fi`,
		]),
		runInspectionCommand(sandbox, "pr_spec", [
			"-lc",
			`if [ -f ${shellQuote(PR_SPEC_PATH)} ]; then cat ${shellQuote(PR_SPEC_PATH)}; fi`,
		]),
		runInspectionCommand(sandbox, "prompt", [
			"-lc",
			`if [ -f ${shellQuote(PROMPT_PATH)} ]; then cat ${shellQuote(PROMPT_PATH)}; fi`,
		]),
		runInspectionCommand(sandbox, "git_status", [
			"-lc",
			`git -C ${shellQuote(REPOSITORY_PATH)} status --branch --porcelain=v2`,
		]),
		runInspectionCommand(sandbox, "git_branches", [
			"-lc",
			`git -C ${shellQuote(REPOSITORY_PATH)} branch -vv`,
		]),
		runInspectionCommand(sandbox, "git_log", [
			"-lc",
			`git -C ${shellQuote(REPOSITORY_PATH)} log --oneline --decorate --graph -n 20`,
		]),
		runInspectionCommand(sandbox, "git_remote", [
			"-lc",
			`git -C ${shellQuote(REPOSITORY_PATH)} remote -v`,
		]),
		runInspectionCommand(sandbox, "git_head", [
			"-lc",
			`git -C ${shellQuote(REPOSITORY_PATH)} rev-parse HEAD && git -C ${shellQuote(REPOSITORY_PATH)} rev-parse --abbrev-ref HEAD`,
		]),
		runInspectionCommand(sandbox, "git_diff_name_status", [
			"-lc",
			`git -C ${shellQuote(REPOSITORY_PATH)} diff --name-status`,
		]),
		runInspectionCommand(sandbox, "codex_version", ["-lc", "codex --version"]),
	]);
}

async function runInspectionCommand(
	sandbox: RhapsodyVercelSandbox,
	label: string,
	args: string[],
): Promise<CommandResult> {
	const summary = await runVercelSandboxCommand(sandbox, {
		cmd: "sh",
		args,
		cwd: SANDBOX_WORKDIR,
	});

	return { label, summary };
}

function parseInspectRequest(
	body: string,
): { ok: true; value: InspectRequest } | { ok: false; error: string } {
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
			snapshotId: parsed.snapshotId.trim(),
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

function shellQuote(value: string) {
	return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}
