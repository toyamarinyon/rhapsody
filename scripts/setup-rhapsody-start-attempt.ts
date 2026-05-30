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
		runId: string | null;
		attemptId: string | null;
		useRootPasswordRequested: boolean;
		applyRequested: boolean;
		yesFlagPresent: boolean;
	};
	rootPassword: {
		available: boolean;
		source: "process" | ".env.local" | "missing";
		availableWithOptIn: boolean;
	};
	claimToken: {
		available: boolean;
		source: "process" | ".env.local" | "run-detail" | "missing";
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
		runnerWorkflowRunId?: string;
		error?: string;
	};
};

type Report = {
	ok: boolean;
	mode: Mode;
	phase: "first-attempt-start";
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
			runId: string;
			attemptId: string;
			useRootPassword: boolean;
			apply: boolean;
			yes: boolean;
	  }
	| { ok: false; error: string };

type SecretValue = { value: string; source: "process" | ".env.local" } | null;
type ClaimTokenSource = "process" | ".env.local" | "run-detail" | "missing";

const REQUEST_TIMEOUT_MS = 12_000;

function emit(report: Report, exitCode = 0) {
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	process.exitCode = exitCode;
}

function buildClaimTokenCheck(input: {
	available: boolean;
	source: ClaimTokenSource;
	rootPasswordAvailable: boolean;
}): Check {
	if (input.available) {
		return {
			name: "claim-token",
			ok: true,
			detail: `available from ${input.source}`,
		};
	}

	if (input.rootPasswordAvailable) {
		return {
			name: "claim-token",
			ok: true,
			detail:
				"missing locally; apply mode can derive it from authenticated run detail with --use-root-password",
		};
	}

	return {
		name: "claim-token",
		ok: false,
		detail:
			"missing locally; set ROOT_PASSWORD or RHAPSODY_CLAIM_TOKEN before applying",
	};
}

function parseArgs(argv: string[]): ParsedArgs {
	const args = argv.slice(2);
	if (args[0] === "--") {
		args.shift();
	}

	let url = "";
	let runId = "";
	let attemptId = "";
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

		if (arg === "--run-id") {
			const value = args[index + 1];
			if (!value) {
				return { ok: false, error: "The --run-id argument requires a value." };
			}
			runId = value;
			index += 1;
			continue;
		}

		if (arg.startsWith("--run-id=")) {
			runId = arg.slice("--run-id=".length);
			continue;
		}

		if (arg === "--attempt-id") {
			const value = args[index + 1];
			if (!value) {
				return {
					ok: false,
					error: "The --attempt-id argument requires a value.",
				};
			}
			attemptId = value;
			index += 1;
			continue;
		}

		if (arg.startsWith("--attempt-id=")) {
			attemptId = arg.slice("--attempt-id=".length);
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

	if (!url.trim()) {
		return { ok: false, error: "Missing required --url argument." };
	}
	if (!runId.trim()) {
		return { ok: false, error: "Missing required --run-id argument." };
	}
	if (!attemptId.trim()) {
		return { ok: false, error: "Missing required --attempt-id argument." };
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
		runId,
		attemptId,
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

function resolveRootPassword(): SecretValue {
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

function resolveClaimToken(): SecretValue {
	const fromProcess = process.env.RHAPSODY_CLAIM_TOKEN?.trim();
	if (fromProcess) {
		return { value: fromProcess, source: "process" };
	}

	const fromLocal = readEnvLocalValue("RHAPSODY_CLAIM_TOKEN");
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
	if (status === 200 || status === 202) return "success";
	if (status === 400) return "validation-error";
	if (status === 401) return "unauthorized";
	if (status === 409) return "conflict";
	if (status >= 500) return "server-error";
	return `status-${status}`;
}

type RunDetailFetchResult = {
	status: number | null;
	contentType: string | null;
	classification: string;
	objectKeys: string[] | null;
	claimToken: string | null;
	hasRunObject: boolean;
	hasRunClaimToken: boolean;
	error?: string;
};

function summarizeNetworkError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return `network error: ${message}`;
}

async function startAttempt(args: {
	endpoint: string;
	token: string;
	claimToken: string;
}): Promise<{
	status: number | null;
	contentType: string | null;
	classification: string;
	objectKeys: string[] | null;
	runnerWorkflowRunId: string | null;
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
			body: JSON.stringify({ claimToken: args.claimToken }),
			redirect: "manual",
			signal: controller.signal,
		});

		const contentType = response.headers.get("content-type");
		let objectKeys: string[] | null = null;
		let runnerWorkflowRunId: string | null = null;

		if (contentType?.includes("application/json")) {
			try {
				const parsed = (await response.json()) as unknown;
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					objectKeys = Object.keys(parsed);
					const record = parsed as Record<string, unknown>;
					if (
						typeof record.runnerWorkflowRunId === "string" &&
						record.runnerWorkflowRunId.trim()
					) {
						runnerWorkflowRunId = record.runnerWorkflowRunId;
					}
				}
			} catch (error) {
				return {
					status: response.status,
					contentType,
					classification: classifyStatus(response.status),
					objectKeys: null,
					runnerWorkflowRunId: null,
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
			runnerWorkflowRunId,
		};
	} catch (error) {
		return {
			status: null,
			contentType: null,
			classification: "network-error",
			objectKeys: null,
			runnerWorkflowRunId: null,
			error: summarizeNetworkError(error),
		};
	} finally {
		clearTimeout(timeout);
	}
}

async function fetchRunClaimToken(args: {
	endpoint: string;
	token: string;
}): Promise<RunDetailFetchResult> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	try {
		const response = await fetch(args.endpoint, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${args.token}`,
			},
			redirect: "manual",
			signal: controller.signal,
		});

		const contentType = response.headers.get("content-type");
		let objectKeys: string[] | null = null;
		let claimToken: string | null = null;
		let hasRunObject = false;
		let hasRunClaimToken = false;

		if (contentType?.includes("application/json")) {
			try {
				const parsed = (await response.json()) as unknown;
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					const record = parsed as Record<string, unknown>;
					objectKeys = Object.keys(record);
					const runRecord = record.run;
					if (
						runRecord &&
						typeof runRecord === "object" &&
						!Array.isArray(runRecord)
					) {
						hasRunObject = true;
						const maybeRun = runRecord as Record<string, unknown>;
						const candidate = maybeRun.claimToken;
						if (typeof candidate === "string" && candidate.trim()) {
							claimToken = candidate;
							hasRunClaimToken = true;
						}
					}
				}
			} catch (error) {
				return {
					status: response.status,
					contentType,
					classification: classifyStatus(response.status),
					objectKeys: null,
					hasRunObject,
					hasRunClaimToken,
					claimToken: null,
					error:
						error instanceof Error
							? error.message
							: "failed to parse run detail JSON response",
				};
			}
		}

		return {
			status: response.status,
			contentType,
			classification: classifyStatus(response.status),
			objectKeys,
			hasRunObject,
			hasRunClaimToken,
			claimToken,
		};
	} catch (error) {
		return {
			status: null,
			contentType: null,
			classification: "network-error",
			objectKeys: null,
			hasRunObject: false,
			hasRunClaimToken: false,
			claimToken: null,
			error: summarizeNetworkError(error),
		};
	} finally {
		clearTimeout(timeout);
	}
}

function baseReport(input: {
	ok: boolean;
	mode: Mode;
	phase: "first-attempt-start";
	facts: Facts;
	response?: Report["facts"]["response"];
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
		facts: {
			...input.facts,
			...(input.response ? { response: input.response } : {}),
		},
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
			phase: "first-attempt-start",
			facts: {
				input: {
					providedUrl: null,
					normalizedBaseUrl: null,
					runId: null,
					attemptId: null,
					useRootPasswordRequested: false,
					applyRequested: false,
					yesFlagPresent: false,
				},
				rootPassword: {
					available: false,
					source: "missing",
					availableWithOptIn: false,
				},
				claimToken: {
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
				"Provide --url <https://...>, --run-id <id>, and --attempt-id <id>.",
			],
			blocked: ["Unsupported or missing arguments."],
			nextActions: [
				"Supported args: --url, --run-id, --attempt-id, or exact --apply --yes plus --use-root-password.",
			],
			error: message,
		}),
		1,
	);
}

async function main() {
	const parsed = parseArgs(process.argv);
	if (!parsed.ok) {
		invalidArgsError((parsed as { error: string }).error);
		return;
	}

	const rootPassword = resolveRootPassword();
	const rootPasswordSource = rootPassword?.source ?? "missing";
	const rootPasswordAvailable = Boolean(rootPassword);
	const claimToken = resolveClaimToken();
	let claimTokenSource: ClaimTokenSource = claimToken?.source ?? "missing";
	let claimTokenAvailable = Boolean(claimToken);
	let resolvedClaimToken = claimToken?.value ?? null;
	const normalizedBaseUrl = (() => {
		try {
			return normalizeBaseUrl(parsed.url);
		} catch {
			return null;
		}
	})();
	const endpoint = normalizedBaseUrl
		? `${normalizedBaseUrl}/api/v1/runs/${parsed.runId}/attempts/${parsed.attemptId}/start`
		: null;
	const payloadShape = {
		claimToken: "redacted",
	};

	if (!normalizedBaseUrl) {
		emit(
			baseReport({
				ok: false,
				mode: parsed.mode,
				phase: "first-attempt-start",
				facts: {
					input: {
						providedUrl: parsed.url,
						normalizedBaseUrl: null,
						runId: parsed.runId,
						attemptId: parsed.attemptId,
						useRootPasswordRequested: parsed.useRootPassword,
						applyRequested: parsed.apply,
						yesFlagPresent: parsed.yes,
					},
					rootPassword: {
						available: rootPasswordAvailable,
						source: rootPasswordSource,
						availableWithOptIn: rootPasswordAvailable && parsed.useRootPassword,
					},
					claimToken: {
						available: claimTokenAvailable,
						source: claimTokenSource,
						availableWithOptIn: claimTokenAvailable,
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

	checks.push({
		name: "root-password",
		ok: rootPasswordAvailable,
		detail: rootPasswordAvailable
			? `available from ${rootPasswordSource}`
			: "missing",
	});
	checks.push(
		buildClaimTokenCheck({
			available: claimTokenAvailable,
			source: claimTokenSource,
			rootPasswordAvailable,
		}),
	);

	plannedChanges.push({
		kind: "attempt-start",
		target:
			endpoint ??
			`${normalizedBaseUrl}/api/v1/runs/${parsed.runId}/attempts/${parsed.attemptId}/start`,
		action: "POST { claimToken: 'redacted' }",
		reason: "Start the first attempt against the manual run.",
		requiresUserConfirmation: true,
		wouldWrite: parsed.apply,
	});

	if (!parsed.useRootPassword) {
		needsUser.push(
			"Pass --use-root-password to authorize the attempt start with ROOT_PASSWORD.",
		);
	}

	if (!parsed.apply) {
		nextActions.push(
			"Rerun with --apply --yes --use-root-password when you are ready to start the attempt; run token is derived from the authenticated run detail when RHAPSODY_CLAIM_TOKEN is not already set.",
		);
		emit(
			baseReport({
				ok: true,
				mode: parsed.mode,
				phase: "first-attempt-start",
				facts: {
					input: {
						providedUrl: parsed.url,
						normalizedBaseUrl,
						runId: parsed.runId,
						attemptId: parsed.attemptId,
						useRootPasswordRequested: parsed.useRootPassword,
						applyRequested: parsed.apply,
						yesFlagPresent: parsed.yes,
					},
					rootPassword: {
						available: rootPasswordAvailable,
						source: rootPasswordSource,
						availableWithOptIn: rootPasswordAvailable && parsed.useRootPassword,
					},
					claimToken: {
						available: claimTokenAvailable,
						source: claimTokenSource,
						availableWithOptIn: claimTokenAvailable,
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
			0,
		);
		return;
	}

	if (!parsed.useRootPassword) {
		blocked.push("Apply requires --use-root-password.");
		nextActions.push(
			"Rerun the same apply command with --use-root-password to authorize the attempt start.",
		);
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

	if (!claimTokenAvailable) {
		needsUser.push(
			"RHAPSODY_CLAIM_TOKEN is not set in process env or .env.local; attempt start can derive it from the run detail in apply mode.",
		);
	}

	if (blocked.length > 0) {
		emit(
			baseReport({
				ok: false,
				mode: parsed.mode,
				phase: "first-attempt-start",
				facts: {
					input: {
						providedUrl: parsed.url,
						normalizedBaseUrl,
						runId: parsed.runId,
						attemptId: parsed.attemptId,
						useRootPasswordRequested: parsed.useRootPassword,
						applyRequested: parsed.apply,
						yesFlagPresent: parsed.yes,
					},
					rootPassword: {
						available: rootPasswordAvailable,
						source: rootPasswordSource,
						availableWithOptIn: rootPasswordAvailable && parsed.useRootPassword,
					},
					claimToken: {
						available: claimTokenAvailable,
						source: claimTokenSource,
						availableWithOptIn: claimTokenAvailable,
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

	if (!claimTokenAvailable) {
		const claimLookup = await fetchRunClaimToken({
			endpoint: `${normalizedBaseUrl}/api/v1/runs/${parsed.runId}`,
			token: rootPassword!.value,
		});

		const runLookupSummary = {
			status: claimLookup.status,
			contentType: claimLookup.contentType,
			classification: claimLookup.classification,
			hasRunObject: claimLookup.hasRunObject,
			hasRunClaimToken: claimLookup.hasRunClaimToken,
			...(claimLookup.objectKeys
				? { objectKeys: claimLookup.objectKeys.slice(0, 16) }
				: {}),
			...(claimLookup.error ? { error: claimLookup.error } : {}),
		};

		if (claimLookup.status !== 200 || !claimLookup.claimToken) {
			const reason =
				claimLookup.status === null
					? "Failed to fetch run detail."
					: !claimLookup.claimToken
						? "Run detail did not include a non-empty claimToken."
						: "Run detail fetch failed with an unexpected status.";

			blocked.push(reason);
			if (claimLookup.classification === "network-error") {
				nextActions.push(
					"Confirm the preview URL and run ID, then inspect the Vercel deployment logs before rerunning the apply command.",
				);
			} else if (claimLookup.classification === "unauthorized") {
				nextActions.push(
					"Confirm ROOT_PASSWORD matches the preview deployment, then rerun with --apply --yes --use-root-password.",
				);
			} else {
				nextActions.push(
					"Confirm the run ID and preview URL, then rerun with --apply --yes --use-root-password after the run detail endpoint returns a claim token.",
				);
			}

			emit(
				baseReport({
					ok: false,
					mode: parsed.mode,
					phase: "first-attempt-start",
					facts: {
						input: {
							providedUrl: parsed.url,
							normalizedBaseUrl,
							runId: parsed.runId,
							attemptId: parsed.attemptId,
							useRootPasswordRequested: parsed.useRootPassword,
							applyRequested: parsed.apply,
							yesFlagPresent: parsed.yes,
						},
						rootPassword: {
							available: rootPasswordAvailable,
							source: rootPasswordSource,
							availableWithOptIn:
								rootPasswordAvailable && parsed.useRootPassword,
						},
						claimToken: {
							available: false,
							source: "missing",
							availableWithOptIn: false,
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
					response: runLookupSummary,
				}),
				1,
			);
			return;
		}

		claimTokenAvailable = true;
		claimTokenSource = "run-detail";
		resolvedClaimToken = claimLookup.claimToken;
		checks.splice(1, 1, {
			name: "claim-token",
			ok: true,
			detail: "available from run-detail",
		});
	}

	const result = await startAttempt({
		endpoint: endpoint!,
		token: rootPassword!.value,
		claimToken: resolvedClaimToken!,
	});

	const responseSummary = {
		status: result.status,
		contentType: result.contentType,
		classification: result.classification,
		...(result.objectKeys
			? { objectKeys: result.objectKeys.slice(0, 16) }
			: {}),
		...(result.runnerWorkflowRunId
			? { runnerWorkflowRunId: result.runnerWorkflowRunId }
			: {}),
		...(result.error ? { error: result.error } : {}),
	};

	const ok = result.classification === "success";
	if (!ok) {
		blocked.push(
			result.classification === "unauthorized"
				? "The preview rejected the bearer token with 401."
				: result.classification === "validation-error"
					? "The preview rejected the attempt start payload with 400."
					: result.classification === "conflict"
						? "The preview reported an existing attempt state with 409."
						: result.classification === "network-error"
							? "The preview API was not reachable."
							: "The preview returned a non-success response.",
		);
	}
	if (result.classification === "network-error") {
		nextActions.push(
			"Confirm the preview URL is reachable, then inspect the Vercel deployment logs before rerunning the attempt start.",
		);
	} else if (result.classification === "unauthorized") {
		nextActions.push(
			"Confirm ROOT_PASSWORD matches the preview deployment, then rerun with --apply --yes --use-root-password.",
		);
	} else if (result.classification === "validation-error") {
		nextActions.push(
			"Confirm the run ID, attempt ID, and claim token belong to the same run before rerunning the attempt start.",
		);
	} else if (!ok && result.classification !== "conflict") {
		nextActions.push(
			"Inspect the preview deployment logs and /dashboard attempt state before rerunning the attempt start.",
		);
	}

	if (result.classification === "conflict") {
		nextActions.push(
			"Open the existing attempt state in the dashboard rather than creating a duplicate start request.",
		);
	} else if (ok) {
		nextActions.push(
			"Continue to dashboard and PR verification after confirming the runner workflow started.",
		);
	}

	emit(
		baseReport({
			ok,
			mode: parsed.mode,
			phase: "first-attempt-start",
			facts: {
				input: {
					providedUrl: parsed.url,
					normalizedBaseUrl,
					runId: parsed.runId,
					attemptId: parsed.attemptId,
					useRootPasswordRequested: parsed.useRootPassword,
					applyRequested: parsed.apply,
					yesFlagPresent: parsed.yes,
				},
				rootPassword: {
					available: rootPasswordAvailable,
					source: rootPasswordSource,
					availableWithOptIn: rootPasswordAvailable && parsed.useRootPassword,
				},
				claimToken: {
					available: claimTokenAvailable,
					source: claimTokenSource,
					availableWithOptIn: claimTokenAvailable,
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
			phase: "first-attempt-start",
			facts: {
				input: {
					providedUrl: null,
					normalizedBaseUrl: null,
					runId: null,
					attemptId: null,
					useRootPasswordRequested: false,
					applyRequested: false,
					yesFlagPresent: false,
				},
				rootPassword: {
					available: false,
					source: "missing",
					availableWithOptIn: false,
				},
				claimToken: {
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
				"Rerun with --url, --run-id, and --attempt-id; if this repeats, capture the command and report the script error name.",
			],
			error: error instanceof Error ? error.name : "unexpected script error",
		}),
		1,
	);
});
