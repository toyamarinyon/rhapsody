import {
	FirstIssuePostClassification,
	SMOKE_TEST_TIMEOUT_MS,
	SmokeClassification,
	StartAttemptClassification,
	type FirstIssuePostResponse,
	type JsonObject,
	type RunClaimResponse,
	type StartAttemptPostResponse,
} from "./types.js";

function asJsonObject(value: unknown): JsonObject | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	return value as JsonObject;
}

export function normalizeBaseUrl(rawUrl: string): string {
	const parsed = new URL(rawUrl);
	const pathname = parsed.pathname.replace(/\/+$/, "");
	return `${parsed.protocol}//${parsed.host}${pathname}`;
}

export function classifySmokeStatus(status: number): SmokeClassification {
	if (status >= 200 && status < 300) return "ok";
	if (status >= 300 && status < 400) return "redirect";
	if (status === 401) return "auth-required";
	if (status === 403) return "forbidden";
	if (status >= 500) return "admin-auth-missing";
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

export async function runSmokeCheck({
	name,
	url,
	headers = {},
}: {
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
		const response = await fetch(url, {
			method: "GET",
			headers,
			redirect: "manual",
			signal: controller.signal,
		});
		const status = response.status;
		return {
			name,
			url,
			status,
			classification: classifySmokeStatus(status),
			ok: status >= 200 && status < 300,
		};
	} catch {
		return {
			name,
			url,
			status: null,
			classification: "network-error",
			ok: false,
		};
	} finally {
		clearTimeout(timeout);
	}
}

export async function fetchRunClaimToken({
	endpoint,
	token,
}: {
	endpoint: string;
	token: string;
}): Promise<RunClaimResponse> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), SMOKE_TEST_TIMEOUT_MS);
	try {
		const response = await fetch(endpoint, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
			},
			redirect: "manual",
			signal: controller.signal,
		});
		const contentType = response.headers.get("content-type");
		let claimToken: string | null = null;
		let objectKeys: string[] | null = null;
		if (contentType?.includes("application/json")) {
			try {
				const parsed = await response.json();
				const record = asJsonObject(parsed);
				if (record) {
					objectKeys = Object.keys(record);
					const direct = record.claimToken;
					if (typeof direct === "string" && direct.trim()) {
						claimToken = direct;
					} else if (
						record.run &&
						typeof record.run === "object" &&
						!Array.isArray(record.run)
					) {
						const nested = (record.run as JsonObject).claimToken;
						if (typeof nested === "string" && nested.trim()) {
							claimToken = nested;
						}
					}
				}
			} catch (error) {
				return {
					status: response.status,
					contentType,
					classification: classifyStartAttemptStatus(response.status),
					claimToken: null,
					objectKeys: null,
					error:
						error instanceof Error ? error.message : "failed to parse JSON",
				};
			}
		}

		return {
			status: response.status,
			contentType,
			classification: classifyStartAttemptStatus(response.status),
			claimToken,
			objectKeys,
		};
	} catch (error) {
		return {
			status: null,
			contentType: null,
			classification: "network-error",
			claimToken: null,
			objectKeys: null,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		clearTimeout(timeout);
	}
}

export async function postStartAttempt({
	endpoint,
	token,
	claimToken,
}: {
	endpoint: string;
	token: string;
	claimToken: string;
}): Promise<StartAttemptPostResponse> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), SMOKE_TEST_TIMEOUT_MS);
	try {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ claimToken }),
			redirect: "manual",
			signal: controller.signal,
		});
		const contentType = response.headers.get("content-type");
		let objectKeys: string[] | null = null;
		let runnerWorkflowRunId: string | null = null;
		if (contentType?.includes("application/json")) {
			try {
				const parsed = await response.json();
				const record = asJsonObject(parsed);
				if (record) {
					objectKeys = Object.keys(record);
					const field = record.runnerWorkflowRunId;
					if (typeof field === "string" && field.trim()) {
						runnerWorkflowRunId = field;
					}
				}
			} catch (error) {
				return {
					status: response.status,
					contentType,
					classification: classifyStartAttemptStatus(response.status),
					objectKeys: null,
					runnerWorkflowRunId: null,
					error:
						error instanceof Error ? error.message : "failed to parse JSON",
				};
			}
		}
		return {
			status: response.status,
			contentType,
			classification: classifyStartAttemptStatus(response.status),
			objectKeys,
			runnerWorkflowRunId,
		};
	} catch (error) {
		return {
			status: null,
			contentType: null,
			classification: "network-error",
			objectKeys: null,
			runnerWorkflowRunId: null,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		clearTimeout(timeout);
	}
}

export async function postRun({
	endpoint,
	token,
	issueNumber,
}: {
	endpoint: string;
	token: string;
	issueNumber: number;
}): Promise<FirstIssuePostResponse> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), SMOKE_TEST_TIMEOUT_MS);
	try {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ issueNumber }),
			redirect: "manual",
			signal: controller.signal,
		});
		const contentType = response.headers.get("content-type");
		let objectKeys: string[] | null = null;
		let runId: string | null = null;
		let attemptId: string | null = null;
		if (contentType?.includes("application/json")) {
			try {
				const parsed = await response.json();
				const record = asJsonObject(parsed);
				if (record) {
					objectKeys = Object.keys(record);
					const runIdField = record.runId;
					if (typeof runIdField === "string" && runIdField.trim()) {
						runId = runIdField;
					}
					const attemptIdField = record.attemptId;
					if (typeof attemptIdField === "string" && attemptIdField.trim()) {
						attemptId = attemptIdField;
					}
				}
			} catch (error) {
				return {
					status: response.status,
					contentType,
					classification: classifyPostRunStatus(response.status),
					objectKeys: null,
					runId: null,
					attemptId: null,
					error:
						error instanceof Error ? error.message : "failed to parse JSON",
				};
			}
		}
		return {
			status: response.status,
			contentType,
			classification: classifyPostRunStatus(response.status),
			objectKeys,
			runId,
			attemptId,
		};
	} catch (error) {
		return {
			status: null,
			contentType: null,
			classification: "network-error",
			objectKeys: null,
			runId: null,
			attemptId: null,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		clearTimeout(timeout);
	}
}

export function toJsonObject(value: unknown): JsonObject | null {
	return asJsonObject(value);
}
