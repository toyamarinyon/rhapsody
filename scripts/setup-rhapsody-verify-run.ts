import { existsSync, readFileSync } from "node:fs";

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

type Args =
	| {
			ok: true;
			url: string;
			runId: string;
			useRootPassword: boolean;
	  }
	| { ok: false; error: string };

type RootPassword = { value: string; source: "process" | ".env.local" } | null;

const REQUEST_TIMEOUT_MS = 12_000;

function emit(report: Report, exitCode = 0) {
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	process.exitCode = exitCode;
}

function parseArgs(argv: string[]): Args {
	const args = argv.slice(2);
	if (args[0] === "--") {
		args.shift();
	}

	let url = "";
	let runId = "";
	let useRootPassword = false;

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
		return { ok: false, error: `Unsupported argument: ${arg}` };
	}

	if (!url.trim()) {
		return { ok: false, error: "Missing required --url argument." };
	}
	if (!runId.trim()) {
		return { ok: false, error: "Missing required --run-id argument." };
	}

	return { ok: true, url, runId, useRootPassword };
}

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

function getObjectKeys(value: unknown): string[] | null {
	return asRecord(value) ? Object.keys(value) : null;
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

function buildEvidenceSignals(detail: unknown): {
	runStatus: string | null;
	runnerWorkflowRunId: string | null;
	latestAttemptId: string | null;
	latestAttemptStatus: string | null;
	artifactsCount: number | null;
	linksCount: number | null;
	eventsCount: number | null;
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

	return {
		runStatus,
		runnerWorkflowRunId,
		latestAttemptId,
		latestAttemptStatus,
		artifactsCount: countArray(artifactsValue),
		linksCount: countArray(linksValue),
		eventsCount: countArray(eventsValue),
		handoffEvidence,
	};
}

function invalidArgsError(message: string) {
	emit(
		{
			ok: false,
			mode: "dry-run",
			phase: "verify-run",
			facts: {
				input: {
					providedUrl: null,
					normalizedBaseUrl: null,
					runId: null,
					useRootPasswordRequested: false,
				},
				rootPassword: {
					available: false,
					source: "missing",
					availableWithOptIn: false,
				},
				request: {
					endpoint: null,
					method: "GET",
					auth: "skipped",
				},
			},
			checks: [],
			needsUser: ["Provide --url <https://...> and --run-id <id>."],
			blocked: ["Unsupported or missing arguments."],
			nextActions: [
				"Supported args: --url, --run-id, and optional --use-root-password.",
			],
			error: message,
		},
		1,
	);
}

async function main() {
	const parsed = parseArgs(process.argv);
	if (!parsed.ok) {
		invalidArgsError(parsed.error);
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

	const response = await fetchRunDetail({
		endpoint: endpoint ?? `${normalizedBaseUrl}/api/v1/runs/${parsed.runId}`,
		token: rootPassword.value,
	});
	const evidence = buildEvidenceSignals(response.body);
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
		evidence.runnerWorkflowRunId
			? "Open the dashboard and look for the runner workflow execution and PR handoff evidence."
			: "If the run is still in progress, inspect the dashboard for attempts, events, and artifacts before looking for the PR.",
	);

	emit({
		ok:
			response.status !== null &&
			response.status < 300 &&
			(usefulShape || Boolean(response.objectKeys?.length)),
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
	});
}

void main();
