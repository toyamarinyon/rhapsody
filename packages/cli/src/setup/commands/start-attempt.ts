#!/usr/bin/env node
import {
	fetchRunClaimToken,
	normalizeBaseUrl,
	postStartAttempt,
} from "../http.js";
import {
	resolveClaimTokenForSetup,
	resolveRootPasswordForSmoke,
} from "../env.js";
import { getSetupStatePath, recordSetupState } from "../state.js";
import type {
	CommandMode,
	JsonRecord,
	StartAttemptInput,
	StartAttemptPostResponse,
	ParseSetupStartAttemptResult,
	LegacyExitCode,
} from "../types.js";

export async function runStartAttemptCommand(
	args: string[],
): Promise<LegacyExitCode> {
	const parse = parseSetupStartAttemptArgs(args);
	if (parse.ok === false) {
		console.error(parse.error);
		process.exit(1);
	}

	const start = Date.now();
	const statePath = getSetupStatePath();
	let baseUrl: string | null = null;
	let endpoint: string | null = null;
	let runDetailEndpoint: string | null = null;
	const payloadShape: JsonRecord = { claimToken: "redacted" };
	const blockers: string[] = [];
	const needsUser: string[] = [];
	const nextActions: string[] = [];

	const rootPassword = resolveRootPasswordForSmoke();
	const claimTokenLocal = resolveClaimTokenForSetup();

	const rootPasswordMetadata = {
		requested: parse.useRootPassword,
		available: Boolean(rootPassword),
		source: rootPassword?.source ?? "missing",
	};
	const claimTokenMetadata = {
		available: Boolean(claimTokenLocal),
		source: claimTokenLocal?.source ?? "missing",
	};

	try {
		baseUrl = normalizeBaseUrl(parse.url);
		endpoint = `${baseUrl}/api/v1/runs/${parse.runId}/attempts/${parse.attemptId}/start`;
		runDetailEndpoint = `${baseUrl}/api/v1/runs/${parse.runId}`;
	} catch {
		blockers.push("The --url value must be a valid absolute URL.");
		nextActions.push(
			"Retry with a valid preview URL such as https://preview-url.vercel.app in dry-run mode.",
		);
	}

	if (parse.mode === "dry-run") {
		if (!parse.useRootPassword) {
			needsUser.push("Pass --use-root-password to authorize apply mode.");
			nextActions.push(
				"Run with --apply --yes --use-root-password to execute the attempt start.",
			);
		}
		recordSetupState({
			command: "start-attempt",
			mode: parse.mode,
			baseUrl,
			endpoint,
			runId: parse.runId,
			attemptId: parse.attemptId,
			rootPassword: rootPasswordMetadata,
			claimToken: claimTokenMetadata,
			nextAction: blockers.length ? "blocked" : "ready",
			blockers,
			nextActions,
		});
		printSetupStartAttemptResult({
			json: parse.json,
			ok: blockers.length === 0,
			mode: parse.mode,
			baseUrl,
			endpoint,
			runId: parse.runId,
			attemptId: parse.attemptId,
			statePath,
			rootPassword: rootPasswordMetadata,
			claimToken: claimTokenMetadata,
			payloadShape,
			blockers,
			needsUser,
			nextActions,
			elapsedMs: Date.now() - start,
		});
		process.exit(0);
	}

	if (!parse.apply || !parse.yes || !parse.useRootPassword) {
		console.error(
			"Apply mode requires --apply, --yes, and --use-root-password. Use neither for dry-run.",
		);
		process.exit(1);
	}

	if (!rootPassword) {
		blockers.push(
			"ROOT_PASSWORD is missing from process env or apps/app/.env.local.",
		);
		nextActions.push("Set ROOT_PASSWORD and rerun the same command.");
	}

	let resolvedClaimToken = claimTokenLocal?.value ?? null;
	if (!resolvedClaimToken && rootPassword && runDetailEndpoint) {
		const runLookup = await fetchRunClaimToken({
			endpoint: runDetailEndpoint,
			token: rootPassword.value,
		});
		if (runLookup.status !== 200 || !runLookup.claimToken) {
			blockers.push(
				runLookup.status === null
					? "Failed to fetch run detail."
					: runLookup.claimToken
						? "Run detail response parsing failed."
						: "Run detail did not include a claimToken.",
			);
			nextActions.push(
				"Confirm the URL and run ID, then rerun with --apply --yes --use-root-password.",
			);
		} else {
			resolvedClaimToken = runLookup.claimToken;
			claimTokenMetadata.available = true;
			claimTokenMetadata.source = "run-detail";
		}
	}

	if (!resolvedClaimToken && !claimTokenLocal) {
		needsUser.push(
			"Set RHAPSODY_CLAIM_TOKEN in process env or apps/app/.env.local.",
		);
	}

	let response: StartAttemptPostResponse | null = null;
	if (blockers.length === 0 && endpoint && resolvedClaimToken && rootPassword) {
		response = await postStartAttempt({
			endpoint,
			token: rootPassword.value,
			claimToken: resolvedClaimToken,
		});
	}

	const ok = response?.classification === "ok";
	if (!ok && response) {
		if (response.classification === "validation-error") {
			blockers.push("Preview rejected the payload with 400 validation.");
		} else if (response.classification === "unauthorized") {
			blockers.push("Preview rejected ROOT_PASSWORD with 401.");
		} else if (response.classification === "not-found") {
			blockers.push("Run or attempt was not found.");
		} else if (response.classification === "already-started") {
			nextActions.push("The attempt already exists; inspect dashboard state.");
		} else if (
			response.classification === "network-error" ||
			response.classification === "server-error"
		) {
			blockers.push("Request failed at the preview endpoint.");
		} else {
			blockers.push(`Request failed with ${response.classification}.`);
		}
	}

	if (response && !ok) {
		nextActions.push(
			"Check the preview URL and run/attempt IDs, then retry with valid auth.",
		);
	}
	if (ok) {
		nextActions.push(
			"Attempt start accepted. Verify the run in the dashboard and continue to monitoring.",
		);
	}

	recordSetupState({
		command: "start-attempt",
		mode: parse.mode,
		baseUrl,
		endpoint,
		runId: parse.runId,
		attemptId: parse.attemptId,
		rootPassword: rootPasswordMetadata,
		claimToken: claimTokenMetadata,
		response: response
			? {
					status: response.status,
					classification: response.classification,
					...(response.runnerWorkflowRunId
						? { runnerWorkflowRunId: response.runnerWorkflowRunId }
						: {}),
				}
			: null,
		nextAction: ok ? "complete" : blockers.length ? "blocked" : "failed",
		blockers,
		nextActions,
	});
	printSetupStartAttemptResult({
		json: parse.json,
		ok,
		mode: parse.mode,
		baseUrl,
		endpoint,
		runId: parse.runId,
		attemptId: parse.attemptId,
		statePath,
		rootPassword: rootPasswordMetadata,
		claimToken: claimTokenMetadata,
		payloadShape,
		response,
		blockers,
		needsUser,
		nextActions,
		elapsedMs: Date.now() - start,
	});
	process.exit(ok ? 0 : 1);
}

function parseSetupStartAttemptArgs(
	args: string[],
): ParseSetupStartAttemptResult {
	if (args.includes("--help") || args.includes("-h")) {
		return {
			ok: false,
			error:
				"Usage: rhapsody start-attempt --url <preview-url> --run-id <runId> --attempt-id <attemptId> [--json] [--use-root-password]\n       rhapsody start-attempt --url <preview-url> --run-id <runId> --attempt-id <attemptId> --apply --yes --use-root-password [--json]",
		};
	}

	let url = null;
	let runId = null;
	let attemptId = null;
	const apply = args.includes("--apply");
	const yes = args.includes("--yes");
	const useRootPassword = args.includes("--use-root-password");

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "start-attempt") {
			continue;
		}
		if (arg === "--url") {
			const value = args[i + 1];
			if (!value || value.startsWith("--")) {
				return { ok: false, error: "Missing value for --url." };
			}
			url = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--url=")) {
			url = arg.slice("--url=".length);
			continue;
		}
		if (arg === "--run-id") {
			const value = args[i + 1];
			if (!value || value.startsWith("--")) {
				return { ok: false, error: "Missing value for --run-id." };
			}
			runId = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--run-id=")) {
			runId = arg.slice("--run-id=".length);
			continue;
		}
		if (arg === "--attempt-id") {
			const value = args[i + 1];
			if (!value || value.startsWith("--")) {
				return { ok: false, error: "Missing value for --attempt-id." };
			}
			attemptId = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--attempt-id=")) {
			attemptId = arg.slice("--attempt-id=".length);
			continue;
		}
		if (
			arg === "--apply" ||
			arg === "--yes" ||
			arg === "--json" ||
			arg === "--use-root-password"
		) {
			continue;
		}
		return { ok: false, error: `Unsupported argument: ${arg}` };
	}

	if (!url) {
		return {
			ok: false,
			error:
				"Missing required --url argument. Example: rhapsody start-attempt --url https://preview-url.vercel.app --run-id 123 --attempt-id abc",
		};
	}
	if (!runId) {
		return {
			ok: false,
			error:
				"Missing required --run-id argument. Example: rhapsody start-attempt --url https://preview-url.vercel.app --run-id 123 --attempt-id abc",
		};
	}
	if (!attemptId) {
		return {
			ok: false,
			error:
				"Missing required --attempt-id argument. Example: rhapsody start-attempt --url https://preview-url.vercel.app --run-id 123 --attempt-id abc",
		};
	}
	if (apply !== yes) {
		return {
			ok: false,
			error:
				"Apply mode requires both --apply and --yes. Use neither for dry-run.",
		};
	}

	return {
		ok: true,
		url,
		runId,
		attemptId,
		mode: apply ? "apply" : "dry-run",
		apply,
		yes,
		useRootPassword,
		json: args.includes("--json"),
	};
}

function printSetupStartAttemptResult({
	json,
	ok,
	mode,
	baseUrl,
	endpoint,
	runId,
	attemptId,
	statePath,
	rootPassword,
	claimToken,
	payloadShape,
	response,
	blockers,
	needsUser,
	nextActions,
	elapsedMs,
}: StartAttemptInput & { attemptId: string; runId: string }) {
	if (json) {
		const payload = {
			ok,
			mode,
			phase: "start-attempt",
			baseUrl,
			endpoint,
			runId,
			attemptId,
			statePath,
			rootPassword: {
				requested: rootPassword.requested,
				available: rootPassword.available,
				source: rootPassword.source,
			},
			claimToken: {
				available: claimToken.available,
				source: claimToken.source,
			},
			payloadShape,
			...(response
				? {
						response: {
							status: response.status,
							classification: response.classification,
							...(response.runnerWorkflowRunId
								? { runnerWorkflowRunId: response.runnerWorkflowRunId }
								: {}),
							...(response.objectKeys
								? { objectKeys: response.objectKeys }
								: {}),
						},
					}
				: {}),
			blockers,
			nextActions,
			needsUser,
			elapsedMs,
		};
		console.log(JSON.stringify(payload, null, 2));
		return;
	}

	console.log(`Rhapsody setup start-attempt (${mode})`);
	console.log(`Base URL: ${baseUrl}`);
	console.log(`Endpoint: ${endpoint}`);
	console.log(`Run ID: ${runId}`);
	console.log(`Attempt ID: ${attemptId}`);
	console.log(`State path: ${statePath}`);
	console.log(
		`Root password requested=${rootPassword.requested} available=${rootPassword.available} source=${rootPassword.source}`,
	);
	console.log(
		`Claim token available=${claimToken.available} source=${claimToken.source}`,
	);
	console.log(`Payload shape: ${JSON.stringify(payloadShape)}`);
	if (response) {
		console.log(
			`Response status=${response.status} classification=${response.classification}`,
		);
		if (response.runnerWorkflowRunId) {
			console.log(`runnerWorkflowRunId=${response.runnerWorkflowRunId}`);
		}
		if (response.objectKeys) {
			console.log(`response keys=${response.objectKeys.join(",")}`);
		}
	}
	if (blockers.length > 0) {
		console.log("\nBlockers:");
		for (const blocker of blockers) {
			console.log(`  - ${blocker}`);
		}
	}
	if (needsUser.length > 0) {
		console.log("\nNeeds user:");
		for (const item of needsUser) {
			console.log(`  - ${item}`);
		}
	}
	if (nextActions.length > 0) {
		console.log("\nNext actions:");
		for (const action of nextActions) {
			console.log(`  - ${action}`);
		}
	}
	console.log(`Elapsed: ${elapsedMs}ms`);
}
