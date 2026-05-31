#!/usr/bin/env node

import { resolveRootPasswordForSmoke } from "../env.js";
import { normalizeBaseUrl, postRun } from "../http.js";
import {
	getSetupStatePath,
	recordSetupJourneyState,
	recordSetupState,
	readSetupState,
} from "../state.js";
import type {
	CommandMode,
	FirstIssueInput,
	FirstIssuePostResponse,
	JsonRecord,
	ParseSetupFirstIssueResult,
	LegacyExitCode,
} from "../types.js";

export async function runFirstIssueCommand(
	args: string[],
): Promise<LegacyExitCode> {
	const parse = parseSetupFirstIssueArgs(args);
	if (parse.ok === false) {
		console.error(parse.error);
		process.exit(1);
	}

	const start = Date.now();
	const statePath = getSetupStatePath();
	const state = readSetupState(statePath);
	const persistedFirstIssue = state.journey?.firstRun?.firstIssue;
	const issueNumber = parse.issueNumber ?? persistedFirstIssue?.number ?? null;
	const resolvedUrl =
		parse.url ??
		state.journey?.firstRun?.previewUrl ??
		state.journey?.firstRun?.baseUrl ??
		null;
	let baseUrl: string | null = null;
	let endpoint: string | null = null;
	const payloadShape: JsonRecord = {
		issueNumber: "positive integer",
		claimedBy: "setup-rhapsody",
	};
	const blockers: string[] = [];
	const needsUser: string[] = [];
	const nextActions: string[] = [];
	if (!resolvedUrl) {
		blockers.push(
			"Missing --url. Save preview URL via setup and rerun, or pass --url explicitly.",
		);
		nextActions.push(
			"Run `rhapsody setup` to get a saved `<preview-url>`, then rerun `first-issue`.",
		);
	}
	if (issueNumber === null) {
		blockers.push(
			"Missing --issue-number. Save first issue via `rhapsody create-first-issue --yes` or pass --issue-number explicitly.",
		);
		nextActions.push(
			"Run `rhapsody create-first-issue --yes` and then rerun `rhapsody first-issue --url <preview-url>`.",
		);
	}

	try {
		baseUrl = resolvedUrl ? normalizeBaseUrl(resolvedUrl) : null;
		if (baseUrl) {
			endpoint = `${baseUrl}/api/v1/runs`;
		}
	} catch {
		blockers.push("The --url value must be a valid absolute URL.");
		nextActions.push(
			"Retry with a valid preview URL such as https://preview-url.vercel.app in dry-run mode.",
		);
	}

	const rootPassword = resolveRootPasswordForSmoke();
	const rootPasswordAvailable = Boolean(rootPassword);
	const rootPasswordSource = rootPassword?.source ?? "missing";

	if (blockers.length > 0) {
		recordSetupState({
			command: "first-issue",
			mode: parse.mode,
			baseUrl: resolvedUrl,
			endpoint: null,
			issueNumber,
			rootPassword: {
				requested: parse.useRootPassword,
				available: false,
				source: "missing",
			},
			nextAction: "blocked",
			blockers,
			nextActions,
		});
		printSetupFirstIssueResult({
			json: parse.json,
			ok: false,
			mode: parse.mode,
			baseUrl: resolvedUrl,
			endpoint: null,
			issueNumber,
			statePath,
			rootPassword: {
				requested: parse.useRootPassword,
				available: false,
				source: "missing",
			},
			payloadShape,
			blockers,
			needsUser,
			nextActions,
			elapsedMs: Date.now() - start,
		});
		process.exit(1);
	}

	if (parse.mode === "dry-run") {
		if (!parse.useRootPassword) {
			needsUser.push("Pass --use-root-password to authorize apply mode.");
			nextActions.push(
				"Run with --apply --yes --use-root-password to execute the handoff once ready.",
			);
		}
		recordSetupState({
			command: "first-issue",
			mode: parse.mode,
			baseUrl,
			endpoint,
			issueNumber,
			rootPassword: {
				requested: parse.useRootPassword,
				available: rootPasswordAvailable,
				source: rootPasswordSource,
			},
			nextAction: "ready",
			blockers,
			nextActions,
		});
		printSetupFirstIssueResult({
			json: parse.json,
			ok: blockers.length === 0,
			mode: parse.mode,
			baseUrl,
			endpoint,
			issueNumber,
			statePath,
			rootPassword: {
				requested: parse.useRootPassword,
				available: rootPasswordAvailable,
				source: rootPasswordSource,
			},
			payloadShape,
			blockers,
			needsUser,
			nextActions,
			elapsedMs: Date.now() - start,
		});
		process.exit(0);
	}

	if (!parse.apply || !parse.yes) {
		console.error(
			"Apply mode requires both --apply and --yes. Use neither for dry-run.",
		);
		process.exit(1);
	}

	if (!parse.useRootPassword) {
		blockers.push(
			"Apply requires --use-root-password for the ROOT_PASSWORD bearer token.",
		);
		nextActions.push(
			"Re-run with --apply --yes --use-root-password to execute the handoff.",
		);
	}

	if (!rootPasswordAvailable) {
		blockers.push(
			"ROOT_PASSWORD is missing from process env or apps/app/.env.local.",
		);
		nextActions.push("Set ROOT_PASSWORD and rerun the same command.");
	}

	let response: FirstIssuePostResponse | null = null;
	if (
		blockers.length === 0 &&
		endpoint &&
		rootPassword &&
		issueNumber !== null
	) {
		const resolvedIssueNumber = issueNumber;
		response = await postRun({
			endpoint,
			token: rootPassword.value,
			issueNumber: resolvedIssueNumber,
		});
	}

	const ok = response?.classification === "ok";
	if (!ok && response) {
		if (response.classification === "validation-error") {
			blockers.push(
				"Preview rejected the payload with 400 validation; check issue exists and is routable.",
			);
		} else if (response.classification === "unauthorized") {
			blockers.push("Preview rejected ROOT_PASSWORD with 401.");
		} else if (response.classification === "existing-run") {
			nextActions.push(
				"A manual run already exists for this issue. Continue in dashboard.",
			);
		} else if (
			response.classification === "network-error" ||
			response.classification === "server-error"
		) {
			blockers.push("Request failed at the preview endpoint.");
			nextActions.push(
				"Check the deployment and network visibility, then rerun with --apply.",
			);
		} else {
			blockers.push(`Request failed with ${response.classification}.`);
			nextActions.push(
				"Retry the same command after fixing the reported issue.",
			);
		}
	}

	recordSetupState({
		command: "first-issue",
		mode: parse.mode,
		baseUrl,
		endpoint,
		issueNumber,
		rootPassword: {
			requested: parse.useRootPassword,
			available: rootPasswordAvailable,
			source: rootPasswordSource,
		},
		response: response
			? {
					status: response.status,
					classification: response.classification,
					runId: response.runId,
					attemptId: response.attemptId,
				}
			: null,
		nextAction: ok
			? "complete"
			: response?.classification === "existing-run"
				? "ready"
				: "failed",
		blockers,
		nextActions,
	});

	recordSetupJourneyState({
		firstRun: {
			baseUrl: baseUrl ?? undefined,
			previewUrl: baseUrl ?? undefined,
			currentStep: ok ? "start-attempt-ready" : "first-issue",
			completedSteps: ok ? ["first-issue"] : ["smoke-test"],
			nextActions: [
				`Run \`rhapsody start-attempt --url ${baseUrl ?? "<preview-url>"} --run-id ${response?.runId ?? "<run-id>"} --attempt-id ${response?.attemptId ?? "<attempt-id>"} --use-root-password\`.`,
			],
			blockers: blockers,
			lastCommand: "first-issue",
			...(issueNumber !== null
				? {
						firstIssue: {
							number: issueNumber,
							url: persistedFirstIssue?.url ?? `issue://local/${issueNumber}`,
							source: parse.issueProvided ? "manual" : "created",
						},
					}
				: {}),
			...(response?.runId ? { runId: response.runId } : {}),
			...(response?.attemptId ? { attemptId: response.attemptId } : {}),
		},
	});

	printSetupFirstIssueResult({
		json: parse.json,
		ok,
		mode: parse.mode,
		baseUrl,
		endpoint,
		issueNumber,
		statePath,
		rootPassword: {
			requested: parse.useRootPassword,
			available: rootPasswordAvailable,
			source: rootPasswordSource,
		},
		payloadShape,
		response,
		blockers,
		needsUser,
		nextActions,
		elapsedMs: Date.now() - start,
	});
	process.exit(ok ? 0 : 1);
	return ok ? 0 : 1;
}

function parseSetupFirstIssueArgs(args: string[]): ParseSetupFirstIssueResult {
	if (args.includes("--help") || args.includes("-h")) {
		return {
			ok: false,
			error:
				"Usage: rhapsody first-issue [--url <preview-url>] [--issue-number <n>] [--json] [--use-root-password]\n       rhapsody first-issue [--url <preview-url>] [--issue-number <n>] --apply --yes --use-root-password [--json]",
		};
	}

	let url = null;
	let issueNumberText = null;
	const apply = args.includes("--apply");
	const yes = args.includes("--yes");
	const useRootPassword = args.includes("--use-root-password");

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "first-issue") continue;
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
		if (arg === "--issue-number") {
			const value = args[i + 1];
			if (!value || value.startsWith("--")) {
				return { ok: false, error: "Missing value for --issue-number." };
			}
			issueNumberText = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--issue-number=")) {
			issueNumberText = arg.slice("--issue-number=".length);
			continue;
		}
		if (
			arg === "--apply" ||
			arg === "--yes" ||
			arg === "--use-root-password" ||
			arg === "--json"
		) {
			continue;
		}
		return { ok: false, error: `Unsupported argument: ${arg}` };
	}

	let issueNumber: number | null = null;
	if (issueNumberText !== null) {
		const parsedIssueNumber = Number.parseInt(issueNumberText, 10);
		if (!Number.isInteger(parsedIssueNumber) || parsedIssueNumber <= 0) {
			return { ok: false, error: "--issue-number must be a positive integer." };
		}
		issueNumber = parsedIssueNumber;
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
		issueNumber,
		mode: apply ? "apply" : "dry-run",
		apply,
		yes,
		useRootPassword,
		json: args.includes("--json"),
		urlProvided: url !== null,
		issueProvided: issueNumberText !== null,
	};
}

function printSetupFirstIssueResult({
	json,
	ok,
	mode,
	baseUrl,
	endpoint,
	issueNumber,
	statePath,
	rootPassword,
	payloadShape,
	response,
	blockers,
	needsUser,
	nextActions,
	elapsedMs,
}: FirstIssueInput & { issueNumber: number | null }) {
	if (json) {
		const payload = {
			ok,
			mode,
			phase: "first-issue",
			baseUrl,
			endpoint,
			issueNumber,
			statePath,
			rootPassword: {
				requested: rootPassword.requested,
				available: rootPassword.available,
				source: rootPassword.source,
			},
			payloadShape,
			...(response
				? {
						response: {
							status: response.status,
							classification: response.classification,
							...(response.runId ? { runId: response.runId } : {}),
							...(response.attemptId ? { attemptId: response.attemptId } : {}),
							...(response.objectKeys
								? { objectKeys: response.objectKeys }
								: {}),
						},
					}
				: {}),
			blockers,
			needsUser,
			nextActions,
			elapsedMs,
		};
		console.log(JSON.stringify(payload, null, 2));
		return;
	}

	console.log(`Rhapsody setup first-issue (${mode})`);
	console.log(`Base URL: ${baseUrl}`);
	console.log(`Endpoint: ${endpoint}`);
	console.log(`Issue number: ${issueNumber}`);
	console.log(`State path: ${statePath}`);
	console.log(
		`Root password requested=${rootPassword.requested} available=${rootPassword.available} source=${rootPassword.source}`,
	);
	console.log(`Payload shape: ${JSON.stringify(payloadShape)}`);
	if (response) {
		console.log(
			`Response status=${response.status} classification=${response.classification}`,
		);
		if (response.runId) {
			console.log(`runId=${response.runId}`);
		}
		if (response.attemptId) {
			console.log(`attemptId=${response.attemptId}`);
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
