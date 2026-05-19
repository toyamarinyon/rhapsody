import { createStateStoreClient, getRunDetail } from "@/lib/state";
import { type Runner, type RunnerKey, type RunnerRouteContext } from "./types";
import { runCodexLocalRunner } from "./codex-local";
import { runFakeRunner } from "./fake";
import { runSandboxCodexRunner } from "./sandbox-codex";
import { runSandboxFakeRunner } from "./sandbox-fake";

type RegisteredRunner = {
	run: Runner;
};

const runners: Record<RunnerKey, RegisteredRunner> = {
	"fake": {
		run: runFakeRunner,
	},
	"sandbox-fake": {
		run: runSandboxFakeRunner,
	},
	"codex-local": {
		run: runCodexLocalRunner,
	},
	"sandbox-codex": {
		run: runSandboxCodexRunner,
	},
};

export function getRunner(runner: RunnerKey): Runner | null {
	return runners[runner]?.run ?? null;
}

export async function runAttemptWithDetail(context: RunnerRouteContext): Promise<Response> {
	const handler = getRunner(context.detail.run.runner);

	if (!handler) {
		return Response.json({ error: `Unknown runner: ${context.detail.run.runner}.` }, { status: 400 });
	}

	return handler(context);
}

export async function runAttempt(request: Request, runId: string, attemptId: string): Promise<Response> {
	return runAttemptWithRunner(request, runId, attemptId, null);
}

export async function runAttemptWithRunner(
	request: Request,
	runId: string,
	attemptId: string,
	runner: RunnerKey | null,
): Promise<Response> {
	const client = createStateStoreClient();

	try {
		const detail = await getRunDetail(client, runId);

		if (!detail) {
			return Response.json({ error: "Run not found." }, { status: 404 });
		}

		const attempt = detail.attempts.find((candidate) => candidate.id === attemptId);

		if (!attempt) {
			return Response.json({ error: "Attempt not found." }, { status: 404 });
		}

		const selectedRunner = runner ? getRunner(runner) : getRunner(detail.run.runner);

		if (!selectedRunner) {
			return Response.json({ error: `Unknown runner: ${runner ?? detail.run.runner}.` }, { status: 400 });
		}

		return await selectedRunner({
			request,
			runId,
			attemptId,
			detail,
			attempt,
			client,
		});
	} finally {
		client.close();
	}
}
