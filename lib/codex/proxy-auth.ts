import {
	createStateStoreClient,
	getRunDetail,
	listWorkItemGraph,
} from "@/lib/state";

export type ProxyRunContext = {
	runId: string;
	attemptId: string;
	audienceSuffix: string;
};

export type ParsedProxyPath = {
	upstreamPath: string;
	runContext: ProxyRunContext | null;
};

export function buildExpectedOidcAudience(
	origin: string,
	runContext: ProxyRunContext | null,
) {
	if (!runContext) {
		return `${origin}/api/internal/codex-chatgpt-proxy`;
	}

	return `${origin}/api/internal/codex-chatgpt-proxy/runs/${runContext.runId}/attempts/${runContext.attemptId}${runContext.audienceSuffix}`;
}

export function parseProxyPath(path: string[]): ParsedProxyPath {
	if (
		path.length >= 4 &&
		path[0] === "runs" &&
		path[2] === "attempts" &&
		path[1]?.trim() &&
		path[3]?.trim()
	) {
		const remainingPath = path.slice(4);
		const parsedPrefixedPath = parsePathPrefixForward(remainingPath);

		return {
			runContext: {
				runId: path[1],
				attemptId: path[3],
				audienceSuffix: parsedPrefixedPath.audienceSuffix,
			},
			upstreamPath: parsedPrefixedPath.upstreamPath,
		};
	}

	return {
		runContext: null,
		upstreamPath: `/${path.join("/")}`,
	};
}

export async function isProxyRunContextActive(
	runContext: ProxyRunContext | null,
): Promise<boolean> {
	if (!runContext) {
		return false;
	}

	let decodedAttemptId = runContext.attemptId;
	try {
		decodedAttemptId = decodeURIComponent(runContext.attemptId);
	} catch {
		// Keep the raw attemptId if decoding fails.
	}
	const workItemIdCandidates = new Set<string>([decodedAttemptId]);
	const base64DecodedAttemptId = tryDecodeBase64Url(decodedAttemptId);
	if (base64DecodedAttemptId) {
		workItemIdCandidates.add(base64DecodedAttemptId);
	}

	const client = createStateStoreClient();

	try {
		const detail = await getRunDetail(client, runContext.runId);
		if (detail?.run) {
			const attempt = detail.attempts.find(
				(candidate) => candidate.id === decodedAttemptId,
			);

			return detail.run.status === "running" && attempt?.status === "running";
		}

		for (const candidateAttemptId of workItemIdCandidates) {
			const graph = await listWorkItemGraph(client, candidateAttemptId);
			if (graph.workItemId !== candidateAttemptId) {
				continue;
			}
			const activeIntakeRun = graph.workerRuns.find(
				(candidate) =>
					candidate.id === runContext.runId &&
					candidate.kind === "intake_curator" &&
					candidate.status === "running",
			);
			if (activeIntakeRun) {
				return true;
			}
		}
	} finally {
		client.close();
	}

	return false;
}

function parsePathPrefixForward(path: string[]) {
	if (path[0] === "codex" && path[1] === "chatgpt") {
		return {
			audienceSuffix: "/codex/chatgpt",
			upstreamPath: `/${path.slice(2).join("/")}`,
		};
	}

	if (path[0] === "codex" && path[1] === "oauth" && path[2] === "token") {
		return {
			audienceSuffix: "/codex/oauth/token",
			upstreamPath: "/oauth/token",
		};
	}

	return {
		audienceSuffix: "",
		upstreamPath: `/${path.join("/")}`,
	};
}

function tryDecodeBase64Url(value: string) {
	try {
		return Buffer.from(value, "base64url").toString("utf8");
	} catch {
		return undefined;
	}
}
