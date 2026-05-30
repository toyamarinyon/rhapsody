import { existsSync, readFileSync } from "node:fs";

type Check = {
	name: string;
	url: string;
	ok: boolean;
	status: number | null;
	contentType: string | null;
	classification: string;
	error?: string;
};

type Facts = {
	input: {
		providedUrl: string | null;
		normalizedBaseUrl: string | null;
		rootPasswordSource: "process" | ".env.local" | "missing";
		useRootPasswordRequested: boolean;
	};
	reachability: {
		base: string | null;
		login: string | null;
		dashboard: string | null;
		state: string | null;
	};
	rootPassword: {
		available: boolean;
		source: "process" | ".env.local" | "missing";
		availableWithOptIn: boolean;
	};
};

type Report = {
	ok: boolean;
	mode: "dry-run";
	phase: "smoke-test";
	facts: Facts;
	checks: Check[];
	needsUser: string[];
	blocked: string[];
	nextActions: string[];
	error?: string;
	authStateSummary?: {
		status: number | null;
		contentType: string | null;
		objectKeys?: string[];
		arrayLength?: number;
	};
};

type ArgParseResult =
	| {
			ok: true;
			url: string;
			useRootPassword: boolean;
	  }
	| { ok: false; error: string };

type RootPassword = {
	value: string;
	source: "process" | ".env.local";
};

const REQUEST_TIMEOUT_MS = 12_000;

function parseArgs(argv: string[]): ArgParseResult {
	const args = argv.slice(2);
	if (args[0] === "--") {
		args.shift();
	}

	if (args.length === 0) {
		return { ok: false, error: "Missing required --url argument." };
	}

	let url = "";
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

		if (arg === "--use-root-password") {
			useRootPassword = true;
			continue;
		}

		return { ok: false, error: `Unsupported argument: ${arg}` };
	}

	if (!url.trim()) {
		return { ok: false, error: "Missing required --url argument." };
	}

	return {
		ok: true,
		url,
		useRootPassword,
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

function resolveRootPassword(): RootPassword | null {
	const valueFromProcess = process.env.ROOT_PASSWORD?.trim();
	if (valueFromProcess) {
		return { value: valueFromProcess, source: "process" };
	}

	const valueFromLocal = readEnvLocalValue("ROOT_PASSWORD");
	if (valueFromLocal) {
		return { value: valueFromLocal, source: ".env.local" };
	}

	return null;
}

function normalizeBaseUrl(rawUrl: string): string {
	const parsed = new URL(rawUrl);
	const pathname = parsed.pathname.replace(/\/+$/, "");
	return `${parsed.protocol}//${parsed.host}${pathname}`;
}

function classifyStatus(status: number): string {
	if (status >= 200 && status < 300) return "ok";
	if (status >= 300 && status < 400) return "redirect";
	if (status === 401) return "auth-required";
	if (status === 403) return "forbidden";
	if (status === 500) return "admin-auth-missing";
	return `status-${status}`;
}

function buildBlockedNextActions(args: {
	baseCheck: Check;
	stateCheck: Check;
	loginOrDashboard: Check;
}): string[] {
	if (
		args.baseCheck.classification === "network-error" &&
		args.stateCheck.classification === "network-error" &&
		args.loginOrDashboard.classification === "unreachable-path"
	) {
		return [
			"Confirm the preview URL is the deployed Rhapsody app, then inspect the Vercel deployment logs before rerunning setup:smoke-test.",
		];
	}

	if (args.baseCheck.classification === "network-error") {
		return [
			"Confirm the preview URL is reachable from this environment, then rerun setup:smoke-test.",
		];
	}

	if (args.stateCheck.classification === "network-error") {
		return [
			"Confirm /api/v1/state is deployed and inspect Vercel function logs before rerunning setup:smoke-test.",
		];
	}

	if (args.loginOrDashboard.classification === "unreachable-path") {
		return [
			"Confirm /login or /dashboard routes are present in the preview deployment before rerunning setup:smoke-test.",
		];
	}

	return ["Fix blockers and rerun `pnpm setup:smoke-test -- --url <url>`."];
}

function summarizeNetworkError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return `network error: ${message}`;
}

async function checkEndpoint(args: {
	name: string;
	url: string;
	headers?: HeadersInit;
}): Promise<Check> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	try {
		const response = await fetch(args.url, {
			method: "GET",
			headers: args.headers,
			redirect: "manual",
			signal: controller.signal,
		});
		return {
			name: args.name,
			url: args.url,
			ok: response.status < 500,
			status: response.status,
			contentType: response.headers.get("content-type"),
			classification: classifyStatus(response.status),
		};
	} catch (error) {
		return {
			name: args.name,
			url: args.url,
			ok: false,
			status: null,
			contentType: null,
			classification: "network-error",
			error: summarizeNetworkError(error),
		};
	} finally {
		clearTimeout(timeout);
	}
}

async function checkAuthenticatedState(args: {
	baseUrl: string;
	token: string;
}): Promise<{
	check: Check;
	objectKeys: string[] | null;
	arrayLength: number | null;
}> {
	const url = `${args.baseUrl}/api/v1/state`;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	try {
		const response = await fetch(url, {
			method: "GET",
			headers: { Authorization: `Bearer ${args.token}` },
			redirect: "manual",
			signal: controller.signal,
		});

		let objectKeys: string[] | null = null;
		let arrayLength: number | null = null;
		const contentType = response.headers.get("content-type");
		if (response.status < 500 && contentType?.includes("application/json")) {
			try {
				const parsed = (await response.json()) as unknown;
				if (Array.isArray(parsed)) {
					arrayLength = parsed.length;
				} else if (parsed && typeof parsed === "object") {
					objectKeys = Object.keys(parsed);
				}
			} catch {
				// Keep smoke-check behavior conservative; body shape summary is best-effort.
			}
		}

		return {
			check: {
				name: "api-state-authenticated",
				url,
				ok: response.status < 500,
				status: response.status,
				contentType,
				classification: classifyStatus(response.status),
			},
			objectKeys,
			arrayLength,
		};
	} catch (error) {
		return {
			check: {
				name: "api-state-authenticated",
				url,
				ok: false,
				status: null,
				contentType: null,
				classification: "network-error",
				error: summarizeNetworkError(error),
			},
			objectKeys: null,
			arrayLength: null,
		};
	} finally {
		clearTimeout(timeout);
	}
}

function emit(report: Report, exitCode = 0) {
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	process.exitCode = exitCode;
}

function invalidArgsError(message: string) {
	emit(
		{
			ok: false,
			mode: "dry-run",
			phase: "smoke-test",
			facts: {
				input: {
					providedUrl: null,
					normalizedBaseUrl: null,
					rootPasswordSource: "missing",
					useRootPasswordRequested: false,
				},
				reachability: {
					base: null,
					login: null,
					dashboard: null,
					state: null,
				},
				rootPassword: {
					available: false,
					source: "missing",
					availableWithOptIn: false,
				},
			},
			checks: [],
			needsUser: ["Use --url <https://...> to supply the preview base URL."],
			blocked: ["Unsupported or missing arguments."],
			nextActions: [
				"Supported args: --url <value> and optional --use-root-password.",
			],
			error: message,
		},
		1,
	);
}

function summaryShape(args: {
	objectKeys: string[] | null;
	arrayLength: number | null;
}): {
	status: number | null;
	contentType: string | null;
	objectKeys?: string[];
	arrayLength?: number;
} {
	const base = {
		status: null as number | null,
		contentType: null as string | null,
		objectKeys: undefined as string[] | undefined,
		arrayLength: undefined as number | undefined,
	};

	if (args.objectKeys !== null) {
		return {
			...base,
			contentType: "application/json",
			objectKeys: args.objectKeys.slice(0, 12),
		};
	}

	if (args.arrayLength !== null) {
		return {
			...base,
			contentType: "application/json",
			arrayLength: args.arrayLength,
		};
	}

	return base;
}

async function main() {
	const args = parseArgs(process.argv);
	if (!args.ok) {
		invalidArgsError(args.error);
		return;
	}

	const rootPassword = resolveRootPassword();
	const rootPasswordFactsSource: "process" | ".env.local" | "missing" =
		rootPassword?.source ?? "missing";

	let normalizedBaseUrl: string;
	try {
		normalizedBaseUrl = normalizeBaseUrl(args.url);
	} catch {
		emit(
			{
				ok: false,
				mode: "dry-run",
				phase: "smoke-test",
				facts: {
					input: {
						providedUrl: args.url,
						normalizedBaseUrl: null,
						rootPasswordSource: rootPasswordFactsSource,
						useRootPasswordRequested: args.useRootPassword,
					},
					reachability: {
						base: args.url,
						login: `${args.url.replace(/\/+$/, "")}/login`,
						dashboard: `${args.url.replace(/\/+$/, "")}/dashboard`,
						state: `${args.url.replace(/\/+$/, "")}/api/v1/state`,
					},
					rootPassword: {
						available: Boolean(rootPassword),
						source: rootPasswordFactsSource,
						availableWithOptIn: false,
					},
				},
				checks: [],
				needsUser: [
					"Provide a valid URL with scheme, e.g. https://preview.vercel.app",
				],
				blocked: ["Invalid --url value."],
				nextActions: ["Rerun with a valid preview URL from deploy output."],
			},
			1,
		);
		return;
	}

	const baseUrl = `${normalizedBaseUrl}/`;
	const loginUrl = `${normalizedBaseUrl}/login`;
	const dashboardUrl = `${normalizedBaseUrl}/dashboard`;
	const stateUrl = `${normalizedBaseUrl}/api/v1/state`;

	const baseCheck = await checkEndpoint({ name: "base-url", url: baseUrl });
	const loginCheck = await checkEndpoint({ name: "login-path", url: loginUrl });
	const dashboardCheck = await checkEndpoint({
		name: "dashboard-path",
		url: dashboardUrl,
	});
	const stateCheck = await checkEndpoint({ name: "api-state", url: stateUrl });

	const checks: Check[] = [baseCheck, loginCheck, dashboardCheck, stateCheck];
	const needsUser: string[] = [];
	const blocked: string[] = [];
	const nextActions: string[] = [];

	const canUseDashboardLoginPath =
		(loginCheck.ok && loginCheck.classification !== "network-error") ||
		(dashboardCheck.ok && dashboardCheck.classification !== "network-error");

	const loginOrDashboard = {
		name: "login-or-dashboard-path",
		url: `${loginUrl} OR ${dashboardUrl}`,
		ok: canUseDashboardLoginPath,
		status: loginCheck.ok ? loginCheck.status : dashboardCheck.status,
		contentType: loginCheck.contentType || dashboardCheck.contentType || null,
		classification: canUseDashboardLoginPath
			? "reachable-path"
			: "unreachable-path",
	};

	if (!canUseDashboardLoginPath) {
		blocked.push(
			"Both /login and /dashboard endpoints are unreachable; check deployment routing.",
		);
	}

	const stateWithoutAuth = {
		ok: stateCheck.ok,
		detail:
			stateCheck.classification === "auth-required"
				? "state requires auth (401) as expected before token"
				: stateCheck.status === 500
					? "state returned 500; admin auth may be missing"
					: stateCheck.classification,
	};

	let authStateSummary:
		| {
				status: number | null;
				contentType: string | null;
				objectKeys?: string[];
				arrayLength?: number;
		  }
		| undefined = undefined;

	if (rootPassword && args.useRootPassword) {
		const authenticated = await checkAuthenticatedState({
			baseUrl: normalizedBaseUrl,
			token: rootPassword.value,
		});
		checks.push(authenticated.check);
		authStateSummary = summaryShape({
			objectKeys: authenticated.objectKeys,
			arrayLength: authenticated.arrayLength,
		});
		authStateSummary = {
			status: authenticated.check.status,
			contentType: authenticated.check.contentType,
			objectKeys: authenticated.objectKeys ?? authStateSummary?.objectKeys,
			arrayLength: authenticated.arrayLength ?? authStateSummary?.arrayLength,
		};
	} else if (rootPassword) {
		needsUser.push(
			"Authenticated API check is available; rerun with --use-root-password to exercise /api/v1/state with Bearer token.",
		);
	}

	checks.push(loginOrDashboard);

	if (!baseCheck.ok) {
		blocked.push("Base URL is unreachable.");
	}
	if (stateCheck.classification === "network-error") {
		blocked.push(
			"State endpoint request is not reachable from this environment.",
		);
	}

	const stateBehavior =
		stateCheck.status === 401
			? "401"
			: stateCheck.status === 500
				? "500-admin-auth-not-configured"
				: `status-${stateCheck.status ?? "network"}`;
	const rootAvailabilitySource = rootPasswordFactsSource;

	const report: Report = {
		ok: blocked.length === 0,
		mode: "dry-run",
		phase: "smoke-test",
		facts: {
			input: {
				providedUrl: args.url,
				normalizedBaseUrl,
				rootPasswordSource: rootAvailabilitySource,
				useRootPasswordRequested: args.useRootPassword,
			},
			reachability: {
				base: baseUrl,
				login: loginUrl,
				dashboard: dashboardUrl,
				state: stateUrl,
			},
			rootPassword: {
				available: Boolean(rootPassword),
				source: rootAvailabilitySource,
				availableWithOptIn: Boolean(rootPassword && args.useRootPassword),
			},
		},
		checks: [
			...checks,
			{
				name: "api-state-no-auth-classification",
				url: stateUrl,
				ok: stateWithoutAuth.ok,
				status: stateCheck.status,
				contentType: stateCheck.contentType,
				classification: stateBehavior,
			},
		],
		needsUser,
		blocked,
		nextActions:
			nextActions.length > 0
				? nextActions
				: blocked.length > 0
					? buildBlockedNextActions({
							baseCheck,
							stateCheck,
							loginOrDashboard,
						})
					: rootPassword
						? ["Proceed to manual scheduler and issue run handoff."]
						: [
								"Set ROOT_PASSWORD in process env or .env.local to enable authenticated /api/v1/state checks.",
							],
		authStateSummary,
	};

	if (rootPassword === null) {
		report.nextActions.push(
			"Set ROOT_PASSWORD in process env or .env.local to enable authenticated /api/v1/state checks.",
		);
	} else if (!args.useRootPassword) {
		report.nextActions.push(
			"Authenticated state check is available but was skipped; rerun with --use-root-password if needed.",
		);
	}

	emit(report, report.ok ? 0 : 1);
}

void main();
