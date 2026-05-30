import { existsSync, readFileSync } from "node:fs";

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

type Facts = {
	input: {
		providedUrl: string | null;
		normalizedBaseUrl: string | null;
		issueNumber: number | null;
		useRootPasswordRequested: boolean;
		applyRequested: boolean;
		yesFlagPresent: boolean;
	};
	rootPassword: {
		available: boolean;
		source: "process" | ".env.local" | "missing";
		availableWithOptIn: boolean;
	};
	request: {
		endpoint: string | null;
		method: "POST" | null;
		payloadShape: Record<string, unknown> | null;
	};
	response?: {
		status: number | null;
		contentType: string | null;
		classification: string;
		objectKeys?: string[];
		runId?: string;
		attemptId?: string;
		error?: string;
	};
};

type Report = {
	ok: boolean;
	mode: Mode;
	phase: "first-issue";
	facts: Facts;
	checks: Check[];
	plannedChanges: PlannedChange[];
	needsUser: string[];
	blocked: string[];
	nextActions: string[];
	error?: string;
};

type ParsedArgs =
	| {
			ok: true;
			mode: Mode;
			url: string;
			issueNumber: number;
			useRootPassword: boolean;
			apply: boolean;
			yes: boolean;
	  }
	| { ok: false; error: string };

type RootPassword = { value: string; source: "process" | ".env.local" } | null;

const REQUEST_TIMEOUT_MS = 12_000;

function emit(report: Report, exitCode = 0) {
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	process.exitCode = exitCode;
}

function parseArgs(argv: string[]): ParsedArgs {
	const args = argv.slice(2);
	if (args[0] === "--") {
		args.shift();
	}

	let url = "";
	let issueNumberText = "";
	let useRootPassword = false;
	let apply = false;
	let yes = false;

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

		if (arg === "--issue-number") {
			const value = args[index + 1];
			if (!value) {
				return {
					ok: false,
					error: "The --issue-number argument requires a value.",
				};
			}
			issueNumberText = value;
			index += 1;
			continue;
		}

		if (arg.startsWith("--issue-number=")) {
			issueNumberText = arg.slice("--issue-number=".length);
			continue;
		}

		if (arg === "--dry-run") {
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

	const issueNumber = Number(issueNumberText);
	if (!url.trim()) {
		return { ok: false, error: "Missing required --url argument." };
	}
	if (!issueNumberText.trim()) {
		return {
			ok: false,
			error: "Missing required --issue-number argument.",
		};
	}
	if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
		return {
			ok: false,
			error: "--issue-number must be a positive integer.",
		};
	}

	if (apply !== yes) {
		return {
			ok: false,
			error:
				"Unsupported argument combination. Use neither flag for dry-run or both --apply and --yes.",
		};
	}

	return {
		ok: true,
		mode: apply ? "apply" : "dry-run",
		url,
		issueNumber,
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

function resolveRootPassword(): RootPassword {
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

function normalizeBaseUrl(rawUrl: string): string {
	const parsed = new URL(rawUrl);
	const pathname = parsed.pathname.replace(/\/+$/, "");
	return `${parsed.protocol}//${parsed.host}${pathname}`;
}

function classifyStatus(status: number): string {
	if (status >= 200 && status < 300) return "ok";
	if (status === 400) return "validation-error";
	if (status === 401) return "unauthorized";
	if (status === 409) return "existing-run";
	if (status >= 500) return "server-error";
	return `status-${status}`;
}

function summarizeNetworkError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return `network error: ${message}`;
}

async function postRun(args: {
	endpoint: string;
	token: string;
	issueNumber: number;
}): Promise<{
	status: number | null;
	contentType: string | null;
	classification: string;
	objectKeys: string[] | null;
	runId: string | null;
	attemptId: string | null;
	error?: string;
}> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	try {
		const response = await fetch(args.endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${args.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				issueNumber: args.issueNumber,
				claimedBy: "setup-rhapsody",
			}),
			redirect: "manual",
			signal: controller.signal,
		});

		const contentType = response.headers.get("content-type");
		let parsed: unknown = null;
		let objectKeys: string[] | null = null;
		let runId: string | null = null;
		let attemptId: string | null = null;

		if (contentType?.includes("application/json")) {
			try {
				parsed = await response.json();
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					objectKeys = Object.keys(parsed);
					const record = parsed as Record<string, unknown>;
					if (typeof record.runId === "string" && record.runId.trim()) {
						runId = record.runId;
					}
					if (typeof record.attemptId === "string" && record.attemptId.trim()) {
						attemptId = record.attemptId;
					}
				}
			} catch (error) {
				return {
					status: response.status,
					contentType,
					classification: classifyStatus(response.status),
					objectKeys: null,
					runId: null,
					attemptId: null,
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
			error: summarizeNetworkError(error),
		};
	} finally {
		clearTimeout(timeout);
	}
}

function baseReport(input: {
	ok: boolean;
	mode: Mode;
	phase: "first-issue";
	facts: Facts;
	checks?: Check[];
	plannedChanges?: PlannedChange[];
	needsUser?: string[];
	blocked?: string[];
	nextActions?: string[];
	error?: string;
}): Report {
	return {
		ok: input.ok,
		mode: input.mode,
		phase: input.phase,
		facts: input.facts,
		checks: input.checks ?? [],
		plannedChanges: input.plannedChanges ?? [],
		needsUser: input.needsUser ?? [],
		blocked: input.blocked ?? [],
		nextActions: input.nextActions ?? [],
		error: input.error,
	};
}

function invalidArgsError(message: string) {
	emit(
		baseReport({
			ok: false,
			mode: "dry-run",
			phase: "first-issue",
			facts: {
				input: {
					providedUrl: null,
					normalizedBaseUrl: null,
					issueNumber: null,
					useRootPasswordRequested: false,
					applyRequested: false,
					yesFlagPresent: false,
				},
				rootPassword: {
					available: false,
					source: "missing",
					availableWithOptIn: false,
				},
				request: {
					endpoint: null,
					method: null,
					payloadShape: null,
				},
			},
			needsUser: [
				"Provide --url <https://...> and --issue-number <positive integer>.",
			],
			blocked: ["Unsupported or missing arguments."],
			nextActions: [
				"Supported args: --url, --issue-number, optional --dry-run, optional --use-root-password, or exact --apply --yes.",
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

	const rootPassword = resolveRootPassword();
	const rootPasswordSource = rootPassword?.source ?? "missing";
	const rootPasswordAvailable = Boolean(rootPassword);
	const normalizedBaseUrl = (() => {
		try {
			return normalizeBaseUrl(parsed.url);
		} catch {
			return null;
		}
	})();
	const endpoint = normalizedBaseUrl
		? `${normalizedBaseUrl}/api/v1/runs`
		: null;
	const payloadShape = {
		issueNumber: "positive integer",
		claimedBy: "setup-rhapsody",
	};

	if (!normalizedBaseUrl) {
		emit(
			baseReport({
				ok: false,
				mode: parsed.mode,
				phase: "first-issue",
				facts: {
					input: {
						providedUrl: parsed.url,
						normalizedBaseUrl: null,
						issueNumber: parsed.issueNumber,
						useRootPasswordRequested: parsed.useRootPassword,
						applyRequested: parsed.apply,
						yesFlagPresent: parsed.yes,
					},
					rootPassword: {
						available: rootPasswordAvailable,
						source: rootPasswordSource,
						availableWithOptIn: rootPasswordAvailable && parsed.useRootPassword,
					},
					request: {
						endpoint: null,
						method: "POST",
						payloadShape,
					},
				},
				needsUser: [
					"Provide a valid URL with scheme, e.g. https://preview.vercel.app.",
				],
				blocked: ["Invalid --url value."],
				nextActions: ["Rerun with a valid preview base URL in dry-run mode."],
			}),
			1,
		);
		return;
	}

	const checks: Check[] = [];
	const needsUser: string[] = [];
	const blocked: string[] = [];
	const nextActions: string[] = [];
	const plannedChanges: PlannedChange[] = [];

	const rootPasswordCheck: Check = {
		name: "root-password",
		ok: rootPasswordAvailable,
		detail: rootPasswordAvailable
			? `available from ${rootPasswordSource}`
			: "missing",
	};
	checks.push(rootPasswordCheck);

	plannedChanges.push({
		kind: "manual-run",
		target: endpoint ?? `${normalizedBaseUrl}/api/v1/runs`,
		action: "POST { issueNumber, claimedBy: 'setup-rhapsody' }",
		reason: "Prepare the first issue handoff as a claimed manual run.",
		requiresUserConfirmation: true,
		wouldWrite: parsed.apply,
	});

	if (!parsed.useRootPassword) {
		needsUser.push(
			"Pass --use-root-password to authorize the manual handoff with ROOT_PASSWORD.",
		);
	}

	if (!parsed.apply) {
		nextActions.push(
			"Rerun with --apply --yes --use-root-password when you are ready to create the manual run; dry-run will not mutate.",
		);
		emit(
			baseReport({
				ok: blocked.length === 0,
				mode: parsed.mode,
				phase: "first-issue",
				facts: {
					input: {
						providedUrl: parsed.url,
						normalizedBaseUrl,
						issueNumber: parsed.issueNumber,
						useRootPasswordRequested: parsed.useRootPassword,
						applyRequested: parsed.apply,
						yesFlagPresent: parsed.yes,
					},
					rootPassword: {
						available: rootPasswordAvailable,
						source: rootPasswordSource,
						availableWithOptIn: rootPasswordAvailable && parsed.useRootPassword,
					},
					request: {
						endpoint,
						method: "POST",
						payloadShape,
					},
				},
				checks,
				plannedChanges,
				needsUser,
				blocked,
				nextActions,
			}),
			blocked.length > 0 ? 1 : 0,
		);
		return;
	}

	if (!rootPasswordAvailable) {
		needsUser.push(
			"Set ROOT_PASSWORD in process env or .env.local before applying.",
		);
		blocked.push("ROOT_PASSWORD is missing.");
		nextActions.push(
			"Set ROOT_PASSWORD locally, then rerun the apply command with --use-root-password.",
		);
	}

	if (!parsed.useRootPassword) {
		blocked.push("Apply requires --use-root-password.");
		nextActions.push(
			"Rerun the same apply command with --use-root-password to authorize the manual handoff.",
		);
	}

	if (blocked.length > 0) {
		emit(
			baseReport({
				ok: false,
				mode: parsed.mode,
				phase: "first-issue",
				facts: {
					input: {
						providedUrl: parsed.url,
						normalizedBaseUrl,
						issueNumber: parsed.issueNumber,
						useRootPasswordRequested: parsed.useRootPassword,
						applyRequested: parsed.apply,
						yesFlagPresent: parsed.yes,
					},
					rootPassword: {
						available: rootPasswordAvailable,
						source: rootPasswordSource,
						availableWithOptIn: rootPasswordAvailable && parsed.useRootPassword,
					},
					request: {
						endpoint,
						method: "POST",
						payloadShape,
					},
				},
				checks,
				plannedChanges,
				needsUser,
				blocked,
				nextActions,
			}),
			1,
		);
		return;
	}

	const result = await postRun({
		endpoint: endpoint!,
		token: rootPassword!.value,
		issueNumber: parsed.issueNumber,
	});

	const responseSummary = {
		status: result.status,
		contentType: result.contentType,
		classification: result.classification,
		...(result.objectKeys
			? { objectKeys: result.objectKeys.slice(0, 16) }
			: {}),
		...(result.runId ? { runId: result.runId } : {}),
		...(result.attemptId ? { attemptId: result.attemptId } : {}),
		...(result.error ? { error: result.error } : {}),
	};

	const ok = result.classification === "ok";
	if (!ok) {
		blocked.push(
			result.classification === "unauthorized"
				? "The preview rejected the bearer token with 401."
				: result.classification === "validation-error"
					? "The preview rejected the manual run payload with 400."
					: result.classification === "existing-run"
						? "The preview reported an existing run with 409."
						: result.classification === "network-error"
							? "The preview API was not reachable."
							: "The preview returned a non-success response.",
		);
	}

	if (result.classification === "network-error") {
		nextActions.push(
			"Confirm the preview URL is the deployed Rhapsody app, then inspect the Vercel deployment logs before rerunning the apply command.",
		);
	} else if (result.classification === "unauthorized") {
		nextActions.push(
			"Confirm ROOT_PASSWORD matches the preview deployment, then rerun with --apply --yes --use-root-password.",
		);
	} else if (result.classification === "validation-error") {
		nextActions.push(
			"Confirm the issue number exists in the configured GitHub repository, then rerun the first issue handoff.",
		);
	} else if (!ok && result.classification !== "existing-run") {
		nextActions.push(
			"Inspect the preview deployment logs and /dashboard run state before rerunning the first issue handoff.",
		);
	}

	if (result.classification === "existing-run") {
		nextActions.push(
			"Open the existing run in the dashboard rather than creating a duplicate handoff.",
		);
	} else if (ok) {
		nextActions.push(
			"Continue to scheduler or PR verification after confirming the run exists in the dashboard.",
		);
	}

	emit(
		baseReport({
			ok,
			mode: parsed.mode,
			phase: "first-issue",
			facts: {
				input: {
					providedUrl: parsed.url,
					normalizedBaseUrl,
					issueNumber: parsed.issueNumber,
					useRootPasswordRequested: parsed.useRootPassword,
					applyRequested: parsed.apply,
					yesFlagPresent: parsed.yes,
				},
				rootPassword: {
					available: rootPasswordAvailable,
					source: rootPasswordSource,
					availableWithOptIn: rootPasswordAvailable && parsed.useRootPassword,
				},
				request: {
					endpoint,
					method: "POST",
					payloadShape,
				},
				response: responseSummary,
			},
			checks,
			plannedChanges,
			needsUser,
			blocked,
			nextActions,
		}),
		ok ? 0 : 1,
	);
}

main().catch((error) => {
	emit(
		baseReport({
			ok: false,
			mode: "dry-run",
			phase: "first-issue",
			facts: {
				input: {
					providedUrl: null,
					normalizedBaseUrl: null,
					issueNumber: null,
					useRootPasswordRequested: false,
					applyRequested: false,
					yesFlagPresent: false,
				},
				rootPassword: {
					available: false,
					source: "missing",
					availableWithOptIn: false,
				},
				request: {
					endpoint: null,
					method: null,
					payloadShape: null,
				},
			},
			needsUser: [],
			blocked: ["Unhandled script error."],
			nextActions: [
				"Rerun with --url and --issue-number; if this repeats, capture the command and report the script error name.",
			],
			error: error instanceof Error ? error.name : "unexpected script error",
		}),
		1,
	);
});
