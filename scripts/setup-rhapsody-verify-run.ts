import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Report = {
	ok: boolean;
	mode: "dry-run";
	phase: "verify-run";
	facts: {
		input: {
			providedUrl: string | null;
			normalizedBaseUrl: string | null;
			runId: string | null;
			useRootPasswordRequested: boolean;
		};
		rootPassword: {
			available: boolean;
			source: "process" | ".env.local" | "missing";
			availableWithOptIn: boolean;
		};
		request: {
			endpoint: string | null;
			method: "GET";
			auth: "skipped" | "bearer";
		};
		wait?: {
			enabled: boolean;
			attempts: number;
			timeoutMs: number;
			intervalMs: number;
			elapsedMs: number;
			timeoutHit?: boolean;
		};
		response?: {
			status: number | null;
			contentType: string | null;
			classification: string;
			objectKeys?: string[];
			runStatus?: string | null;
			runnerWorkflowRunId?: string | null;
			latestAttemptId?: string | null;
			latestAttemptStatus?: string | null;
			artifactsCount?: number | null;
			linksCount?: number | null;
			eventsCount?: number | null;
			pullRequestEvidence?: {
				artifactCount: number | null;
				branchArtifactCount: number | null;
				firstPullRequestUrl: string | null;
				latestPullRequestUrl: string | null;
				pullRequestNumber: string | null;
			};
			handoff?: {
				pullRequestEvidenceFound: boolean;
				pullRequestReadyEventPresent: boolean;
				pullRequestMissingEventPresent: boolean;
				pullRequestFailedEventPresent: boolean;
				runnerWorkflowRunId?: string | null;
			};
			handoffEvidence?: string[];
		};
	};
	checks: Array<{
		name: string;
		ok: boolean;
		detail: string;
	}>;
	needsUser: string[];
	blocked: string[];
	nextActions: string[];
	error?: string;
};

const DEFAULT_WAIT_TIMEOUT_MS = 300_000;
const DEFAULT_WAIT_INTERVAL_MS = 10_000;
const MIN_WAIT_TIMEOUT_MS = 1_000;
const MAX_WAIT_TIMEOUT_MS = 3_600_000;
const MIN_WAIT_INTERVAL_MS = 250;
const MAX_WAIT_INTERVAL_MS = 120_000;

type WaitDecision =
	| { kind: "handoff-evidence-found"; terminal: true }
	| { kind: "pull-request-missing"; terminal: true }
	| { kind: "pull-request-failed"; terminal: true }
	| { kind: "continue"; terminal: false };

type Args =
	| {
			ok: true;
			url: string;
			runId: string;
			useRootPassword: boolean;
			wait: boolean;
			timeoutMs: number;
			intervalMs: number;
	  }
	| { ok: false; error: string };

type RootPassword = { value: string; source: "process" | ".env.local" } | null;

const REQUEST_TIMEOUT_MS = 12_000;

type PartialArgs = {
	url: string | null;
	runId: string | null;
	useRootPassword: boolean;
};

function emit(report: Report, exitCode = 0) {
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	process.exitCode = exitCode;
}

function extractPartialArgs(argv: string[]): PartialArgs {
	const args = argv.slice(2);
	if (args[0] === "--") {
		args.shift();
	}

	let url: string | null = null;
	let runId: string | null = null;
	let useRootPassword = false;

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--url") {
			url = args[index + 1] ?? null;
			index += 1;
			continue;
		}
		if (arg.startsWith("--url=")) {
			url = arg.slice("--url=".length);
			continue;
		}
		if (arg === "--run-id") {
			runId = args[index + 1] ?? null;
			index += 1;
			continue;
		}
		if (arg.startsWith("--run-id=")) {
			runId = arg.slice("--run-id=".length);
			continue;
		}
		if (arg === "--use-root-password") {
			useRootPassword = true;
		}
	}

	return {
		url: url?.trim() ? url : null,
		runId: runId?.trim() ? runId : null,
		useRootPassword,
	};
}

function parseArgs(argv: string[]): Args {
	const args = argv.slice(2);
	if (args[0] === "--") {
		args.shift();
	}

	let url = "";
	let runId = "";
	let useRootPassword = false;
	let wait = false;
	let timeoutMs = DEFAULT_WAIT_TIMEOUT_MS;
	let intervalMs = DEFAULT_WAIT_INTERVAL_MS;

	const parsePositiveInteger = (
		argName: string,
		value: string,
	): number | string => {
		if (!/^\d+$/.test(value)) {
			return `${argName} must be a positive integer.`;
		}
		return Number.parseInt(value, 10);
	};

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--url") {
			const value = args[index + 1];
			if (!value) {
				return { ok: false, error: "The --url argument requires a value." };
			}
			url = value;
			index += 1;
			continue;
		}
		if (arg.startsWith("--url=")) {
			url = arg.slice("--url=".length);
			continue;
		}
		if (arg === "--run-id") {
			const value = args[index + 1];
			if (!value) {
				return {
					ok: false,
					error: "The --run-id argument requires a value.",
				};
			}
			runId = value;
			index += 1;
			continue;
		}
		if (arg.startsWith("--run-id=")) {
			runId = arg.slice("--run-id=".length);
			continue;
		}
		if (arg === "--use-root-password") {
			useRootPassword = true;
			continue;
		}
		if (arg === "--wait") {
			wait = true;
			continue;
		}
		if (arg === "--timeout-ms") {
			const value = args[index + 1];
			if (!value) {
				return {
					ok: false,
					error: "The --timeout-ms argument requires a value.",
				};
			}
			const parsed = parsePositiveInteger("--timeout-ms", value);
			if (typeof parsed === "string") {
				return { ok: false, error: parsed };
			}
			timeoutMs = parsed;
			index += 1;
			continue;
		}
		if (arg.startsWith("--timeout-ms=")) {
			const parsed = parsePositiveInteger(
				"--timeout-ms",
				arg.slice("--timeout-ms=".length),
			);
			if (typeof parsed === "string") return { ok: false, error: parsed };
			timeoutMs = parsed;
			continue;
		}
		if (arg === "--interval-ms") {
			const value = args[index + 1];
			if (!value) {
				return {
					ok: false,
					error: "The --interval-ms argument requires a value.",
				};
			}
			const parsed = parsePositiveInteger("--interval-ms", value);
			if (typeof parsed === "string") {
				return { ok: false, error: parsed };
			}
			intervalMs = parsed;
			index += 1;
			continue;
		}
		if (arg.startsWith("--interval-ms=")) {
			const parsed = parsePositiveInteger(
				"--interval-ms",
				arg.slice("--interval-ms=".length),
			);
			if (typeof parsed === "string") return { ok: false, error: parsed };
			intervalMs = parsed;
			continue;
		}
		return { ok: false, error: `Unsupported argument: ${arg}` };
	}

	if (!url.trim()) {
		return { ok: false, error: "Missing required --url argument." };
	}
	if (!runId.trim()) {
		return { ok: false, error: "Missing required --run-id argument." };
	}
	if (wait && intervalMs >= timeoutMs) {
		return {
			ok: false,
			error: "--interval-ms must be less than --timeout-ms.",
		};
	}
	if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_WAIT_TIMEOUT_MS) {
		return {
			ok: false,
			error: `The --timeout-ms value must be at least ${MIN_WAIT_TIMEOUT_MS}ms.`,
		};
	}
	if (!Number.isInteger(timeoutMs) || timeoutMs > MAX_WAIT_TIMEOUT_MS) {
		return {
			ok: false,
			error: `The --timeout-ms value must be at most ${MAX_WAIT_TIMEOUT_MS}ms.`,
		};
	}
	if (!Number.isInteger(intervalMs) || intervalMs < MIN_WAIT_INTERVAL_MS) {
		return {
			ok: false,
			error: `The --interval-ms value must be at least ${MIN_WAIT_INTERVAL_MS}ms.`,
		};
	}
	if (!Number.isInteger(intervalMs) || intervalMs > MAX_WAIT_INTERVAL_MS) {
		return {
			ok: false,
			error: `The --interval-ms value must be at most ${MAX_WAIT_INTERVAL_MS}ms.`,
		};
	}
	if (
		!wait &&
		(timeoutMs !== DEFAULT_WAIT_TIMEOUT_MS ||
			intervalMs !== DEFAULT_WAIT_INTERVAL_MS)
	) {
		return {
			ok: false,
			error:
				"`--timeout-ms` and `--interval-ms` require `--wait` to be enabled.",
		};
	}
	if (wait && !useRootPassword) {
		return { ok: false, error: "--wait requires --use-root-password." };
	}

	return { ok: true, url, runId, useRootPassword, wait, timeoutMs, intervalMs };
}

export { buildInvalidArgsReport, parseArgs };

function delayMs(ms: number) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function evaluateWaitDecision(evidence: {
	pullRequestEvidenceFound: boolean;
	pullRequestMissingEventPresent: boolean;
	pullRequestFailedEventPresent: boolean;
}): WaitDecision {
	if (evidence.pullRequestMissingEventPresent) {
		return { kind: "pull-request-missing", terminal: true };
	}
	if (evidence.pullRequestFailedEventPresent) {
		return { kind: "pull-request-failed", terminal: true };
	}
	if (evidence.pullRequestEvidenceFound) {
		return { kind: "handoff-evidence-found", terminal: true };
	}
	return { kind: "continue", terminal: false };
}

export { evaluateWaitDecision };

function readEnvLocalValue(key: string) {
	const envLocal = ".env.local";
	if (!existsSync(envLocal)) {
		return "";
	}

	const content = readFileSync(envLocal, "utf8");
	for (const rawLine of content.split(/\r?\n/)) {
		const trimmedLine = rawLine.trim();
		if (!trimmedLine || trimmedLine.startsWith("#")) continue;
		const normalized = trimmedLine.startsWith("export ")
			? trimmedLine.slice(7).trim()
			: trimmedLine;
		const equalsIndex = normalized.indexOf("=");
		if (equalsIndex <= 0) continue;
		const parsedKey = normalized.slice(0, equalsIndex).trim();
		const parsedValue = normalized.slice(equalsIndex + 1).trim();
		if (parsedKey === key && parsedValue) return parsedValue;
	}

	return "";
}

function resolveRootPassword(): RootPassword {
	const fromProcess = process.env.ROOT_PASSWORD?.trim();
	if (fromProcess) return { value: fromProcess, source: "process" };

	const fromLocal = readEnvLocalValue("ROOT_PASSWORD");
	if (fromLocal) return { value: fromLocal, source: ".env.local" };

	return null;
}

function normalizeBaseUrl(rawUrl: string): string {
	const parsed = new URL(rawUrl);
	const pathname = parsed.pathname.replace(/\/+$/, "");
	return `${parsed.protocol}//${parsed.host}${pathname}`;
}

function classifyStatus(status: number): string {
	if (status >= 200 && status < 300) return "ok";
	if (status === 401) return "auth-required";
	if (status === 403) return "forbidden";
	if (status === 404) return "not-found";
	if (status >= 500) return "server-error";
	return `status-${status}`;
}

function summarizeNetworkError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return `network error: ${message}`;
}

function asRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asArray(value: unknown): value is unknown[] {
	return Array.isArray(value);
}

function getString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

function getStringIf(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || !value.trim()) return null;

	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : null;
}

function getObjectKeys(value: unknown): string[] | null {
	return asRecord(value) ? Object.keys(value) : null;
}

function getMetadata(value: unknown): Record<string, unknown> | null {
	return asRecord(value) ? value : null;
}

function getFirstNonEmptyString(value: unknown, keys: string[]): string | null {
	if (!asRecord(value)) return null;
	for (const key of keys) {
		const candidate = getStringIf((value as Record<string, unknown>)[key]);
		if (candidate) return candidate;
	}
	return null;
}

function firstOrLatestByTimestamp(items: Array<Record<string, unknown>>): {
	first: Record<string, unknown> | null;
	latest: Record<string, unknown> | null;
} {
	let first: Record<string, unknown> | null = null;
	let latest: Record<string, unknown> | null = null;
	let latestSortValue = -Infinity;

	for (const item of items) {
		if (!first) first = item;
		const scoreCandidates: unknown[] = [
			item.updatedAt,
			item.updated_at,
			item.createdAt,
			item.created_at,
			item.timestamp,
			item.ts,
		];
		const sortValue = scoreCandidates.reduce(
			(current: number, candidate: unknown) => {
				const next = getNumber(candidate);
				if (next !== null && next > current) return next;
				return current;
			},
			-Infinity,
		);
		if (!latest || sortValue >= latestSortValue) {
			latest = item;
			latestSortValue = sortValue;
		}
	}

	return { first, latest };
}

function getFirstOrLatestUrlFromArtifact(
	artifacts: Array<Record<string, unknown>>,
): { first: string | null; latest: string | null } {
	const { first, latest } = firstOrLatestByTimestamp(artifacts);
	const firstUrl =
		getFirstNonEmptyString(first, [
			"externalUrl",
			"url",
			"link",
			"pullRequestUrl",
			"htmlUrl",
			"webUrl",
		]) ||
		getFirstNonEmptyString(getMetadata(first)?.metadata, [
			"url",
			"pullRequestUrl",
			"htmlUrl",
			"webUrl",
			"targetUrl",
			"link",
		]);
	const latestUrl =
		getFirstNonEmptyString(latest, [
			"externalUrl",
			"url",
			"link",
			"pullRequestUrl",
			"htmlUrl",
			"webUrl",
		]) ||
		getFirstNonEmptyString(getMetadata(latest)?.metadata, [
			"url",
			"pullRequestUrl",
			"htmlUrl",
			"webUrl",
			"targetUrl",
			"link",
		]);

	return { first: firstUrl ?? null, latest: latestUrl ?? null };
}

function getFirstOrLatestPullRequestNumber(
	artifacts: Array<Record<string, unknown>>,
): string | null {
	const { first, latest } = firstOrLatestByTimestamp(artifacts);
	const candidateFrom = (value: unknown): string | null => {
		const numberCandidate = getNumber(value);
		return numberCandidate !== null
			? String(numberCandidate)
			: getStringIf(value);
	};

	const numberCandidate = candidateFrom(
		getFirstNonEmptyString(first, [
			"externalId",
			"pullRequestNumber",
			"number",
			"id",
		]),
	);
	if (numberCandidate) return numberCandidate;

	const firstMetadata = getMetadata(first)?.metadata;
	const firstPullRequestMetadata = getMetadata(
		firstMetadata && getMetadata(firstMetadata)?.pullRequest,
	);
	const metadataCandidate = candidateFrom(
		getFirstNonEmptyString(firstMetadata, [
			"pullRequestNumber",
			"number",
			"id",
			"pullRequestId",
		]) || getFirstNonEmptyString(firstPullRequestMetadata, ["number", "id"]),
	);
	if (metadataCandidate) return metadataCandidate;

	return candidateFrom(
		getFirstNonEmptyString(getMetadata(latest)?.metadata, [
			"number",
			"id",
			"pullRequestNumber",
		]),
	);
}

function extractEventTypes(events: unknown[]): Set<string> {
	const eventTypes = new Set<string>();
	for (const event of events) {
		if (!asRecord(event)) continue;
		const eventType =
			getStringIf(event.type) ||
			getStringIf(event.name) ||
			getStringIf(event.eventType);
		if (eventType) eventTypes.add(eventType);
	}
	return eventTypes;
}

function getArtifactKind(value: Record<string, unknown>): string | null {
	return (
		getStringIf(value.kind) ||
		getStringIf(value.type) ||
		getStringIf(value.artifactKind) ||
		null
	);
}

function pickLatestAttempt(attemptsValue: unknown) {
	if (!asArray(attemptsValue) || attemptsValue.length === 0) {
		return null;
	}

	let latest: Record<string, unknown> | null = null;
	let latestScore = -Infinity;

	for (const item of attemptsValue) {
		if (!asRecord(item)) continue;
		const scoreCandidates: unknown[] = [
			item.updatedAt,
			item.updated_at,
			item.finishedAt,
			item.finished_at,
			item.startedAt,
			item.started_at,
		];
		const score = scoreCandidates.reduce(
			(current: number, candidate) =>
				typeof candidate === "number" && candidate > current
					? candidate
					: current,
			-Infinity,
		);
		if (score >= latestScore) {
			latest = item;
			latestScore = score;
		}
	}

	return latest;
}

function countArray(value: unknown): number | null {
	return asArray(value) ? value.length : null;
}

async function fetchRunDetail(args: {
	endpoint: string;
	token?: string;
}): Promise<{
	status: number | null;
	contentType: string | null;
	classification: string;
	objectKeys: string[] | null;
	body: unknown;
	error?: string;
}> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	try {
		const response = await fetch(args.endpoint, {
			method: "GET",
			headers: args.token
				? { Authorization: `Bearer ${args.token}` }
				: undefined,
			redirect: "manual",
			signal: controller.signal,
		});

		const contentType = response.headers.get("content-type");
		let body: unknown = null;
		let objectKeys: string[] | null = null;

		if (contentType?.includes("application/json")) {
			try {
				body = await response.json();
				objectKeys = getObjectKeys(body);
			} catch (error) {
				return {
					status: response.status,
					contentType,
					classification: classifyStatus(response.status),
					objectKeys: null,
					body: null,
					error:
						error instanceof Error
							? error.message
							: "failed to parse JSON response",
				};
			}
		}

		return {
			status: response.status,
			contentType,
			classification: classifyStatus(response.status),
			objectKeys,
			body,
		};
	} catch (error) {
		return {
			status: null,
			contentType: null,
			classification: "network-error",
			objectKeys: null,
			body: null,
			error: summarizeNetworkError(error),
		};
	} finally {
		clearTimeout(timeout);
	}
}

export function buildEvidenceSignals(detail: unknown): {
	runStatus: string | null;
	runnerWorkflowRunId: string | null;
	latestAttemptId: string | null;
	latestAttemptStatus: string | null;
	artifactsCount: number | null;
	linksCount: number | null;
	eventsCount: number | null;
	pullRequestEvidence: {
		artifactCount: number | null;
		branchArtifactCount: number | null;
		firstPullRequestUrl: string | null;
		latestPullRequestUrl: string | null;
		pullRequestNumber: string | null;
	};
	handoff: {
		pullRequestEvidenceFound: boolean;
		pullRequestReadyEventPresent: boolean;
		pullRequestMissingEventPresent: boolean;
		pullRequestFailedEventPresent: boolean;
	};
	handoffEvidence: string[];
} {
	if (!asRecord(detail)) {
		return {
			runStatus: null,
			runnerWorkflowRunId: null,
			latestAttemptId: null,
			latestAttemptStatus: null,
			artifactsCount: null,
			linksCount: null,
			eventsCount: null,
			pullRequestEvidence: {
				artifactCount: null,
				branchArtifactCount: null,
				firstPullRequestUrl: null,
				latestPullRequestUrl: null,
				pullRequestNumber: null,
			},
			handoff: {
				pullRequestEvidenceFound: false,
				pullRequestReadyEventPresent: false,
				pullRequestMissingEventPresent: false,
				pullRequestFailedEventPresent: false,
			},
			handoffEvidence: [],
		};
	}

	const run = asRecord(detail.run) ? detail.run : null;
	const attemptsValue = asArray(detail.attempts) ? detail.attempts : null;
	const eventsValue = asArray(detail.events) ? detail.events : null;
	const artifactsValue = asArray(detail.artifacts) ? detail.artifacts : null;
	const linksValue = asArray(detail.links) ? detail.links : null;
	const latestAttempt = pickLatestAttempt(attemptsValue);
	const handoffEvidence: string[] = [];
	const safeArtifacts = asArray(artifactsValue)
		? artifactsValue
				.filter(asRecord)
				.map((artifact) => artifact as Record<string, unknown>)
		: [];
	const pullRequestArtifacts = safeArtifacts.filter((artifact) => {
		const kind = getArtifactKind(artifact)?.toLowerCase();
		return kind === "pull_request" || kind === "pull-request";
	});
	const branchArtifacts = safeArtifacts.filter((artifact) => {
		const kind = getArtifactKind(artifact)?.toLowerCase();
		return kind === "branch";
	});
	const pullRequestUrls = getFirstOrLatestUrlFromArtifact(pullRequestArtifacts);
	const pullRequestNumber =
		getFirstOrLatestPullRequestNumber(pullRequestArtifacts);
	const eventTypes = eventsValue
		? extractEventTypes(eventsValue as Record<string, unknown>[])
		: new Set();
	const pullRequestReadyEventPresent = eventTypes.has(
		"sandbox_codex_runner.pull_request_ready",
	);
	const pullRequestMissingEventPresent = eventTypes.has(
		"sandbox_codex_runner.pull_request_missing",
	);
	const pullRequestFailedEventPresent = eventTypes.has(
		"sandbox_codex_runner.pull_request_failed",
	);
	const pullRequestEvidenceFound =
		pullRequestArtifacts.length > 0 ||
		Boolean(pullRequestUrls.first) ||
		Boolean(pullRequestUrls.latest) ||
		Boolean(pullRequestNumber) ||
		pullRequestReadyEventPresent ||
		pullRequestMissingEventPresent ||
		pullRequestFailedEventPresent;

	const runnerWorkflowRunId =
		run && getString(run.runnerWorkflowRunId)
			? getString(run.runnerWorkflowRunId)
			: null;
	const runStatus = run && getString(run.status) ? getString(run.status) : null;
	const latestAttemptId =
		latestAttempt && getString(latestAttempt.id)
			? getString(latestAttempt.id)
			: null;
	const latestAttemptStatus =
		latestAttempt && getString(latestAttempt.status)
			? getString(latestAttempt.status)
			: null;

	if (runnerWorkflowRunId) {
		handoffEvidence.push("runnerWorkflowRunId");
	}
	if (latestAttemptId) {
		handoffEvidence.push("attempt");
	}
	if (countArray(eventsValue) && countArray(eventsValue)! > 0) {
		handoffEvidence.push("events");
	}
	if (countArray(artifactsValue) && countArray(artifactsValue)! > 0) {
		handoffEvidence.push("artifacts");
	}
	if (countArray(linksValue) && countArray(linksValue)! > 0) {
		handoffEvidence.push("links");
	}
	if (attemptsValue && attemptsValue.length > 0) {
		handoffEvidence.push("attempts");
	}
	if (pullRequestArtifacts.length > 0) {
		handoffEvidence.push("pull_request_artifacts");
	}
	if (branchArtifacts.length > 0) {
		handoffEvidence.push("branch_artifacts");
	}

	return {
		runStatus,
		runnerWorkflowRunId,
		latestAttemptId,
		latestAttemptStatus,
		artifactsCount: countArray(artifactsValue),
		linksCount: countArray(linksValue),
		eventsCount: countArray(eventsValue),
		pullRequestEvidence: {
			artifactCount: pullRequestArtifacts.length,
			branchArtifactCount: branchArtifacts.length,
			firstPullRequestUrl: pullRequestUrls.first,
			latestPullRequestUrl: pullRequestUrls.latest,
			pullRequestNumber,
		},
		handoff: {
			pullRequestEvidenceFound,
			pullRequestReadyEventPresent,
			pullRequestMissingEventPresent,
			pullRequestFailedEventPresent,
		},
		handoffEvidence,
	};
}

function buildNextActionsFromEvidence(evidence: {
	pullRequestEvidenceFound: boolean;
	pullRequestMissingEventPresent: boolean;
	pullRequestFailedEventPresent: boolean;
	runnerWorkflowRunId: string | null;
}): string {
	if (
		evidence.pullRequestMissingEventPresent ||
		evidence.pullRequestFailedEventPresent
	) {
		return "Inspect runner events and logs; handoff events indicate pull request creation is missing or failed.";
	}

	if (evidence.pullRequestEvidenceFound) {
		return "Open the PR URL(s) and dashboard to confirm handoff completion.";
	}

	if (evidence.runnerWorkflowRunId) {
		return "Runner workflow started but PR evidence is not visible yet. Wait briefly, rerun verify-run with --use-root-password, and inspect events/artifacts in the dashboard.";
	}

	return "If the run is still in progress, inspect the dashboard for attempts, events, and artifacts before looking for the PR.";
}

export { buildNextActionsFromEvidence };

type WaitPollResult = {
	attempts: number;
	elapsedMs: number;
	response: Awaited<ReturnType<typeof fetchRunDetail>>;
	evidence: ReturnType<typeof buildEvidenceSignals>;
	timeoutHit: boolean;
};

async function runWaitPoll(
	parsed: Extract<Args, { ok: true }>,
	rootPassword: NonNullable<RootPassword>,
	normalizedBaseUrl: string,
): Promise<WaitPollResult> {
	const startMs = Date.now();
	let attempts = 0;

	while (true) {
		attempts += 1;
		const response = await fetchRunDetail({
			endpoint: `${normalizedBaseUrl}/api/v1/runs/${parsed.runId}`,
			token: rootPassword.value,
		});
		const evidence = buildEvidenceSignals(response.body);
		const decision = evaluateWaitDecision({
			pullRequestEvidenceFound: evidence.handoff.pullRequestEvidenceFound,
			pullRequestMissingEventPresent:
				evidence.handoff.pullRequestMissingEventPresent,
			pullRequestFailedEventPresent:
				evidence.handoff.pullRequestFailedEventPresent,
		});

		const elapsedMs = Date.now() - startMs;
		if (decision.terminal) {
			return {
				attempts,
				elapsedMs,
				response,
				evidence,
				timeoutHit: false,
			};
		}
		if (elapsedMs >= parsed.timeoutMs) {
			return {
				attempts,
				elapsedMs,
				response,
				evidence,
				timeoutHit: true,
			};
		}

		await delayMs(parsed.intervalMs);
	}
}

function buildInvalidArgsReport(message: string, argv: string[]): Report {
	const partialArgs = extractPartialArgs(argv);
	const normalizedBaseUrl = partialArgs.url
		? (() => {
				try {
					return normalizeBaseUrl(partialArgs.url);
				} catch {
					return null;
				}
			})()
		: null;
	const endpoint =
		normalizedBaseUrl && partialArgs.runId
			? `${normalizedBaseUrl}/api/v1/runs/${partialArgs.runId}`
			: null;
	const needsUser = [];
	if (!partialArgs.url || !partialArgs.runId) {
		needsUser.push("Provide --url <https://...> and --run-id <id>.");
	}

	const nextActions = message.includes("--interval-ms must be less")
		? [
				"Rerun with --timeout-ms greater than --interval-ms, for example --timeout-ms 300000 --interval-ms 10000.",
			]
		: [
				"Supported args: --url, --run-id, --wait, optional --timeout-ms/--interval-ms, and --use-root-password.",
			];

	return {
		ok: false,
		mode: "dry-run",
		phase: "verify-run",
		facts: {
			input: {
				providedUrl: partialArgs.url,
				normalizedBaseUrl,
				runId: partialArgs.runId,
				useRootPasswordRequested: partialArgs.useRootPassword,
			},
			rootPassword: {
				available: false,
				source: "missing",
				availableWithOptIn: false,
			},
			request: {
				endpoint,
				method: "GET",
				auth: partialArgs.useRootPassword ? "bearer" : "skipped",
			},
		},
		checks: [],
		needsUser,
		blocked: ["Unsupported or invalid arguments."],
		nextActions,
		error: message,
	};
}

function invalidArgsError(message: string, argv: string[]) {
	emit(buildInvalidArgsReport(message, argv), 1);
}

async function main() {
	const parsed = parseArgs(process.argv);
	if (!parsed.ok) {
		invalidArgsError(parsed.error, process.argv);
		return;
	}

	const rootPassword = resolveRootPassword();
	const rootPasswordSource = rootPassword?.source ?? "missing";
	const normalizedBaseUrl = (() => {
		try {
			return normalizeBaseUrl(parsed.url);
		} catch {
			return null;
		}
	})();
	const endpoint = normalizedBaseUrl
		? `${normalizedBaseUrl}/api/v1/runs/${parsed.runId}`
		: null;
	const rootPasswordAvailable = Boolean(rootPassword);
	const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
	const needsUser: string[] = [];
	const blocked: string[] = [];
	const nextActions: string[] = [];

	checks.push({
		name: "root-password",
		ok: rootPasswordAvailable,
		detail: rootPasswordAvailable
			? `available from ${rootPasswordSource}`
			: "missing",
	});

	if (!normalizedBaseUrl) {
		emit(
			{
				ok: false,
				mode: "dry-run",
				phase: "verify-run",
				facts: {
					input: {
						providedUrl: parsed.url,
						normalizedBaseUrl: null,
						runId: parsed.runId,
						useRootPasswordRequested: parsed.useRootPassword,
					},
					rootPassword: {
						available: rootPasswordAvailable,
						source: rootPasswordSource,
						availableWithOptIn: rootPasswordAvailable && parsed.useRootPassword,
					},
					request: {
						endpoint: null,
						method: "GET",
						auth: parsed.useRootPassword ? "bearer" : "skipped",
					},
				},
				checks,
				needsUser: [
					"Provide a valid URL with scheme, e.g. https://preview.vercel.app.",
				],
				blocked: ["Invalid --url value."],
				nextActions: ["Rerun with a valid preview base URL."],
			},
			1,
		);
		return;
	}

	if (!parsed.useRootPassword) {
		if (rootPasswordAvailable) {
			needsUser.push(
				"Authenticated fetch is available; rerun with --use-root-password if you want to inspect the run detail.",
			);
			nextActions.push(
				"Rerun with --use-root-password to fetch /api/v1/runs/:runId with Bearer auth, or inspect the dashboard if you only need a quick status check.",
			);
		} else {
			needsUser.push(
				"Set ROOT_PASSWORD in process env or .env.local before attempting authenticated fetch.",
			);
			nextActions.push(
				"Set ROOT_PASSWORD or use the dashboard to inspect the run detail without authenticated fetch.",
			);
		}
		emit({
			ok: true,
			mode: "dry-run",
			phase: "verify-run",
			facts: {
				input: {
					providedUrl: parsed.url,
					normalizedBaseUrl,
					runId: parsed.runId,
					useRootPasswordRequested: false,
				},
				rootPassword: {
					available: rootPasswordAvailable,
					source: rootPasswordSource,
					availableWithOptIn: false,
				},
				request: {
					endpoint,
					method: "GET",
					auth: "skipped",
				},
			},
			checks,
			needsUser,
			blocked,
			nextActions,
		});
		return;
	}

	if (!rootPassword) {
		emit(
			{
				ok: false,
				mode: "dry-run",
				phase: "verify-run",
				facts: {
					input: {
						providedUrl: parsed.url,
						normalizedBaseUrl,
						runId: parsed.runId,
						useRootPasswordRequested: true,
					},
					rootPassword: {
						available: false,
						source: "missing",
						availableWithOptIn: false,
					},
					request: {
						endpoint,
						method: "GET",
						auth: "bearer",
					},
				},
				checks,
				needsUser: [
					"Set ROOT_PASSWORD in process env or .env.local before rerunning with --use-root-password.",
				],
				blocked: ["ROOT_PASSWORD is required for authenticated verification."],
				nextActions: ["Rerun after providing ROOT_PASSWORD."],
			},
			1,
		);
		return;
	}

	let response;
	let evidence;
	let waitState: {
		attempts: number;
		elapsedMs: number;
		timeoutHit: boolean;
	} = {
		attempts: 1,
		elapsedMs: 0,
		timeoutHit: false,
	};

	if (parsed.wait) {
		const pollResult = await runWaitPoll(
			parsed,
			rootPassword,
			normalizedBaseUrl,
		);
		response = pollResult.response;
		evidence = pollResult.evidence;
		waitState = {
			attempts: pollResult.attempts,
			elapsedMs: pollResult.elapsedMs,
			timeoutHit: pollResult.timeoutHit,
		};
	} else {
		const singleResponse = await fetchRunDetail({
			endpoint: endpoint ?? `${normalizedBaseUrl}/api/v1/runs/${parsed.runId}`,
			token: rootPassword.value,
		});
		response = singleResponse;
		evidence = buildEvidenceSignals(singleResponse.body);
	}
	const objectKeys =
		response.objectKeys?.slice(0, 16) ?? (asRecord(response.body) ? [] : null);
	const usefulShape =
		Boolean(evidence.runStatus) ||
		Boolean(evidence.latestAttemptId) ||
		Boolean(evidence.runnerWorkflowRunId) ||
		Boolean(evidence.eventsCount && evidence.eventsCount > 0) ||
		Boolean(evidence.artifactsCount && evidence.artifactsCount > 0) ||
		Boolean(evidence.linksCount && evidence.linksCount > 0);

	if (response.classification === "network-error") {
		blocked.push("Run detail endpoint is not reachable from this environment.");
	}
	if (response.status === 401 || response.status === 403) {
		blocked.push("Authenticated fetch was rejected by the preview API.");
	}
	if (response.status === 404) {
		blocked.push("Run not found.");
	}
	if (!usefulShape && response.status && response.status < 300) {
		needsUser.push(
			"Run detail returned JSON, but the expected run/attempt evidence keys were not visible.",
		);
	}

	nextActions.push(
		buildNextActionsFromEvidence({
			pullRequestEvidenceFound:
				evidence.handoff?.pullRequestEvidenceFound ?? false,
			pullRequestMissingEventPresent:
				evidence.handoff?.pullRequestMissingEventPresent ?? false,
			pullRequestFailedEventPresent:
				evidence.handoff?.pullRequestFailedEventPresent ?? false,
			runnerWorkflowRunId: evidence.runnerWorkflowRunId,
		}),
	);
	if (
		parsed.wait &&
		(evidence.handoff.pullRequestMissingEventPresent ||
			evidence.handoff.pullRequestFailedEventPresent)
	) {
		nextActions.length = 0;
	}
	if (parsed.wait) {
		nextActions.push(
			`Wait mode: ${waitState.attempts} attempt(s) and ${waitState.elapsedMs}ms elapsed.`,
		);
	}
	if (parsed.wait && waitState.timeoutHit) {
		blocked.push("Timed out while waiting for PR handoff evidence.");
	}
	const exitCode = parsed.wait
		? Number(
				waitState.timeoutHit ||
					evidence.handoff.pullRequestMissingEventPresent ||
					evidence.handoff.pullRequestFailedEventPresent,
			)
		: 0;

	emit(
		{
			ok:
				response.status !== null &&
				response.status < 300 &&
				(usefulShape || Boolean(response.objectKeys?.length)) &&
				!(
					parsed.wait &&
					(evidence.handoff.pullRequestMissingEventPresent ||
						evidence.handoff.pullRequestFailedEventPresent)
				) &&
				!(parsed.wait && waitState.timeoutHit),
			mode: "dry-run",
			phase: "verify-run",
			facts: {
				input: {
					providedUrl: parsed.url,
					normalizedBaseUrl,
					runId: parsed.runId,
					useRootPasswordRequested: true,
				},
				rootPassword: {
					available: true,
					source: rootPassword.source,
					availableWithOptIn: true,
				},
				request: {
					endpoint,
					method: "GET",
					auth: "bearer",
				},
				wait: {
					enabled: parsed.wait,
					attempts: waitState.attempts,
					timeoutMs: parsed.timeoutMs,
					intervalMs: parsed.intervalMs,
					elapsedMs: waitState.elapsedMs,
					timeoutHit: waitState.timeoutHit ? true : undefined,
				},
				response: {
					status: response.status,
					contentType: response.contentType,
					classification: response.classification,
					objectKeys:
						objectKeys && objectKeys.length > 0
							? objectKeys.slice(0, 16)
							: undefined,
					runStatus: evidence.runStatus,
					runnerWorkflowRunId: evidence.runnerWorkflowRunId,
					latestAttemptId: evidence.latestAttemptId,
					latestAttemptStatus: evidence.latestAttemptStatus,
					artifactsCount: evidence.artifactsCount,
					linksCount: evidence.linksCount,
					eventsCount: evidence.eventsCount,
					pullRequestEvidence: evidence.pullRequestEvidence,
					handoff: {
						pullRequestEvidenceFound: evidence.handoff.pullRequestEvidenceFound,
						pullRequestReadyEventPresent:
							evidence.handoff.pullRequestReadyEventPresent,
						pullRequestMissingEventPresent:
							evidence.handoff.pullRequestMissingEventPresent,
						pullRequestFailedEventPresent:
							evidence.handoff.pullRequestFailedEventPresent,
						runnerWorkflowRunId: evidence.runnerWorkflowRunId,
					},
					handoffEvidence:
						evidence.handoffEvidence.length > 0
							? evidence.handoffEvidence
							: undefined,
				},
			},
			checks: [
				...checks,
				{
					name: "authenticated-fetch",
					ok: response.status !== null && response.status < 300,
					detail:
						response.error ??
						`${response.classification}${response.status ? ` (${response.status})` : ""}`,
				},
			],
			needsUser,
			blocked,
			nextActions:
				nextActions.length > 0
					? nextActions
					: ["Inspect the dashboard for the run and attempt details."],
			error: response.error,
		},
		exitCode,
	);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
	void main();
}
