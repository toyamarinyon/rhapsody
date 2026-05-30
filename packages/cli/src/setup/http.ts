import {
	FirstIssuePostClassification,
	SMOKE_TEST_TIMEOUT_MS,
	SmokeClassification,
	StartAttemptClassification,
} from "./types.js";

type JsonObject = Record<string, unknown>;

function safeJson(value: unknown): JsonObject | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	return value as JsonObject;
}

export function classifySmokeStatus(status: number): SmokeClassification {
	if (status >= 200 && status < 300) return "ok";
	if (status >= 300 && status < 400) return "redirect";
	if (status === 401) return "auth-required";
	if (status === 403) return "forbidden";
	if (status >= 500) return "admin-auth-missing";
	return `status-${status}`;
}

export function classifyPostRunStatus(
	status: number | null,
): FirstIssuePostClassification {
	if (status === null) return "network-error";
	if (status >= 200 && status < 300) return "ok";
	if (status === 400) return "validation-error";
	if (status === 401) return "unauthorized";
	if (status === 409) return "existing-run";
	if (status >= 500) return "server-error";
	return `status-${status}`;
}

export function classifyStartAttemptStatus(
	status: number,
): StartAttemptClassification {
	if (status >= 200 && status < 300) return "ok";
	if (status === 400) return "validation-error";
	if (status === 401) return "unauthorized";
	if (status === 404) return "not-found";
	if (status === 409) return "already-started";
	if (status >= 500) return "server-error";
	return `status-${status}`;
}

export async function runSmokeCheck(params: {
	name: string;
	url: string;
	headers?: Record<string, string>;
}): Promise<{
	name: string;
	url: string;
	status: number | null;
	classification: SmokeClassification;
	ok: boolean;
}> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), SMOKE_TEST_TIMEOUT_MS);
	try {
		const response = await fetch(params.url, {
			method: "GET",
			headers: params.headers,
			redirect: "manual",
			signal: controller.signal,
		});
		const classification = classifySmokeStatus(response.status);
		return {
			name: params.name,
			url: params.url,
			status: response.status,
			classification,
			ok: response.status >= 200 && response.status < 300,
		};
	} catch {
		return {
			name: params.name,
			url: params.url,
			status: null,
			classification: "network-error",
			ok: false,
		};
	} finally {
		clearTimeout(timeout);
	}
}

export async function postRun(params: {
	endpoint: string;
	token: string;
	issueNumber: number;
}) {
	const response = await fetch(params.endpoint, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${params.token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			issueNumber: params.issueNumber,
			claimedBy: "setup-rhapsody",
		}),
	});
	const responseData = safeJson(await response.json().catch(() => null));
	const objectKeys = responseData ? Object.keys(responseData) : null;
	return {
		status: response.status,
		classification: classifyPostRunStatus(response.status),
		objectKeys,
		contentType: response.headers.get("content-type"),
		runId: responseData?.runId ? String(responseData.runId) : null,
		attemptId: responseData?.attemptId ? String(responseData.attemptId) : null,
	};
}

export async function startAttempt(params: {
	endpoint: string;
	token: string;
	claimToken: string;
	runId: string;
	attemptId: string;
}) {
	const response = await fetch(
		`${params.endpoint}/${params.runId}/attempts/${params.attemptId}/start`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${params.token}`,
				"x-rhapsody-claim-token": params.claimToken,
				"content-type": "application/json",
			},
			body: JSON.stringify({ claimedBy: "setup-rhapsody" }),
		},
	);
	const responseData = safeJson(await response.json().catch(() => null));
	const objectKeys = responseData ? Object.keys(responseData) : null;
	return {
		status: response.status,
		classification: classifyStartAttemptStatus(response.status),
		contentType: response.headers.get("content-type"),
		objectKeys,
		runnerWorkflowRunId: responseData?.runnerWorkflowRunId
			? String(responseData.runnerWorkflowRunId)
			: null,
	};
}
