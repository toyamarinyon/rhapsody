import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Mode = "dry-run" | "apply";

type Check = {
	name: string;
	ok: boolean;
	detail: string;
};

type PlannedChange = {
	kind: string;
	target: string;
	action: string;
	reason: string;
	requiresUserConfirmation: boolean;
	wouldWrite: boolean;
};

type SeedResponseSummary = {
	status: number | null;
	contentType: string | null;
	classification: string;
	objectKeys?: string[];
	seeded?: boolean;
	accountIdPresent?: boolean;
	updatedAt?: string;
	error?: string;
	snippets?: string[];
};

type HealthResponseSummary = {
	status: number | null;
	contentType: string | null;
	classification: string;
	objectKeys?: string[];
	ok?: boolean;
	needsReauth?: boolean;
	upstreamStatus?: number | null;
	responseBodyPresent?: boolean;
	error?: string;
	snippets?: string[];
};

type ParsedArgs =
	| {
			ok: true;
			mode: Mode;
			url: string;
			useRootPassword: boolean;
			apply: boolean;
			yes: boolean;
	  }
	| { ok: false; error: string };

type RootPassword = { value: string; source: "process" | ".env.local" };

const REQUEST_TIMEOUT_MS = 12_000;
const BODY_SNIPPET_MAX_LENGTH = 220;

function emit(report: Report, exitCode = 0) {
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	process.exitCode = exitCode;
}

type Facts = {
	input: {
		providedUrl: string | null;
		normalizedBaseUrl: string | null;
		applyRequested: boolean;
		yesFlagPresent: boolean;
		useRootPasswordRequested: boolean;
	};
	rootPassword: {
		available: boolean;
		source: "process" | ".env.local" | "missing";
		availableWithOptIn: boolean;
	};
	requests: {
		seedFromEnv: string | null;
		healthCheck: string | null;
	};
};

type Report = {
	ok: boolean;
	mode: Mode;
	phase: "seed-codex";
	facts: Facts;
	checks: Check[];
	plannedChanges: PlannedChange[];
	needsUser: string[];
	blocked: string[];
	nextActions: string[];
	response?: {
		seed?: SeedResponseSummary;
		health?: HealthResponseSummary;
	};
	error?: string;
};

export function parseArgs(argv: string[]): ParsedArgs {
	const args = argv.slice(2);
	if (args[0] === "--") {
		args.shift();
	}

	let url = "";
	let useRootPassword = false;
	let apply = false;
	let yes = false;
	let dryRun = false;

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

		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}

		if (arg === "--use-root-password") {
			useRootPassword = true;
			continue;
		}

		if (arg === "--apply") {
			apply = true;
			continue;
		}

		if (arg === "--yes") {
			yes = true;
			continue;
		}

		return { ok: false, error: `Unsupported argument: ${arg}` };
	}

	if (!url.trim()) {
		return { ok: false, error: "Missing required --url argument." };
	}

	if (dryRun && apply) {
		return {
			ok: false,
			error:
				"Unsupported argument combination. Use neither flag for dry-run or exact --apply --yes --use-root-password.",
		};
	}
	if (!apply && yes) {
		return {
			ok: false,
			error: "Unsupported argument combination. Use --apply with --yes to run.",
		};
	}
	if (apply && !yes) {
		return {
			ok: false,
			error:
				"Unsupported argument combination. Use exact --apply --yes --use-root-password.",
		};
	}
	if (apply && !useRootPassword) {
		return {
			ok: false,
			error:
				"Unsupported argument combination. Use exact --apply --yes --use-root-password.",
		};
	}

	return {
		ok: true,
		mode: apply ? "apply" : "dry-run",
		url,
		useRootPassword,
		apply,
		yes,
	};
}

function readEnvLocalValue(key: string) {
	const envLocal = ".env.local";
	if (!existsSync(envLocal)) {
		return "";
	}

	const content = readFileSync(envLocal, "utf8");
	for (const rawLine of content.split(/\r?\n/)) {
		const trimmedLine = rawLine.trim();
		if (!trimmedLine || trimmedLine.startsWith("#")) {
			continue;
		}

		const normalized = trimmedLine.startsWith("export ")
			? trimmedLine.slice(7).trim()
			: trimmedLine;
		const equalsIndex = normalized.indexOf("=");
		if (equalsIndex <= 0) {
			continue;
		}

		const parsedKey = normalized.slice(0, equalsIndex).trim();
		const parsedValue = normalized.slice(equalsIndex + 1).trim();
		if (parsedKey === key && parsedValue) {
			return parsedValue;
		}
	}

	return "";
}

export function resolveRootPassword(): RootPassword | null {
	const fromProcess = process.env.ROOT_PASSWORD?.trim();
	if (fromProcess) {
		return { value: fromProcess, source: "process" };
	}

	const fromLocal = readEnvLocalValue("ROOT_PASSWORD");
	if (fromLocal) {
		return { value: fromLocal, source: ".env.local" };
	}

	return null;
}

export function normalizeBaseUrl(rawUrl: string): string {
	const parsed = new URL(rawUrl);
	if (parsed.protocol !== "https:") {
		throw new Error("Only HTTPS URLs are supported.");
	}
	const pathname = parsed.pathname.replace(/\/+$/, "");
	return `${parsed.protocol}//${parsed.host}${pathname}`;
}

export function buildSeedEndpoints(baseUrl: string): {
	seedFromEnv: string;
	healthCheck: string;
} {
	return {
		seedFromEnv: `${baseUrl}/api/v1/admin/codex-chatgpt-credentials/seed-from-env`,
		healthCheck: `${baseUrl}/api/v1/admin/codex-chatgpt-credentials/health-check`,
	};
}

export function classifyStatus(status: number): string {
	if (status >= 200 && status < 300) return "ok";
	if (status === 401) return "unauthorized";
	if (status === 403) return "forbidden";
	if (status === 404) return "not-found";
	if (status === 400) return "validation-error";
	if (status >= 500) return "server-error";
	return `status-${status}`;
}

export function extractErrorSnippets(value: unknown): string[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return [];
	}

	const safeKeys = ["error", "detail", "message", "statusText"] as const;
	const result: string[] = [];

	for (const key of safeKeys) {
		const raw = (value as Record<string, unknown>)[key];
		if (typeof raw === "string") {
			const snippet = raw.trim().replace(/\s+/g, " ");
			if (snippet.length > 0 && snippet.length <= BODY_SNIPPET_MAX_LENGTH) {
				result.push(`${key}: ${snippet}`);
			}
		}
	}

	return result;
}

function safeRecord(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return null;
}

export function summarizeSeedResponse(args: {
	status: number | null;
	contentType: string | null;
	parsedBody: unknown;
	error?: string;
}): SeedResponseSummary {
	const summary: SeedResponseSummary = {
		status: args.status,
		contentType: args.contentType,
		classification:
			args.status === null ? "network-error" : classifyStatus(args.status),
	};

	const record = safeRecord(args.parsedBody);
	if (record) {
		summary.objectKeys = Object.keys(record).slice(0, 16);
	}
	if (typeof args.error === "string") {
		summary.error = args.error;
	}
	if (record?.seeded === true) {
		summary.seeded = true;
	}
	if (record?.seeded === false) {
		summary.seeded = false;
	}
	if (typeof record?.accountIdPresent === "boolean") {
		summary.accountIdPresent = record.accountIdPresent;
	}
	if (typeof record?.updatedAt === "string") {
		summary.updatedAt = record.updatedAt;
	}
	const snippets = extractErrorSnippets(record);
	if (snippets.length > 0) {
		summary.snippets = snippets;
	}

	return summary;
}

export function summarizeHealthResponse(args: {
	status: number | null;
	contentType: string | null;
	parsedBody: unknown;
	error?: string;
}): HealthResponseSummary {
	const summary: HealthResponseSummary = {
		status: args.status,
		contentType: args.contentType,
		classification:
			args.status === null ? "network-error" : classifyStatus(args.status),
	};

	const record = safeRecord(args.parsedBody);
	summary.responseBodyPresent = Boolean(record || args.parsedBody);
	if (record) {
		summary.objectKeys = Object.keys(record).slice(0, 16);
		if (typeof record.ok === "boolean") {
			summary.ok = record.ok;
		}
		if (typeof record.needsReauth === "boolean") {
			summary.needsReauth = record.needsReauth;
		}
		if (typeof record.upstreamStatus === "number") {
			summary.upstreamStatus = record.upstreamStatus;
		}
	}

	if (typeof args.error === "string") {
		summary.error = args.error;
	}
	const snippets = extractErrorSnippets(record);
	if (snippets.length > 0) {
		summary.snippets = snippets;
	}

	return summary;
}

function summarizeNetworkError(error: unknown): string {
	return error instanceof Error
		? `network error: ${error.message}`
		: `network error: ${String(error)}`;
}

async function fetchSeedFromEnv(args: {
	endpoint: string;
	token: string;
}): Promise<{
	status: number | null;
	contentType: string | null;
	parsedBody: unknown;
	error?: string;
}> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	try {
		const response = await fetch(args.endpoint, {
			method: "POST",
			headers: { Authorization: `Bearer ${args.token}` },
			redirect: "manual",
			signal: controller.signal,
		});
		const contentType = response.headers.get("content-type");
		if (!contentType?.includes("application/json")) {
			return {
				status: response.status,
				contentType,
				parsedBody: null,
				error: "non-json response received",
			};
		}

		try {
			return {
				status: response.status,
				contentType,
				parsedBody: await response.json(),
			};
		} catch (error) {
			return {
				status: response.status,
				contentType,
				parsedBody: null,
				error:
					error instanceof Error
						? error.message
						: "failed to parse JSON response",
			};
		}
	} catch (error) {
		return {
			status: null,
			contentType: null,
			parsedBody: null,
			error: summarizeNetworkError(error),
		};
	} finally {
		clearTimeout(timeout);
	}
}

async function fetchHealthCheck(args: {
	endpoint: string;
	token: string;
}): Promise<{
	status: number | null;
	contentType: string | null;
	parsedBody: unknown;
	error?: string;
}> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	try {
		const response = await fetch(args.endpoint, {
			method: "POST",
			headers: { Authorization: `Bearer ${args.token}` },
			redirect: "manual",
			signal: controller.signal,
		});
		const contentType = response.headers.get("content-type");
		if (!contentType?.includes("application/json")) {
			return {
				status: response.status,
				contentType,
				parsedBody: null,
				error: "non-json response received",
			};
		}

		try {
			return {
				status: response.status,
				contentType,
				parsedBody: await response.json(),
			};
		} catch (error) {
			return {
				status: response.status,
				contentType,
				parsedBody: null,
				error:
					error instanceof Error
						? error.message
						: "failed to parse JSON response",
			};
		}
	} catch (error) {
		return {
			status: null,
			contentType: null,
			parsedBody: null,
			error: summarizeNetworkError(error),
		};
	} finally {
		clearTimeout(timeout);
	}
}

function baseReport(input: {
	ok: boolean;
	mode: Mode;
	facts: Facts;
	checks: Check[];
	plannedChanges: PlannedChange[];
	needsUser: string[];
	blocked: string[];
	nextActions: string[];
	response?: { seed?: SeedResponseSummary; health?: HealthResponseSummary };
	error?: string;
}): Report {
	return {
		ok: input.ok,
		mode: input.mode,
		phase: "seed-codex",
		facts: input.facts,
		checks: input.checks,
		plannedChanges: input.plannedChanges,
		needsUser: input.needsUser,
		blocked: input.blocked,
		nextActions: input.nextActions,
		...(input.response ? { response: input.response } : {}),
		...(input.error ? { error: input.error } : {}),
	};
}

function invalidArgsError(message: string) {
	emit(
		baseReport({
			ok: false,
			mode: "dry-run",
			facts: {
				input: {
					providedUrl: null,
					normalizedBaseUrl: null,
					applyRequested: false,
					yesFlagPresent: false,
					useRootPasswordRequested: false,
				},
				rootPassword: {
					available: false,
					source: "missing",
					availableWithOptIn: false,
				},
				requests: {
					seedFromEnv: null,
					healthCheck: null,
				},
			},
			checks: [],
			plannedChanges: [],
			needsUser: [
				"Provide --url <https://...>. Use --apply --yes --use-root-password to run live calls.",
			],
			blocked: ["Unsupported or invalid arguments."],
			nextActions: [
				"Supported args: --url, optional --dry-run, or exact --apply --yes --use-root-password.",
			],
			error: message,
		}),
		1,
	);
}

async function main() {
	const parsed = parseArgs(process.argv);
	if (!parsed.ok) {
		invalidArgsError(parsed.error);
		return;
	}

	let normalizedBaseUrl: string | null = null;
	try {
		normalizedBaseUrl = normalizeBaseUrl(parsed.url);
	} catch {
		normalizedBaseUrl = null;
	}

	const endpoints = normalizedBaseUrl
		? buildSeedEndpoints(normalizedBaseUrl)
		: { seedFromEnv: "", healthCheck: "" };

	const rootPassword = parsed.useRootPassword ? resolveRootPassword() : null;
	const rootPasswordSource = rootPassword?.source ?? "missing";
	const rootPasswordAvailable = Boolean(rootPassword);

	const checks: Check[] = [
		{
			name: "seed-endpoint",
			ok: Boolean(endpoints.seedFromEnv),
			detail: endpoints.seedFromEnv
				? "seed endpoint is defined"
				: "seed endpoint is not available",
		},
	];

	const needsUser: string[] = [];
	const blocked: string[] = [];
	const nextActions: string[] = [];
	const plannedChanges: PlannedChange[] = [
		{
			kind: "seed",
			target: endpoints.seedFromEnv ?? "<invalid url>",
			action: "POST { authorization: bearer }",
			reason:
				"Seed credential state from already configured deploy env source.",
			requiresUserConfirmation: true,
			wouldWrite: parsed.apply,
		},
		{
			kind: "health",
			target: endpoints.healthCheck ?? "<invalid url>",
			action: "POST { authorization: bearer }",
			reason:
				"Validate credentials health immediately after seeding to confirm refresh status.",
			requiresUserConfirmation: true,
			wouldWrite: parsed.apply,
		},
	];

	const facts: Facts = {
		input: {
			providedUrl: parsed.url,
			normalizedBaseUrl,
			applyRequested: parsed.apply,
			yesFlagPresent: parsed.yes,
			useRootPasswordRequested: parsed.useRootPassword,
		},
		rootPassword: {
			available: parsed.useRootPassword ? rootPasswordAvailable : false,
			source: parsed.useRootPassword ? rootPasswordSource : "missing",
			availableWithOptIn: parsed.useRootPassword && rootPasswordAvailable,
		},
		requests: {
			seedFromEnv: endpoints.seedFromEnv,
			healthCheck: endpoints.healthCheck,
		},
	};

	if (!normalizedBaseUrl) {
		emit(
			baseReport({
				ok: false,
				mode: parsed.mode,
				facts: {
					...facts,
					input: {
						...facts.input,
						normalizedBaseUrl: null,
					},
					requests: {
						seedFromEnv: null,
						healthCheck: null,
					},
				},
				checks,
				plannedChanges,
				needsUser: [
					"Provide a valid --url with a https scheme, e.g. https://preview.app.vercel.app",
				],
				blocked: ["Invalid --url value."],
				nextActions: ["Rerun with a valid preview URL in dry-run mode."],
			}),
			1,
		);
		return;
	}

	if (parsed.useRootPassword) {
		checks.push({
			name: "root-password",
			ok: rootPasswordAvailable,
			detail: rootPasswordAvailable
				? `available from ${rootPasswordSource}`
				: "missing",
		});
		if (!rootPasswordAvailable) {
			needsUser.push("Set ROOT_PASSWORD in process env or .env.local.");
		}
	} else {
		needsUser.push(
			"Pass --use-root-password to authorize seed and health-check requests.",
		);
	}

	if (parsed.apply) {
		if (!parsed.useRootPassword) {
			blocked.push("Apply requires --use-root-password.");
		}
		if (!rootPasswordAvailable) {
			blocked.push("ROOT_PASSWORD is missing.");
		}
	}

	if (!parsed.apply) {
		nextActions.push(
			"Rerun with --apply --yes --use-root-password when ready to execute safely.",
		);
		emit(
			baseReport({
				ok: blocked.length === 0,
				mode: parsed.mode,
				facts,
				checks,
				plannedChanges,
				needsUser,
				blocked,
				nextActions,
			}),
			0,
		);
		return;
	}

	if (blocked.length > 0) {
		emit(
			baseReport({
				ok: false,
				mode: parsed.mode,
				facts,
				checks,
				plannedChanges,
				needsUser,
				blocked,
				nextActions,
				error: "Apply blocked by required inputs.",
			}),
			1,
		);
		return;
	}

	if (!rootPassword) {
		emit(
			baseReport({
				ok: false,
				mode: parsed.mode,
				facts,
				checks,
				plannedChanges,
				needsUser,
				blocked: [...blocked, "ROOT_PASSWORD is missing."],
				nextActions: [
					"Set ROOT_PASSWORD in process env or .env.local before applying.",
				],
				error: "Apply blocked by required inputs.",
			}),
			1,
		);
		return;
	}

	const seedResponse = await fetchSeedFromEnv({
		endpoint: endpoints.seedFromEnv,
		token: rootPassword.value,
	});
	const response: {
		seed: SeedResponseSummary;
		health?: HealthResponseSummary;
	} = {
		seed: summarizeSeedResponse(seedResponse),
	};

	if (response.seed.classification !== "ok") {
		nextActions.push(
			"Fix the seed request issue and rerun with the same arguments.",
		);
		emit(
			baseReport({
				ok: false,
				mode: parsed.mode,
				facts,
				checks,
				plannedChanges,
				needsUser,
				blocked: [...blocked, "Seed endpoint did not return success."],
				nextActions,
				response,
				error: "Seed request did not succeed.",
			}),
			1,
		);
		return;
	}

	const healthResponse = await fetchHealthCheck({
		endpoint: endpoints.healthCheck,
		token: rootPassword.value,
	});
	response.health = summarizeHealthResponse(healthResponse);

	emit(
		baseReport({
			ok: response.health.classification === "ok",
			mode: parsed.mode,
			facts,
			checks,
			plannedChanges,
			needsUser,
			blocked:
				response.health.classification === "ok"
					? []
					: ["Health check returned non-200 status."],
			nextActions:
				response.health.classification === "ok"
					? [
							"Codex credentials appear healthy on this preview. Proceed with first-issue handoff.",
						]
					: [
							"Seed succeeded but health check failed. Review health response and retry once fixed.",
						],
			response,
		}),
		response.health.classification === "ok" ? 0 : 1,
	);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
	void main();
}
