#!/usr/bin/env node
import {
	copyFileSync,
	unlinkSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };
type JsonRecord = Record<string, JsonValue>;
type JsonObject = Record<string, unknown>;

type ParseResult<TData> = ({ ok: true } & TData) | { ok: false; error: string };

function isParseFailure<TData>(
	value: ParseResult<TData>,
): value is { ok: false; error: string } {
	return value.ok === false;
}

type CommandMode = "apply" | "dry-run";

type RootPasswordSource = "process" | ".env.local" | "missing";
type ClaimTokenSource = "process" | ".env.local" | "run-detail" | "missing";
type Region = "iad1" | "cle1" | "pdx1" | "dub1" | "bom1" | "hnd1";
type VercelTokenLookup = string | null;

type EnvSnapshot = Record<string, string>;

type SmokeClassification =
	| "ok"
	| "network-error"
	| "redirect"
	| "status-3xx"
	| `status-${number}`
	| "admin-auth-missing"
	| "auth-required"
	| "forbidden";

type FirstIssuePostClassification =
	| "ok"
	| "validation-error"
	| "unauthorized"
	| "existing-run"
	| "network-error"
	| "server-error"
	| `status-${number}`;

type StartAttemptClassification =
	| "ok"
	| "validation-error"
	| "unauthorized"
	| "not-found"
	| "already-started"
	| "network-error"
	| "server-error"
	| `status-${number}`;

type PostResponseBase = {
	status: number | null;
	contentType: string | null;
	classification: string | `status-${number}`;
	objectKeys: string[] | null;
	error?: string;
};

type FirstIssuePostResponse = PostResponseBase & {
	classification: FirstIssuePostClassification;
	runId: string | null;
	attemptId: string | null;
};

type StartAttemptPostResponse = PostResponseBase & {
	classification: StartAttemptClassification;
	runnerWorkflowRunId: string | null;
};

type RunClaimResponse = PostResponseBase & {
	classification: StartAttemptClassification;
	claimToken: string | null;
};

type SyncCommandResult = {
	ok: boolean;
	stdout: string;
	stderr: string;
};

type RunResult = {
	ok: boolean;
	exitCode: number;
	signal: string | null;
};

type SecretResolution<TSource extends string> = {
	value: string;
	source: TSource;
};

type ParseSetupCheckProjectsResult = ParseResult<{ json: boolean }>;

type ParseSetupSmokeTestResult = ParseResult<{
	url: string;
	json: boolean;
	useRootPassword: boolean;
}>;

type ParseSetupCreateFirstIssueResult = ParseResult<{
	mode: CommandMode;
	yes: boolean;
	dryRun: boolean;
	title: string;
	body: string;
	json: boolean;
}>;
type ParseSetupCreateFirstIssueSuccess = Extract<
	ParseSetupCreateFirstIssueResult,
	{ ok: true }
>;

type ParseSetupFirstIssueResult = ParseResult<{
	url: string;
	issueNumber: number;
	mode: CommandMode;
	apply: boolean;
	yes: boolean;
	useRootPassword: boolean;
	json: boolean;
}>;

type ParseSetupStartAttemptResult = ParseResult<{
	url: string;
	runId: string;
	attemptId: string;
	mode: CommandMode;
	apply: boolean;
	yes: boolean;
	useRootPassword: boolean;
	json: boolean;
}>;

type ParseSetupPlanResult = ParseResult<{
	json: boolean;
	region: Region;
}>;

type ParseSetupDeployPreviewResult = ParseResult<{
	json: boolean;
	dryRun: boolean;
	yes: boolean;
}>;

type ParseSetupProvisionTursoResult = ParseResult<{
	json: boolean;
	region: Region;
	dryRun: boolean;
	yes: boolean;
}>;

type ParseSetupWaitEnvResult = ParseResult<{
	json: boolean;
	timeoutSeconds: number;
	intervalSeconds: number;
}>;

type SetupPlanPhase = {
	name: string;
	command: string;
	status: "ready" | "blocked";
};

type SetupPlanResult = {
	ok: boolean;
	region: Region;
	phases: SetupPlanPhase[];
	commands: string[];
	nextActions: string[];
};

type DeployPreviewPlanResult = {
	ok: boolean;
	appRoot: string;
	statePath: string;
	blockers: string[];
	plannedCommands: string[];
	commandPlan: Array<{ name: string; argv: string[] }>;
	nextActions: string[];
	command?: string;
	mode?: CommandMode;
	applyConfirmationRequired?: boolean;
	applyConfirmationProvided?: boolean;
	region?: Region;
	linkDir?: string;
	wouldWriteProjectJson?: boolean;
	expectedEnvKeys?: string[];
};

type CreateFirstIssuePlanResult = {
	ok: boolean;
	mode: CommandMode;
	statePath: string;
	repository: string | null;
	title: string;
	bodyPreview: string;
	plannedCommand: string;
	commandArgv: string[];
	blockers: string[];
	nextActions: string[];
	issue: { number: number; url: string } | null;
};

type CreateFirstIssueApplyResult = {
	ok: boolean;
	issue: { number: number; url: string } | null;
	blockers: string[];
	nextActions: string[];
};

type WaitEnvResult = {
	ok: boolean;
	requiredEnvKeys: string[];
	presentEnvKeys: string[];
	missingEnvKeys: string[];
	timeoutSeconds: number;
	intervalSeconds: number;
	elapsedMs: number;
	statePath: string;
	nextActions: string[];
};

type ParsedIssueCreateOutput =
	| {
			ok: false;
			error: string;
	  }
	| {
			ok: true;
			issueUrl: string;
			issueNumber: number;
	  };

type SetupStateFile = {
	lastUpdatedAt?: string | null;
	commandState?: {
		command?: string | null;
		nextAction?: string | null;
		[x: string]: unknown;
	};
};

type FirstIssueRootPasswordState = {
	requested: boolean;
	available: boolean;
	source: RootPasswordSource;
};

type ClaimTokenState = {
	available: boolean;
	source: ClaimTokenSource;
};

type FirstIssueInput = {
	json: boolean;
	ok: boolean;
	mode: CommandMode;
	baseUrl: string | null;
	endpoint: string | null;
	issueNumber: number;
	statePath: string;
	rootPassword: FirstIssueRootPasswordState;
	payloadShape: JsonRecord;
	response?: FirstIssuePostResponse | null;
	blockers: string[];
	needsUser: string[];
	nextActions: string[];
	elapsedMs: number;
};

type StartAttemptInput = {
	json: boolean;
	ok: boolean;
	mode: CommandMode;
	baseUrl: string | null;
	endpoint: string | null;
	runId: string;
	attemptId: string;
	statePath: string;
	rootPassword: FirstIssueRootPasswordState;
	claimToken: ClaimTokenState;
	payloadShape: JsonRecord;
	response?: StartAttemptPostResponse | null;
	blockers: string[];
	needsUser: string[];
	nextActions: string[];
	elapsedMs: number;
};

type SetupSmokeResult = {
	ok: boolean;
	phase: "smoke-test";
	baseUrl: string;
	statePath: string;
	checks: Array<{
		name: string;
		url: string;
		status: number | null;
		classification: SmokeClassification | `status-${number}`;
		ok: boolean;
	}>;
	rootPassword: FirstIssueRootPasswordState;
	blockers: string[];
	nextActions: string[];
	elapsedMs: number;
};

const SMOKE_TEST_TIMEOUT_MS = 12_000;
const command = process.argv[2] ?? "help";
const subcommand = process.argv[3];
const flags = new Set(process.argv.slice(3));
const cliArgs = process.argv.slice(3);
const DEFAULT_FIRST_ISSUE_TITLE = "Rhapsody smoke-test issue";
const DEFAULT_FIRST_ISSUE_BODY =
	"Smoke test issue created by setup:create-first-issue for first-run handoff validation.";
const BODY_PREVIEW_MAX = 120;
let handledSetupCommand = false;

if (command === "setup") {
	if (subcommand === "first-issue") {
		handledSetupCommand = true;
		const parse = parseSetupFirstIssueArgs(cliArgs);
		if (parse.ok === false) {
			console.error(parse.error);
			process.exit(1);
		}

		const start = Date.now();
		const statePath = getSetupStatePath();
		const issueNumber = parse.issueNumber;
		let baseUrl: string | null = null;
		let endpoint: string | null = null;
		const payloadShape: JsonRecord = {
			issueNumber: "positive integer",
			claimedBy: "setup-rhapsody",
		};
		const blockers: string[] = [];
		const needsUser: string[] = [];
		const nextActions: string[] = [];

		try {
			baseUrl = normalizeBaseUrl(parse.url);
			endpoint = `${baseUrl}/api/v1/runs`;
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
				baseUrl: parse.url,
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
				baseUrl: parse.url,
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
		if (blockers.length === 0) {
			if (endpoint && rootPassword) {
				response = await postRun({
					endpoint,
					token: rootPassword.value,
					issueNumber,
				});
			}
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
	}
	if (subcommand === "start-attempt") {
		handledSetupCommand = true;
		const parse = parseSetupStartAttemptArgs(cliArgs);
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
		if (
			blockers.length === 0 &&
			endpoint &&
			resolvedClaimToken &&
			rootPassword
		) {
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
				nextActions.push(
					"The attempt already exists; inspect dashboard state.",
				);
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

	if (subcommand === "check-projects") {
		handledSetupCommand = true;
		const parse = parseSetupCheckProjectsArgs(cliArgs);
		if (parse.ok === false) {
			console.error(parse.error);
			process.exit(1);
		}
		const readiness = collectProjectReadiness();
		printSetupCheckProjects({ json: parse.json, readiness });
		recordSetupState({
			command: "check-projects",
			nextAction: readiness.ok ? "complete" : "blocked",
			statePath: readiness.statePath,
			blockers: readiness.blockers,
			nextActions: readiness.nextActions,
			github: {
				installed: readiness.github.installed,
				authTokenPresent: readiness.github.authTokenPresent,
				remoteUrl: readiness.github.remoteUrl,
				repository: readiness.github.repository,
				repoReadable: readiness.github.repoReadable,
				repoSummary: readiness.github.repoSummary,
			},
			vercel: {
				installed: readiness.vercel.installed,
				tokenPresent: readiness.vercel.tokenPresent,
				projectLink: readiness.vercel.projectLink,
			},
		});
		process.exit(readiness.ok ? 0 : 1);
	}
	if (subcommand === "create-first-issue") {
		handledSetupCommand = true;
		const parse = parseSetupCreateFirstIssueArgs(cliArgs);
		if (parse.ok === false) {
			console.error(parse.error);
			process.exit(1);
		}

		const plan = buildCreateFirstIssuePlan({
			parse: parse as ParseSetupCreateFirstIssueSuccess,
			statePath: getSetupStatePath(),
		});
		if (plan.mode === "dry-run") {
			recordSetupState({
				command: "create-first-issue",
				mode: plan.mode,
				statePath: plan.statePath,
				repository: plan.repository,
				title: plan.title,
				bodyPreview: plan.bodyPreview,
				blockers: plan.blockers,
				nextAction: plan.blockers.length ? "blocked" : "ready",
				nextActions: plan.nextActions,
			});
			printCreateFirstIssueResult({ json: parse.json, plan });
			process.exit(plan.blockers.length ? 1 : 0);
		}

		if (plan.blockers.length > 0) {
			recordSetupState({
				command: "create-first-issue",
				mode: plan.mode,
				statePath: plan.statePath,
				repository: plan.repository,
				title: plan.title,
				bodyPreview: plan.bodyPreview,
				blockers: plan.blockers,
				nextAction: "blocked",
				nextActions: plan.nextActions,
			});
			printCreateFirstIssueResult({ json: parse.json, plan });
			process.exit(1);
		}

		const apply = runCreateFirstIssueApply(plan);
		recordSetupState({
			command: "create-first-issue",
			mode: plan.mode,
			statePath: plan.statePath,
			repository: plan.repository,
			title: plan.title,
			bodyPreview: plan.bodyPreview,
			issue: apply.issue,
			blockers: apply.blockers,
			nextAction: apply.ok ? "complete" : "failed",
			nextActions: apply.nextActions,
		});
		printCreateFirstIssueResult({
			json: parse.json,
			plan: {
				...plan,
				ok: apply.ok,
				issue: apply.issue,
				blockers: apply.blockers,
				nextActions: apply.nextActions,
			},
		});
		process.exit(apply.ok ? 0 : 1);
	}
	if (subcommand === "plan") {
		handledSetupCommand = true;
		const parse = parseSetupPlanArgs(cliArgs);
		if (parse.ok === false) {
			console.error(parse.error);
			process.exit(1);
		}
		const { json } = parse;
		const region = parse.region;
		const status = collectSetupStatus();
		const planned = buildSetupPlan({ status, region });
		printSetupPlan({ json, plan: planned });
		process.exit(planned.ok ? 0 : 0);
	}
	if (subcommand === "deploy-preview") {
		handledSetupCommand = true;
		const parse = parseDeployPreviewArgs(cliArgs);
		if (parse.ok === false) {
			console.error(parse.error);
			process.exit(1);
		}

		const status = collectSetupStatus();
		const plan = buildDeployPreviewPlan({ status });
		const mode = parse.dryRun ? "dry-run" : "apply";
		const statePath = plan.statePath;

		recordSetupState({
			command: "deploy-preview",
			mode,
			appRoot: plan.appRoot,
			statePath,
			plannedCommands: plan.plannedCommands,
			blockers: plan.blockers,
			before: {
				commandCount: plan.plannedCommands.length,
			},
			nextAction: plan.ok ? "ready" : "blocked",
		});

		if (!parse.dryRun && !parse.yes) {
			console.error(
				"rhapsody setup deploy-preview requires confirmation in apply mode. Pass --yes to execute.",
			);
			recordSetupState({
				command: "deploy-preview",
				mode,
				appRoot: plan.appRoot,
				statePath,
				plannedCommands: plan.plannedCommands,
				blockers: plan.blockers,
				nextAction: "blocked",
				nextActions: plan.nextActions,
			});
			process.exit(1);
		}

		if (parse.dryRun || !plan.ok) {
			printDeployPreviewPlan({
				json: parse.json,
				mode,
				plan,
			});
			recordSetupState({
				command: "deploy-preview",
				mode,
				appRoot: plan.appRoot,
				statePath,
				plannedCommands: plan.plannedCommands,
				blockers: plan.blockers,
				nextAction: plan.ok ? "ready" : "blocked",
				nextActions: plan.nextActions,
			});
			process.exit(plan.ok ? 0 : 1);
		}

		const appliedSteps = [];
		let failed = false;
		for (const step of plan.commandPlan) {
			const result = runCommandFromApp({
				cwd: plan.appRoot,
				argv: step.argv,
			});
			appliedSteps.push({
				command: step.name,
				exitCode: result.exitCode,
				signal: result.signal,
			});
			if (!result.ok) {
				failed = true;
				break;
			}
		}
		const ok = !failed;
		recordSetupState({
			command: "deploy-preview",
			mode,
			appRoot: plan.appRoot,
			statePath,
			plannedCommands: plan.plannedCommands,
			blockers: plan.blockers,
			appliedSteps: appliedSteps.map((step) => ({
				command: step.command,
				exitCode: step.exitCode,
				signal: step.signal,
			})),
			nextAction: ok ? "complete" : "failed",
			nextActions: ok
				? ["Deployment completed. Check app logs and deployment URL."]
				: [
						"Re-run `rhapsody setup deploy-preview --yes` after resolving blocking issues.",
					],
		});

		printDeployPreviewPlan({
			json: parse.json,
			mode,
			plan: {
				...plan,
				appliedSteps: appliedSteps.map((step) => ({
					command: step.command,
					exitCode: step.exitCode,
				})),
			},
		});
		process.exit(ok ? 0 : 1);
	}
	if (subcommand === "wait-env") {
		handledSetupCommand = true;
		const parse = parseWaitEnvArgs(cliArgs);
		if (parse.ok === false) {
			console.error(parse.error);
			process.exit(1);
		}
		const result = waitForEnv({
			timeoutSeconds: parse.timeoutSeconds,
			intervalSeconds: parse.intervalSeconds,
		});
		recordWaitEnvSetupState(result);
		printWaitEnvResult({ json: parse.json, result });
		process.exit(result.ok ? 0 : 1);
	}
	if (subcommand === "provision-turso") {
		handledSetupCommand = true;
		const parse = parseProvisionTursoArgs(cliArgs);
		if (parse.ok === false) {
			console.error(parse.error);
			process.exit(1);
		}
		if (!parse.dryRun && !parse.yes) {
			console.error(
				"rhapsody setup provision-turso requires confirmation in apply mode. Pass --yes to execute.",
			);
			process.exit(1);
		}

		const plan = buildProvisionTursoPlan({ region: parse.region });
		plan.applyConfirmationProvided = parse.yes;
		if (!parse.dryRun && !plan.applyReady) {
			console.error(
				`Cannot execute apply without source .vercel/project.json at ${inferTursoProjectJsonPath()}`,
			);
			process.exit(1);
		}
		if (parse.dryRun) {
			printProvisionTurso({
				json: parse.json,
				plan,
			});
			process.exit(plan.ok ? 0 : 1);
		}

		recordSetupState({
			command: "provision-turso",
			mode: "apply",
			region: parse.region,
			applyConfirmationProvided: parse.yes,
			before: stateSnapshot(plan.linkDir, plan.wouldWriteProjectJson),
			after: {
				linkDir: plan.linkDir,
				linkDirExists: existsSync(plan.linkDir),
				wouldWriteProjectJson: plan.wouldWriteProjectJson,
				preparedProjectJson: existsSync(
					path.join(plan.linkDir, ".vercel", "project.json"),
				),
			},
			nextAction: "prepare-link-dir",
		});

		const prepared = prepareTursoLinkDirectory({
			linkDir: plan.linkDir,
			projectJsonPath: inferTursoProjectJsonPath(),
		});
		recordSetupState({
			command: "provision-turso",
			mode: "apply",
			region: parse.region,
			applyConfirmationProvided: parse.yes,
			before: {
				linkDir: plan.linkDir,
				linkDirExists: existsSync(plan.linkDir),
				wouldWriteProjectJson: plan.wouldWriteProjectJson,
				preparedProjectJson: false,
			},
			after: {
				linkDir: plan.linkDir,
				linkDirExists: existsSync(plan.linkDir),
				wouldWriteProjectJson: plan.wouldWriteProjectJson,
				preparedProjectJson: prepared.prepared,
				projectJsonTarget: prepared.projectJsonTarget,
			},
			nextAction: "run-command",
		});

		const result = runProvisionTursoApply({
			commandArgv: plan.commandArgv,
			cwd: plan.linkDir,
		});
		recordSetupState({
			command: "provision-turso",
			mode: "apply",
			region: parse.region,
			applyConfirmationProvided: parse.yes,
			before: {
				linkDir: plan.linkDir,
				linkDirExists: existsSync(plan.linkDir),
				wouldWriteProjectJson: plan.wouldWriteProjectJson,
				preparedProjectJson: prepared.prepared,
				projectJsonTarget: prepared.projectJsonTarget,
			},
			after: {
				linkDir: plan.linkDir,
				linkDirExists: existsSync(plan.linkDir),
				wouldWriteProjectJson: plan.wouldWriteProjectJson,
				preparedProjectJson: prepared.prepared,
				projectJsonTarget: prepared.projectJsonTarget,
				exitCode: result.exitCode,
				signal: result.signal,
			},
			exitCode: result.exitCode,
			signal: result.signal,
			nextAction: result.ok ? "complete" : "failed",
		});
		process.exit(result.ok ? 0 : 1);
	}
	if (subcommand === "smoke-test") {
		handledSetupCommand = true;
		const parse = parseSetupSmokeTestArgs(cliArgs);
		if (parse.ok === false) {
			console.error(parse.error);
			process.exit(1);
		}
		await runSetupSmokeTest({
			url: parse.url,
			json: parse.json,
			useRootPassword: parse.useRootPassword,
		}).catch((error) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		});
	}
	if (subcommand === "status") {
		handledSetupCommand = true;
		printSetupStatus({ json: flags.has("--json") });
		process.exit(0);
	}
	if (subcommand === "--help" || subcommand === "-h") {
		handledSetupCommand = true;
		printSetupHelp();
		process.exit(0);
	}
	if (!handledSetupCommand) {
		printSetupPreview();
		process.exit(0);
	}
}

if (command === "help" || command === "--help" || command === "-h") {
	printHelp();
	process.exit(0);
}

console.error(`Unknown command: ${command}`);
console.error("Run `rhapsody --help` for available commands.");
process.exit(1);

function printHelp() {
	console.log(`Rhapsody setup CLI

Usage:
  rhapsody setup [--help]

Commands:
  setup   Prepare a self-hosted Rhapsody deployment
`);
}

function printSetupHelp() {
	console.log(`Usage:
  rhapsody setup
  rhapsody setup status [--json]
  rhapsody setup check-projects [--json]
  rhapsody setup plan [--region <iad1|cle1|pdx1|dub1|bom1|hnd1>] [--json]
  rhapsody setup wait-env [--json] [--timeout <seconds>] [--interval <seconds>]
  rhapsody setup create-first-issue [--dry-run] [--json] [--title <title>] [--body <body>]
  rhapsody setup create-first-issue --yes [--json] [--title <title>] [--body <body>]
  rhapsody setup deploy-preview --dry-run [--json]
  rhapsody setup deploy-preview --yes [--json]
  rhapsody setup first-issue --url <preview-url> --issue-number <n> [--json] [--use-root-password]
  rhapsody setup first-issue --url <preview-url> --issue-number <n> --apply --yes --use-root-password [--json]
  rhapsody setup start-attempt --url <preview-url> --run-id <runId> --attempt-id <attemptId> [--json] [--use-root-password]
  rhapsody setup start-attempt --url <preview-url> --run-id <runId> --attempt-id <attemptId> --apply --yes --use-root-password [--json]
  rhapsody setup smoke-test --url <preview-url> [--json] [--use-root-password]
  rhapsody setup provision-turso --dry-run [--region <iad1|cle1|pdx1|dub1|bom1|hnd1>] [--json]
  rhapsody setup provision-turso --yes [--region <iad1|cle1|pdx1|dub1|bom1|hnd1>] [--json]

The setup command will orchestrate the self-hosted Rhapsody install flow.

Planned phases:
  1. Detect gh and Vercel CLI authentication
  2. Prepare or publish the GitHub repository
  3. Create or reuse the Vercel project
  4. Provision Turso through Vercel Marketplace
  5. Configure Vercel environment variables
  6. Run database migration
  7. Deploy and smoke-test Rhapsody
  8. Hand off the first GitHub Project issue
`);
}

function printSetupPlan({
	json,
	plan,
}: {
	json: boolean;
	plan: SetupPlanResult;
}) {
	if (json) {
		console.log(JSON.stringify(plan, null, 2));
		return;
	}

	console.log(`Rhapsody setup plan

Region: ${plan.region}`);

	for (const phase of plan.phases) {
		const marker = phase.status === "blocked" ? "[!]" : "[ ]";
		console.log(`${marker} ${phase.name}`);
		console.log(`    command: ${phase.command}`);
	}

	console.log("\nNext actions:");
	for (const action of plan.nextActions) {
		console.log(`  - ${action}`);
	}
}

function parseSetupCheckProjectsArgs(
	args: string[],
): ParseSetupCheckProjectsResult {
	if (args.includes("--help") || args.includes("-h")) {
		return {
			ok: false,
			error: "Usage: rhapsody setup check-projects [--json]",
		};
	}
	return {
		ok: true,
		json: args.includes("--json"),
	};
}

function parseSetupSmokeTestArgs(args: string[]): ParseSetupSmokeTestResult {
	if (args.includes("--help") || args.includes("-h")) {
		return {
			ok: false,
			error:
				"Usage: rhapsody setup smoke-test --url <preview-url> [--json] [--use-root-password]",
		};
	}

	let url = null;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "smoke-test") {
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
		if (arg === "--json" || arg === "--use-root-password") {
			continue;
		}
		return { ok: false, error: `Unsupported argument: ${arg}` };
	}

	if (!url) {
		return {
			ok: false,
			error:
				"Missing required --url argument. Example: rhapsody setup smoke-test --url https://preview-url.vercel.app",
		};
	}

	return {
		ok: true,
		url,
		json: args.includes("--json"),
		useRootPassword: args.includes("--use-root-password"),
	};
}

function parseSetupCreateFirstIssueArgs(
	args: string[],
): ParseSetupCreateFirstIssueResult {
	if (args.includes("--help") || args.includes("-h")) {
		return {
			ok: false,
			error:
				"Usage: rhapsody setup create-first-issue [--dry-run] [--json] [--title <title>] [--body <body>]\n       rhapsody setup create-first-issue --yes [--json] [--title <title>] [--body <body>]",
		};
	}

	let mode: CommandMode = "dry-run";
	let yes = false;
	let dryRun = false;
	let title = DEFAULT_FIRST_ISSUE_TITLE;
	let body = DEFAULT_FIRST_ISSUE_BODY;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (arg === "--yes") {
			yes = true;
			continue;
		}
		if (arg === "--json") {
			continue;
		}
		if (arg.startsWith("--title=")) {
			title = arg.slice("--title=".length);
			continue;
		}
		if (arg === "--title") {
			const value = args[i + 1];
			if (!value || value.startsWith("--")) {
				return { ok: false, error: "Missing value for --title." };
			}
			title = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--body=")) {
			body = arg.slice("--body=".length);
			continue;
		}
		if (arg === "--body") {
			const value = args[i + 1];
			if (!value || value.startsWith("--")) {
				return { ok: false, error: "Missing value for --body." };
			}
			body = value;
			i += 1;
			continue;
		}
		if (arg === "create-first-issue") {
			continue;
		}
		return { ok: false, error: `Unsupported argument: ${arg}` };
	}

	if (dryRun && yes) {
		return {
			ok: false,
			error: "Use either --dry-run or --yes, not both.",
		};
	}

	if (yes) {
		mode = "apply";
	}

	return {
		ok: true,
		mode,
		yes,
		dryRun,
		title,
		body,
		json: args.includes("--json"),
	};
}

function parseSetupFirstIssueArgs(args: string[]): ParseSetupFirstIssueResult {
	if (args.includes("--help") || args.includes("-h")) {
		return {
			ok: false,
			error:
				"Usage: rhapsody setup first-issue --url <preview-url> --issue-number <n> [--json] [--use-root-password]\n       rhapsody setup first-issue --url <preview-url> --issue-number <n> --apply --yes --use-root-password [--json]",
		};
	}

	let url = null;
	let issueNumberText = null;
	const apply = args.includes("--apply");
	const yes = args.includes("--yes");
	const useRootPassword = args.includes("--use-root-password");

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "first-issue") {
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
		if (arg === "--issue-number") {
			const value = args[i + 1];
			if (!value || value.startsWith("--")) {
				return {
					ok: false,
					error: "Missing value for --issue-number.",
				};
			}
			issueNumberText = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--issue-number=")) {
			issueNumberText = arg.slice("--issue-number=".length);
			continue;
		}
		if (arg === "--apply" || arg === "--yes" || arg === "--use-root-password") {
			continue;
		}
		if (arg === "--json") {
			continue;
		}
		return { ok: false, error: `Unsupported argument: ${arg}` };
	}

	if (!url) {
		return {
			ok: false,
			error:
				"Missing required --url argument. Example: rhapsody setup first-issue --url https://preview-url.vercel.app --issue-number 123",
		};
	}
	if (!issueNumberText) {
		return {
			ok: false,
			error:
				"Missing required --issue-number argument. Example: rhapsody setup first-issue --url https://preview-url.vercel.app --issue-number 123",
		};
	}

	const issueNumber = Number.parseInt(issueNumberText, 10);
	if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
		return { ok: false, error: "--issue-number must be a positive integer." };
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
	};
}

function parseSetupStartAttemptArgs(
	args: string[],
): ParseSetupStartAttemptResult {
	if (args.includes("--help") || args.includes("-h")) {
		return {
			ok: false,
			error:
				"Usage: rhapsody setup start-attempt --url <preview-url> --run-id <runId> --attempt-id <attemptId> [--json] [--use-root-password]\n       rhapsody setup start-attempt --url <preview-url> --run-id <runId> --attempt-id <attemptId> --apply --yes --use-root-password [--json]",
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
				"Missing required --url argument. Example: rhapsody setup start-attempt --url https://preview-url.vercel.app --run-id 123 --attempt-id abc",
		};
	}
	if (!runId) {
		return {
			ok: false,
			error:
				"Missing required --run-id argument. Example: rhapsody setup start-attempt --url https://preview-url.vercel.app --run-id 123 --attempt-id abc",
		};
	}
	if (!attemptId) {
		return {
			ok: false,
			error:
				"Missing required --attempt-id argument. Example: rhapsody setup start-attempt --url https://preview-url.vercel.app --run-id 123 --attempt-id abc",
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
}: FirstIssueInput & { issueNumber: number }) {
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

function printSetupCheckProjects({
	json,
	readiness,
}: {
	json: boolean;
	readiness: ReturnType<typeof collectProjectReadiness>;
}) {
	if (json) {
		console.log(JSON.stringify(readiness, null, 2));
		return;
	}
	console.log(`Rhapsody setup check-projects`);
	console.log(`State path: ${readiness.statePath}`);

	console.log("\nGitHub:");
	console.log(`  installed: ${label(readiness.github.installed)}`);
	if (readiness.github.version) {
		console.log(`  version: ${readiness.github.version}`);
	}
	console.log(
		`  auth token present: ${label(readiness.github.authTokenPresent)}`,
	);
	console.log(`  remote URL: ${readiness.github.remoteUrl ?? "none"}`);
	console.log(`  repository: ${readiness.github.repository ?? "unknown"}`);
	console.log(`  repo readable: ${label(readiness.github.repoReadable)}`);
	if (readiness.github.repoSummary) {
		console.log(`  repo summary: ${readiness.github.repoSummary}`);
	}

	console.log("\nVercel:");
	console.log(`  installed: ${label(readiness.vercel.installed)}`);
	if (readiness.vercel.version) {
		console.log(`  version: ${readiness.vercel.version}`);
	}
	console.log(`  token present: ${label(readiness.vercel.tokenPresent)}`);
	console.log(
		`  project link exists: ${label(readiness.vercel.projectLink.exists)}`,
	);
	console.log(
		`  orgId present: ${label(readiness.vercel.projectLink.orgIdPresent)}`,
	);
	console.log(
		`  projectId present: ${label(readiness.vercel.projectLink.projectIdPresent)}`,
	);

	console.log("\nNext actions:");
	for (const action of readiness.nextActions) {
		console.log(`  - ${action}`);
	}
}

function printSetupSmokeTest({
	json,
	result,
}: {
	json: boolean;
	result: SetupSmokeResult;
}) {
	if (json) {
		console.log(
			JSON.stringify(
				{
					ok: result.ok,
					phase: result.phase,
					baseUrl: result.baseUrl,
					statePath: result.statePath,
					checks: result.checks,
					rootPassword: result.rootPassword,
					blockers: result.blockers,
					nextActions: result.nextActions,
					elapsedMs: result.elapsedMs,
				},
				null,
				2,
			),
		);
		return;
	}

	console.log(`Rhapsody setup smoke-test`);
	console.log(`Base URL: ${result.baseUrl}`);
	console.log(`State path: ${result.statePath}`);
	for (const check of result.checks) {
		const status = check.status == null ? "n/a" : String(check.status);
		console.log(
			`- ${check.name}: ${check.classification} (${status}) ${
				check.ok ? "ok" : "blocked"
			}`,
		);
	}
	console.log(
		`Root password: requested=${result.rootPassword.requested}, available=${result.rootPassword.available}, source=${result.rootPassword.source}`,
	);
	console.log("\nNext actions:");
	for (const action of result.nextActions) {
		console.log(`  - ${action}`);
	}
	if (result.blockers.length > 0) {
		console.log("\nBlockers:");
		for (const blocker of result.blockers) {
			console.log(`  - ${blocker}`);
		}
	}
	console.log(`\nElapsed: ${result.elapsedMs}ms`);
}

function printCreateFirstIssueResult({
	json,
	plan,
}: {
	json: boolean;
	plan: {
		ok: boolean;
		mode: CommandMode;
		statePath: string;
		repository: string | null;
		title: string;
		bodyPreview: string;
		plannedCommand: string;
		blockers: string[];
		nextActions: string[];
		issue?: { number: number; url: string } | null;
	};
}) {
	if (json) {
		console.log(
			JSON.stringify(
				{
					ok: plan.ok,
					mode: plan.mode,
					statePath: plan.statePath,
					repository: plan.repository,
					title: plan.title,
					bodyPreview: plan.bodyPreview,
					plannedCommand: plan.plannedCommand,
					blockers: plan.blockers,
					nextActions: plan.nextActions,
					...(plan.issue ? { issue: plan.issue } : {}),
				},
				null,
				2,
			),
		);
		return;
	}

	console.log(`Rhapsody setup create-first-issue (${plan.mode})`);
	console.log(`Repository: ${plan.repository ?? "unknown"}`);
	console.log(`State path: ${plan.statePath}`);
	console.log(`Planned command: ${plan.plannedCommand}`);
	console.log(`Title: ${plan.title}`);
	console.log(`Body preview: ${plan.bodyPreview}`);
	if (plan.blockers.length > 0) {
		console.log("\nBlockers:");
		for (const blocker of plan.blockers) {
			console.log(`  - ${blocker}`);
		}
	}
	if (plan.issue) {
		console.log(`Created issue: ${plan.issue.url}`);
	}
	if (plan.nextActions.length > 0) {
		console.log("\nNext actions:");
		for (const action of plan.nextActions) {
			console.log(`  - ${action}`);
		}
	}
}

function printProvisionTurso({
	json,
	plan,
}: {
	json: boolean;
	plan: ReturnType<typeof buildProvisionTursoPlan>;
}) {
	if (json) {
		console.log(JSON.stringify(plan, null, 2));
		return;
	}

	console.log(`Rhapsody setup provision-turso (dry-run)`);
	console.log(`
No resources were created in dry-run mode.`);
	console.log(`
Region: ${plan.region}`);
	console.log(`Link dir: ${plan.linkDir}`);
	console.log(
		`Would write .vercel/project.json: ${
			plan.wouldWriteProjectJson ? "yes" : "no"
		}`,
	);
	console.log(`Command to run: ${plan.command}`);
	console.log(`Apply confirmation required: ${plan.applyConfirmationRequired}`);
	console.log(`Apply confirmation provided: ${plan.applyConfirmationProvided}`);
	console.log(`Apply-ready: ${plan.applyReady}`);
	console.log(`Setup state path: ${plan.statePath}`);
	console.log("\nExpected environment variables:");
	for (const envKey of plan.expectedEnvKeys) {
		console.log(`  - ${envKey}`);
	}

	console.log("\nNext actions:");
	for (const action of plan.nextActions) {
		console.log(`  - ${action}`);
	}
}

function printDeployPreviewPlan({
	json,
	mode,
	plan,
}: {
	json: boolean;
	mode: CommandMode;
	plan: DeployPreviewPlanResult & {
		appRoot: string;
		statePath: string;
		plannedCommands: string[];
		appliedSteps?: Array<{
			command: string;
			exitCode: number;
			signal?: string | null;
		}>;
	};
}) {
	const printedPlan = plan;
	if (json) {
		const payload: {
			ok: boolean;
			mode: CommandMode;
			appRoot: string;
			statePath: string;
			plannedCommands: string[];
			blockers: string[];
			nextActions: string[];
			appliedSteps?: Array<{
				command: string;
				exitCode: number;
				signal?: string | null;
			}>;
		} = {
			ok: printedPlan.ok,
			mode,
			appRoot: printedPlan.appRoot,
			statePath: printedPlan.statePath,
			plannedCommands: printedPlan.plannedCommands,
			blockers: printedPlan.blockers,
			nextActions: printedPlan.nextActions,
		};
		if (mode === "apply") {
			payload.appliedSteps = printedPlan.appliedSteps ?? [];
		}
		console.log(JSON.stringify(payload, null, 2));
		return;
	}

	console.log(
		`Rhapsody setup deploy-preview (${mode === "dry-run" ? "dry-run" : "apply"})`,
	);
	console.log(`App root: ${plan.appRoot}`);
	console.log(`State path: ${plan.statePath}`);
	console.log("\nPlanned command names:");
	for (const command of plan.plannedCommands) {
		console.log(`  - ${command}`);
	}
	console.log("\nBlockers:");
	if (plan.blockers.length === 0) {
		console.log("  none");
	} else {
		for (const blocker of plan.blockers) {
			console.log(`  - ${blocker}`);
		}
	}
	if (mode === "apply" && plan.appliedSteps) {
		console.log("\nApplied steps:");
		for (const step of plan.appliedSteps) {
			console.log(`  - ${step.command}: exit ${step.exitCode}`);
		}
	}
	console.log("\nNext actions:");
	for (const action of plan.nextActions) {
		console.log(`  - ${action}`);
	}
}

function printWaitEnvResult({
	json,
	result,
}: {
	json: boolean;
	result: WaitEnvResult;
}) {
	if (json) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}

	console.log(`Rhapsody setup wait-env

Required environment keys: ${result.requiredEnvKeys.join(", ")}`);

	console.log(`Timeout: ${result.timeoutSeconds}s`);
	console.log(`Interval: ${result.intervalSeconds}s`);
	console.log(`Present keys: ${result.presentEnvKeys.join(", ") || "none"}`);
	console.log(`Missing keys: ${result.missingEnvKeys.join(", ") || "none"}`);
	console.log(`Elapsed: ${result.elapsedMs}ms`);
	console.log(`State path: ${result.statePath}`);
	console.log(`Next actions:`);
	for (const action of result.nextActions) {
		console.log(`  - ${action}`);
	}
}

function printSetupPreview() {
	console.log(`Rhapsody setup CLI scaffold is installed.

Next implementation step:
  add authentication and status probes for gh, Vercel CLI, and the app workspace.

For the current helper flow, run:
  pnpm setup:plan
`);
}

function parseSetupPlanArgs(args: string[]): ParseSetupPlanResult {
	const parsedRegion = parseRegionFlag(args);
	if (isParseFailure(parsedRegion)) {
		return { ok: false, error: parsedRegion.error };
	}

	return {
		ok: true,
		json: args.includes("--json"),
		region: parsedRegion.region,
	};
}

function buildCreateFirstIssuePlan({
	parse,
	statePath,
}: {
	parse: ParseSetupCreateFirstIssueSuccess;
	statePath: string;
}): CreateFirstIssuePlanResult {
	const title = parse.title?.trim() ?? DEFAULT_FIRST_ISSUE_TITLE;
	const body = parse.body?.trim() ?? DEFAULT_FIRST_ISSUE_BODY;
	const repository = getCreateFirstIssueRepository();
	const blockers: string[] = [];
	const mode = parse.mode;
	const commandArgv = [
		"gh",
		"issue",
		"create",
		"--repo",
		repository ?? "",
		"--title",
		title,
		"--body",
		body,
	];
	const nextActions: string[] = [];
	const bodyPreview = createBodyPreview(body);
	const commandTarget = repository ?? "<owner/repo>";
	const plannedCommand = `gh issue create --repo ${commandTarget} --title ${quoteForCommandPreview(
		title,
	)} --body ${quoteForCommandPreview(bodyPreview)}`;

	if (!repository) {
		blockers.push(
			"Configure `remote.origin.url` and authenticate gh so setup can identify and access the repository.",
		);
	}
	if (!title) {
		blockers.push("Issue title must be a non-empty string.");
	}
	if (!body) {
		blockers.push("Issue body must be a non-empty string.");
	}

	const ghChecks = collectCreateFirstIssueGhChecks({ repository });
	blockers.push(...ghChecks);

	if (blockers.length > 0) {
		nextActions.push(
			"Fix blockers and rerun `rhapsody setup create-first-issue --dry-run`.",
		);
	} else {
		nextActions.push(
			"Run `rhapsody setup create-first-issue --yes` to create issue.",
		);
	}

	return {
		ok: blockers.length === 0,
		mode,
		statePath,
		repository,
		title,
		bodyPreview,
		plannedCommand,
		blockers,
		commandArgv,
		nextActions,
		issue: null,
	};
}

function parseProvisionTursoArgs(
	args: string[],
): ParseSetupProvisionTursoResult {
	const parsedRegion = parseRegionFlag(args);
	if (isParseFailure(parsedRegion)) {
		return { ok: false, error: parsedRegion.error };
	}

	const dryRun = args.includes("--dry-run");
	if (args.includes("--help") || args.includes("-h")) {
		return {
			ok: false,
			error:
				"Usage: rhapsody setup provision-turso (--dry-run|--yes) [--region <iad1|cle1|pdx1|dub1|bom1|hnd1>] [--json]",
		};
	}

	return {
		ok: true,
		json: args.includes("--json"),
		region: parsedRegion.region,
		dryRun,
		yes: args.includes("--yes"),
	};
}

function parseDeployPreviewArgs(args: string[]): ParseSetupDeployPreviewResult {
	if (args.includes("--help") || args.includes("-h")) {
		return {
			ok: false,
			error: "Usage: rhapsody setup deploy-preview (--dry-run|--yes) [--json]",
		};
	}
	const dryRun = args.includes("--dry-run");
	const yes = args.includes("--yes");
	return {
		ok: true,
		json: args.includes("--json"),
		dryRun,
		yes,
	};
}

function parseRegionFlag(args: string[]): ParseResult<{ region: Region }> {
	const allowedRegions = new Set([
		"iad1",
		"cle1",
		"pdx1",
		"dub1",
		"bom1",
		"hnd1",
	]);
	let region: Region = "hnd1";
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") continue;
		if (arg === "--dry-run") continue;
		if (arg === "--region") {
			const value = args[i + 1];
			if (!value) {
				return {
					ok: false,
					error:
						"Missing value for --region. Use one of: iad1, cle1, pdx1, dub1, bom1, hnd1.",
				};
			}
			if (!allowedRegions.has(value)) {
				return {
					ok: false,
					error: `Invalid region: ${value}. Valid regions: iad1, cle1, pdx1, dub1, bom1, hnd1.`,
				};
			}
			region = value as Region;
			continue;
		}
		if (arg.startsWith("--region=")) {
			const value = arg.slice("--region=".length);
			if (!allowedRegions.has(value)) {
				return {
					ok: false,
					error: `Invalid region: ${value}. Valid regions: iad1, cle1, pdx1, dub1, bom1, hnd1.`,
				};
			}
			region = value as Region;
			continue;
		}
	}

	return {
		ok: true,
		region,
	};
}

function parseWaitEnvArgs(args: string[]): ParseSetupWaitEnvResult {
	const timeoutResult = parseTimeoutFlag(args);
	if (isParseFailure(timeoutResult)) {
		return { ok: false, error: timeoutResult.error };
	}
	const intervalResult = parseIntervalFlag(args);
	if (isParseFailure(intervalResult)) {
		return { ok: false, error: intervalResult.error };
	}
	if (args.includes("--help") || args.includes("-h")) {
		return {
			ok: false,
			error:
				"Usage: rhapsody setup wait-env [--json] [--timeout <seconds>] [--interval <seconds>]",
		};
	}
	return {
		ok: true,
		json: args.includes("--json"),
		timeoutSeconds: timeoutResult.value,
		intervalSeconds: intervalResult.value,
	};
}

function parseTimeoutFlag(args: string[]): ParseResult<{ value: number }> {
	return parseIntegerSecondsFlag({
		args,
		name: "--timeout",
		defaultValue: 30,
	});
}

function parseIntervalFlag(args: string[]): ParseResult<{ value: number }> {
	return parseIntegerSecondsFlag({
		args,
		name: "--interval",
		defaultValue: 3,
		minValue: 1,
	});
}

function parseIntegerSecondsFlag({
	args,
	name,
	defaultValue,
	minValue = 0,
}: {
	args: string[];
	name: string;
	defaultValue: number;
	minValue?: number;
}): ParseResult<{ value: number }> {
	let valueRaw: string | null = null;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === name) {
			const value = args[i + 1];
			if (!value || value.startsWith("--")) {
				return {
					ok: false,
					error: `${name} requires a value in seconds.`,
				};
			}
			valueRaw = value;
			continue;
		}
		if (arg.startsWith(`${name}=`)) {
			valueRaw = arg.slice(name.length + 1);
			continue;
		}
	}
	if (valueRaw === null) {
		return { ok: true, value: defaultValue };
	}
	if (!/^\d+$/.test(valueRaw)) {
		return {
			ok: false,
			error: `${name} must be a non-negative integer (seconds).`,
		};
	}
	const value = Number.parseInt(valueRaw, 10);
	if (!Number.isFinite(value) || value < minValue) {
		return {
			ok: false,
			error:
				minValue === 0
					? `${name} must be a non-negative integer (seconds).`
					: `${name} must be an integer greater than or equal to ${minValue} (seconds).`,
		};
	}
	return {
		ok: true,
		value,
	};
}

function getCreateFirstIssueRepository(): string | null {
	const remoteUrl = readGitRemoteOriginUrl();
	return normalizeGitRemoteTarget(remoteUrl);
}

function collectCreateFirstIssueGhChecks({
	repository,
}: {
	repository: string | null;
}): string[] {
	const blockers = [];
	const ghVersion = run(["gh", "--version"]);
	const ghToken = run(["gh", "auth", "token"]);

	if (!ghVersion.ok) {
		blockers.push(
			"Install the GitHub CLI (`gh`) before setup can create the first issue.",
		);
	}
	if (!ghToken.ok || !ghToken.stdout.trim()) {
		blockers.push(
			"Run `gh auth login` before setup can create the first issue.",
		);
	}
	if (ghVersion.ok && ghToken.ok && ghToken.stdout.trim() && repository) {
		const repoCheck = run(["gh", "repo", "view", repository]);
		if (!repoCheck.ok) {
			blockers.push(
				`Cannot read repository ${repository}; verify gh access and repository owner permissions.`,
			);
		}
	}

	return blockers;
}

function createBodyPreview(value: string): string {
	if (value.length <= BODY_PREVIEW_MAX) {
		return value;
	}
	return `${value.slice(0, BODY_PREVIEW_MAX)}...`;
}

function quoteForCommandPreview(value: string): string {
	if (value.includes(" ") || value.includes('"') || value.includes("'")) {
		return `"${value.replace(/"/g, '\\"')}"`;
	}
	return value;
}

function runCreateFirstIssueApply(
	plan: CreateFirstIssuePlanResult,
): CreateFirstIssueApplyResult {
	const result = run(plan.commandArgv);
	if (!result.ok) {
		const reason = result.stderr.trim() || result.stdout.trim();
		return {
			ok: false,
			issue: null,
			blockers: [
				reason
					? `gh issue create failed: ${reason.split("\n")[0]}`
					: "gh issue create failed with no output.",
			],
			nextActions: [
				"Fix the gh command error and rerun `rhapsody setup create-first-issue --yes`.",
			],
		};
	}
	const parsed = parseIssueCreateCommandOutput(result.stdout);
	if (!parsed.ok) {
		return {
			ok: false,
			issue: null,
			blockers: [parsed.error],
			nextActions: [
				"Retry after confirming gh issue create prints a full issue URL to stdout.",
			],
		};
	}
	return {
		ok: true,
		issue: {
			number: parsed.issueNumber,
			url: parsed.issueUrl,
		},
		blockers: [],
		nextActions: [
			`Continue with \`rhapsody setup first-issue --url <preview-url> --issue-number ${parsed.issueNumber}\`.`,
			`Created issue: ${parsed.issueUrl}`,
		],
	};
}

function parseIssueCreateCommandOutput(
	stdout: string,
): ParsedIssueCreateOutput {
	const matched = stdout
		.trim()
		.split(/\r?\n/)
		.find((line) =>
			/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+/.test(line),
		);
	if (!matched) {
		return {
			ok: false,
			error: "gh issue create did not print a parseable issue URL.",
		};
	}
	const issueNumberMatch = matched.match(/\/issues\/(\d+)(?:$|[/?#])/);
	const issueNumberText = issueNumberMatch?.[1];
	if (!issueNumberText) {
		return {
			ok: false,
			error: "gh issue create returned an unexpected issue URL.",
		};
	}
	const issueNumber = Number.parseInt(issueNumberText, 10);
	if (!Number.isInteger(issueNumber)) {
		return {
			ok: false,
			error: "gh issue create returned a non-numeric issue number.",
		};
	}
	return {
		ok: true,
		issueUrl: matched,
		issueNumber,
	};
}

async function runSetupSmokeTest({
	url,
	json,
	useRootPassword,
}: {
	url: string;
	json: boolean;
	useRootPassword: boolean;
}) {
	const statePath = getSetupStatePath();
	const start = Date.now();
	let baseUrlValue: string;
	try {
		baseUrlValue = normalizeBaseUrl(url);
	} catch {
		const result: SetupSmokeResult = {
			ok: false,
			phase: "smoke-test",
			baseUrl: url,
			statePath,
			checks: [],
			rootPassword: {
				requested: useRootPassword,
				available: false,
				source: "missing",
			},
			blockers: ["Invalid --url value."],
			nextActions: [
				"Use --url with a valid absolute URL, for example: https://preview.vercel.app",
			],
			elapsedMs: Date.now() - start,
		};
		recordSetupState({
			command: "smoke-test",
			baseUrl: url,
			checks: [],
			rootPassword: {
				requested: useRootPassword,
				available: false,
				source: "missing",
			},
			blockers: result.blockers,
			nextActions: result.nextActions,
			nextAction: "blocked",
		});
		printSetupSmokeTest({ json, result });
		process.exit(1);
		return;
	}

	const baseUrl = `${baseUrlValue}/`;
	const loginUrl = `${baseUrlValue}/login`;
	const dashboardUrl = `${baseUrlValue}/dashboard`;
	const stateUrl = `${baseUrlValue}/api/v1/state`;

	const password = resolveRootPasswordForSmoke();
	const rootPassword = {
		requested: useRootPassword,
		available: Boolean(password),
		source: password?.source ?? "missing",
	};

	const checks: Array<{
		name: string;
		url: string;
		status: number | null;
		classification: SmokeClassification;
		ok: boolean;
	}> = [];
	const baseCheck = await runSmokeCheck({ name: "base-url", url: baseUrl });
	const loginCheck = await runSmokeCheck({ name: "login-path", url: loginUrl });
	const dashboardCheck = await runSmokeCheck({
		name: "dashboard-path",
		url: dashboardUrl,
	});
	const stateCheck = await runSmokeCheck({ name: "state-path", url: stateUrl });
	const authStateRequestedCheck =
		useRootPassword && password
			? await runSmokeCheck({
					name: "state-path-authenticated",
					url: stateUrl,
					headers: {
						Authorization: `Bearer ${password.value}`,
					},
				})
			: null;
	checks.push(baseCheck, loginCheck, dashboardCheck, stateCheck);
	if (authStateRequestedCheck) {
		checks.push(authStateRequestedCheck);
	}

	const loginOrDashboardReachable =
		(loginCheck.ok && loginCheck.classification !== "network-error") ||
		(dashboardCheck.ok && dashboardCheck.classification !== "network-error");
	const blockers: string[] = [];
	const nextActions: string[] = [];

	if (baseCheck.classification === "network-error") {
		blockers.push("Base URL is not reachable.");
	}
	if (!loginOrDashboardReachable) {
		blockers.push("Both /login and /dashboard are unreachable.");
	}
	if (
		stateCheck.classification === "network-error" ||
		stateCheck.classification === "admin-auth-missing"
	) {
		blockers.push("/api/v1/state is not reachable or is missing admin auth.");
	}
	if (useRootPassword && !password) {
		blockers.push(
			"ROOT_PASSWORD was requested but not found in process env or apps/app/.env.local.",
		);
	}

	if (blockers.length === 0) {
		nextActions.push(
			"Smoke test passed. Continue setup and move to the next phase.",
		);
	} else {
		if (baseCheck.classification === "network-error") {
			nextActions.push(
				"Confirm the preview URL is accessible from this environment and rerun smoke-test.",
			);
		}
		if (!loginOrDashboardReachable) {
			nextActions.push(
				"Confirm /login or /dashboard routes exist on the deployment and rerun smoke-test.",
			);
		}
		if (
			stateCheck.classification === "network-error" ||
			stateCheck.classification === "admin-auth-missing"
		) {
			nextActions.push(
				"Confirm /api/v1/state is deployed and rerun smoke-test.",
			);
		}
		if (useRootPassword && !password) {
			nextActions.push(
				"Provide ROOT_PASSWORD in environment or apps/app/.env.local and rerun with --use-root-password.",
			);
		}
	}
	if (useRootPassword && password) {
		nextActions.push(
			"Authenticated state path check was attempted with --use-root-password.",
		);
	}

	const result: SetupSmokeResult = {
		ok: blockers.length === 0,
		phase: "smoke-test",
		baseUrl,
		statePath,
		checks: checks.map((check) => ({
			name: check.name,
			url: check.url,
			status: check.status,
			classification: check.classification,
			ok: check.ok,
		})),
		rootPassword,
		blockers,
		nextActions,
		elapsedMs: Date.now() - start,
	};

	recordSetupState({
		command: "smoke-test",
		baseUrl,
		statePath,
		checks: result.checks.map((check) => ({
			name: check.name,
			status: check.status,
			classification: check.classification,
		})),
		rootPassword,
		nextAction: result.ok ? "complete" : "blocked",
		blockers,
		nextActions,
	});
	printSetupSmokeTest({ json, result });
	process.exit(result.ok ? 0 : 1);
}

async function runSmokeCheck({
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
		return {
			name,
			url,
			status: response.status,
			classification: classifySmokeStatus(response.status),
			ok: response.status < 500,
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

function classifySmokeStatus(status: number): SmokeClassification {
	if (status >= 200 && status < 300) return "ok";
	if (status >= 300 && status < 400) return "redirect";
	if (status === 401) return "auth-required";
	if (status === 403) return "forbidden";
	if (status === 500) return "admin-auth-missing";
	return `status-${status}`;
}

function classifyStartAttemptStatus(
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

function normalizeBaseUrl(rawUrl: string) {
	const parsed = new URL(rawUrl);
	const pathname = parsed.pathname.replace(/\/+$/, "");
	return `${parsed.protocol}//${parsed.host}${pathname}`;
}

function parseVercelCandidate(value: unknown): { token?: unknown } | null {
	return value !== null && typeof value === "object"
		? (value as { token?: unknown })
		: null;
}

function resolveRootPasswordForSmoke(): SecretResolution<RootPasswordSource> | null {
	const processPassword = process.env.ROOT_PASSWORD?.trim();
	if (processPassword) {
		return { value: processPassword, source: "process" };
	}

	const workspaceRoot = findWorkspaceRoot(process.cwd());
	const envPath = path.join(workspaceRoot, "apps", "app", ".env.local");
	if (!existsSync(envPath)) {
		return null;
	}
	const filePassword = readRootPasswordFromEnv(envPath);
	if (!filePassword) {
		return null;
	}
	return { value: filePassword, source: ".env.local" };
}

function readRootPasswordFromEnv(filePath: string): string | null {
	const value = readEnvValueFromEnvLocal(filePath, "ROOT_PASSWORD");
	return value || null;
}

function readEnvValueFromEnvLocal(
	filePath: string,
	key: string,
): string | null {
	const content = readFileSync(filePath, "utf8");
	for (const line of content.split(/\r?\n/)) {
		const normalized = line.trim();
		if (!normalized || normalized.startsWith("#")) continue;
		const exportNormalized = normalized.startsWith("export ")
			? normalized.slice(7).trim()
			: normalized;
		const equalsIndex = exportNormalized.indexOf("=");
		if (equalsIndex <= 0) continue;
		if (exportNormalized.slice(0, equalsIndex).trim() !== key) {
			continue;
		}
		let value = exportNormalized.slice(equalsIndex + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (value.length > 0) {
			return value;
		}
	}
	return null;
}

function resolveClaimTokenForSetup(): SecretResolution<ClaimTokenSource> | null {
	const processToken = process.env.RHAPSODY_CLAIM_TOKEN?.trim();
	if (processToken) {
		return { value: processToken, source: "process" };
	}

	const workspaceRoot = findWorkspaceRoot(process.cwd());
	const envPath = path.join(workspaceRoot, "apps", "app", ".env.local");
	if (!existsSync(envPath)) {
		return null;
	}
	const fileToken = readEnvValueFromEnvLocal(envPath, "RHAPSODY_CLAIM_TOKEN");
	if (!fileToken) {
		return null;
	}
	return { value: fileToken, source: ".env.local" };
}

function toJsonObject(value: unknown): JsonObject | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	return value as JsonObject;
}

async function fetchRunClaimToken({
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
		let objectKeys = null;
		let claimToken = null;
		if (contentType?.includes("application/json")) {
			try {
				const parsed = await response.json();
				const record = toJsonObject(parsed);
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
						const runRecord = record.run as JsonObject;
						const nestedClaimToken = runRecord.claimToken;
						if (
							typeof nestedClaimToken === "string" &&
							nestedClaimToken.trim()
						) {
							claimToken = nestedClaimToken;
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

async function postStartAttempt({
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
				const record = toJsonObject(parsed);
				if (record) {
					objectKeys = Object.keys(record);
					const runIdField = record.runnerWorkflowRunId;
					if (typeof runIdField === "string" && runIdField.trim()) {
						runnerWorkflowRunId = runIdField;
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

function classifyPostRunStatus(
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

async function postRun({
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
				const record = toJsonObject(parsed);
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

function waitForEnv({
	timeoutSeconds,
	intervalSeconds,
}: {
	timeoutSeconds: number;
	intervalSeconds: number;
}): WaitEnvResult {
	const start = Date.now();
	const timeoutMs = timeoutSeconds * 1000;
	const intervalMs = intervalSeconds * 1000;
	const requiredEnvKeys: string[] = ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"];
	const statePath = getSetupStatePath();

	let presentEnvKeys: string[] = [];
	let missingEnvKeys: string[] = [...requiredEnvKeys];
	let nextActions: string[] = [];
	while (true) {
		const status = collectSetupStatus();
		const observed = gatherEnvStatus({
			status,
			requiredEnvKeys,
		});
		presentEnvKeys = observed.presentEnvKeys;
		missingEnvKeys = observed.missingEnvKeys;
		nextActions = observed.missingEnvKeys.length
			? [
					"Provision Turso through Vercel Marketplace or set missing keys in .env.local.",
					"Re-run `rhapsody setup wait-env` until all keys are available.",
				]
			: [
					"Turso env vars are available.",
					"Continue with `rhapsody setup plan` or next setup phase commands.",
				];
		const elapsedMs = Date.now() - start;
		if (missingEnvKeys.length === 0) {
			return {
				ok: true,
				requiredEnvKeys,
				presentEnvKeys,
				missingEnvKeys,
				timeoutSeconds,
				intervalSeconds,
				elapsedMs,
				statePath,
				nextActions,
			};
		}
		if (elapsedMs >= timeoutMs || timeoutMs === 0) {
			return {
				ok: false,
				requiredEnvKeys,
				presentEnvKeys,
				missingEnvKeys,
				timeoutSeconds,
				intervalSeconds,
				elapsedMs,
				statePath,
				nextActions,
			};
		}
		if (intervalMs > 0) {
			sleepSync(intervalMs);
		}
	}
}

function buildDeployPreviewPlan({
	status,
}: {
	status: ReturnType<typeof collectSetupStatus>;
}): DeployPreviewPlanResult {
	const statePath = getSetupStatePath();
	const vercelToken = getVercelTokenForDeployPreview(status.paths.appRoot);
	const blockers = collectDeployPreviewBlockers(status);
	const commandPlan = [
		{
			name: "pnpm db:migrate",
			argv: ["pnpm", "db:migrate"],
		},
		{
			name: vercelToken
				? "vercel deploy --yes --token <redacted>"
				: "vercel deploy --yes",
			argv: vercelToken
				? ["vercel", "deploy", "--yes", "--token", vercelToken]
				: ["vercel", "deploy", "--yes"],
		},
	];

	return {
		ok: blockers.length === 0,
		appRoot: status.paths.appRoot,
		statePath,
		blockers,
		plannedCommands: commandPlan.map((entry) => entry.name),
		commandPlan,
		nextActions: blockers.length
			? blockers
			: [
					"Run `rhapsody setup deploy-preview --yes` to migrate the DB and deploy.",
					"Review setup state after each step.",
				],
	};
}

function collectDeployPreviewBlockers(
	status: ReturnType<typeof collectSetupStatus>,
) {
	const blockers: string[] = [];
	if (!status.paths.appExists) {
		blockers.push("Run this command from the Rhapsody repository root.");
	}
	if (!status.tools.vercel.installed) {
		blockers.push(
			"Install the Vercel CLI (`vercel`) before running deploy-preview.",
		);
	}
	if (!status.tools.vercel.tokenPresent) {
		blockers.push(
			"Run `vercel login` or set VERCEL_TOKEN before running deploy-preview.",
		);
	}
	if (!status.app.vercelProjectLink.exists) {
		blockers.push(
			"Link this app to a Vercel project (`vercel link`) before deploy-preview.",
		);
	}
	if (
		!status.app.env.tursoDatabaseUrlPresent ||
		!status.app.env.tursoAuthTokenPresent
	) {
		blockers.push(
			"Provision Turso and write TURSO_DATABASE_URL / TURSO_AUTH_TOKEN to .env.local.",
		);
	}
	return blockers;
}

function getVercelTokenForDeployPreview(
	appRoot: string | null,
): VercelTokenLookup {
	if (process.env.VERCEL_TOKEN) {
		return process.env.VERCEL_TOKEN;
	}
	if (appRoot) {
		const env = readDotEnv(path.join(appRoot, ".env.local"));
		if (env.VERCEL_TOKEN) {
			return env.VERCEL_TOKEN;
		}
	}
	return readVercelTokenFromDisk();
}

function gatherEnvStatus({
	status,
	requiredEnvKeys,
}: {
	status: ReturnType<typeof collectSetupStatus>;
	requiredEnvKeys: string[];
}): {
	presentEnvKeys: string[];
	missingEnvKeys: string[];
} {
	const localPath = path.join(status.paths.appRoot, ".env.local");
	const env = readDotEnv(localPath);
	const mergedEnv = { ...env };
	const localMissing = requiredEnvKeys.filter((key) => !mergedEnv[key]);
	if (localMissing.length > 0) {
		const vercelPull = maybeReadVercelEnv(status);
		for (const [key, value] of Object.entries(vercelPull)) {
			if (!mergedEnv[key] && value) {
				mergedEnv[key] = value;
			}
		}
	}
	const presentEnvKeys: string[] = [];
	const missingEnvKeys: string[] = [];
	for (const key of requiredEnvKeys) {
		if (mergedEnv[key]) {
			presentEnvKeys.push(key);
		} else {
			missingEnvKeys.push(key);
		}
	}
	return { presentEnvKeys, missingEnvKeys };
}

function maybeReadVercelEnv(
	status: ReturnType<typeof collectSetupStatus>,
): Record<string, string> {
	if (
		!status.tools.vercel.installed ||
		!status.tools.vercel.tokenPresent ||
		!status.app.vercelProjectLink.exists
	) {
		return {};
	}

	const tempPath = path.join(
		tmpdir(),
		`rhapsody-setup-env-${Date.now()}-${Math.random().toString(16).slice(2)}.env`,
	);
	const result = run(
		["vercel", "env", "pull", tempPath, "--environment=development"],
		{
			cwd: status.paths.appRoot,
		},
	);
	if (!result.ok || !existsSync(tempPath)) {
		if (existsSync(tempPath)) {
			unlinkSync(tempPath);
		}
		return {};
	}
	const pulledEnv = readDotEnv(tempPath);
	unlinkSync(tempPath);
	return pulledEnv;
}

function buildProvisionTursoPlan({ region }: { region: Region }): {
	ok: boolean;
	mode: CommandMode;
	region: Region;
	linkDir: string;
	wouldWriteProjectJson: boolean;
	statePath: string;
	applyConfirmationRequired: boolean;
	applyConfirmationProvided: boolean;
	applyReady: boolean;
	command: string;
	commandArgv: string[];
	expectedEnvKeys: string[];
	nextActions: string[];
} {
	const statePath = getSetupStatePath();
	const command =
		"npx -y vercel@53 integration add tursocloud --name rhapsody-db --plan starter -m region=" +
		region +
		" -e production -e preview -e development --no-env-pull";
	const { linkDir, wouldWriteProjectJson } = inferTursoLinkContext();
	const commandArgv = [
		"npx",
		"-y",
		"vercel@53",
		"integration",
		"add",
		"tursocloud",
		"--name",
		"rhapsody-db",
		"--plan",
		"starter",
		"-m",
		`region=${region}`,
		"-e",
		"production",
		"-e",
		"preview",
		"-e",
		"development",
		"--no-env-pull",
	];

	return {
		ok: true,
		mode: "dry-run",
		region,
		linkDir,
		wouldWriteProjectJson,
		statePath,
		applyConfirmationRequired: true,
		applyConfirmationProvided: false,
		applyReady: wouldWriteProjectJson,
		command,
		commandArgv,
		expectedEnvKeys: ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"],
		nextActions: [
			"No resources were created in dry-run mode.",
			"Run again with --yes (and no --dry-run) to execute provisioning.",
		],
	};
}

function stateSnapshot(
	linkDir: string,
	wouldWriteProjectJson: boolean,
): {
	linkDir: string;
	linkDirExists: boolean;
	wouldWriteProjectJson: boolean;
	preparedProjectJson: boolean;
} {
	return {
		linkDir,
		linkDirExists: existsSync(linkDir),
		wouldWriteProjectJson,
		preparedProjectJson: existsSync(
			path.join(linkDir, ".vercel", "project.json"),
		),
	};
}

function inferTursoLinkContext() {
	const workspaceRoot = findWorkspaceRoot(process.cwd());
	const appProjectJsonPath = path.join(
		workspaceRoot,
		"apps",
		"app",
		".vercel",
		"project.json",
	);

	if (!existsSync(appProjectJsonPath)) {
		return {
			linkDir: path.join(tmpdir(), "rhapsody-setup-unknown"),
			wouldWriteProjectJson: false,
		};
	}

	let projectJson = null;
	try {
		projectJson = JSON.parse(readFileSync(appProjectJsonPath, "utf8"));
	} catch {
		return {
			linkDir: path.join(tmpdir(), "rhapsody-setup-unknown"),
			wouldWriteProjectJson: false,
		};
	}

	const projectId = projectJson.projectId ?? projectJson.project?.id;
	if (!projectId) {
		return {
			linkDir: path.join(tmpdir(), "rhapsody-setup-unknown"),
			wouldWriteProjectJson: false,
		};
	}

	return {
		linkDir: path.join(tmpdir(), `rhapsody-setup-${projectId}`),
		wouldWriteProjectJson: true,
	};
}

function buildSetupPlan({
	status,
	region,
}: {
	status: ReturnType<typeof collectSetupStatus>;
	region: Region;
}): SetupPlanResult {
	const tursoCommand =
		"npx -y vercel@53 integration add tursocloud --name rhapsody-db --plan starter -m region=" +
		region +
		" -e production -e preview -e development --no-env-pull";

	const phases = [
		{
			name: "Auth check",
			command: "gh auth status && vercel whoami",
			status:
				status.tools.gh.installed && status.tools.vercel.installed
					? "ready"
					: "blocked",
		},
		{
			name: "GitHub repo/project prep",
			command: "rhapsody setup check-projects --json",
			status:
				status.tools.gh.installed && status.tools.gh.authTokenPresent
					? "ready"
					: "blocked",
		},
		{
			name: "Vercel project link/create",
			command: "rhapsody setup check-projects --json",
			status: status.app.vercelProjectLink.exists ? "ready" : "ready",
		},
		{
			name: "Turso Marketplace provisioning",
			command: tursoCommand,
			status:
				status.app.env.tursoDatabaseUrlPresent &&
				status.app.env.tursoAuthTokenPresent
					? "ready"
					: "ready",
		},
		{
			name: "Vercel env setup",
			command: "rhapsody setup wait-env",
			status: status.app.env.tursoDatabaseUrlPresent ? "ready" : "ready",
		},
		{
			name: "Database migration and deploy preview",
			command: "rhapsody setup deploy-preview --dry-run",
			status:
				collectDeployPreviewBlockers(status).length === 0 ? "ready" : "blocked",
		},
		{
			name: "Smoke test",
			command: "rhapsody setup smoke-test --url <preview-url>",
			status: "ready",
		},
		{
			name: "Attempt start",
			command:
				"rhapsody setup start-attempt --url <preview-url> --run-id <runId> --attempt-id <attemptId>",
			status: "ready",
		},
	];

	return {
		ok: status.ok,
		region,
		phases: phases.map((phase) => ({
			name: phase.name,
			command: phase.command,
			status: phase.status === "blocked" ? "blocked" : "ready",
		})),
		commands: phases.map((phase) => phase.command),
		nextActions: status.nextActions,
	};
}

function printSetupStatus({ json }: { json: boolean }) {
	const status = collectSetupStatus();
	if (json) {
		console.log(JSON.stringify(status, null, 2));
		return;
	}

	console.log(`Rhapsody setup status

Repository:
  root: ${status.paths.workspaceRoot}
  app: ${status.paths.appRoot}
  app exists: ${label(status.paths.appExists)}

Tools:
  gh: ${label(status.tools.gh.installed)}${status.tools.gh.version ? ` (${status.tools.gh.version})` : ""}
  gh auth token: ${label(status.tools.gh.authTokenPresent)}
  vercel: ${label(status.tools.vercel.installed)}${status.tools.vercel.version ? ` (${status.tools.vercel.version})` : ""}
  Vercel token: ${label(status.tools.vercel.tokenPresent)}

App workspace:
  .env.local: ${label(status.app.envLocalExists)}
  .vercel/project.json: ${label(status.app.vercelProjectLink.exists)}
  Turso URL: ${label(status.app.env.tursoDatabaseUrlPresent)}
  Turso token: ${label(status.app.env.tursoAuthTokenPresent)}
  setup state: ${label(status.app.setupState.exists)}${status.app.setupState.lastUpdatedAt ? ` (${status.app.setupState.lastUpdatedAt})` : ""}
  last setup command: ${status.app.setupState.lastCommand ?? "none"}

Next action:
  ${status.nextActions[0] ?? "Run `rhapsody setup status --json` for machine-readable details."}
`);
}

function collectSetupStatus() {
	const workspaceRoot = findWorkspaceRoot(process.cwd());
	const appRoot = path.join(workspaceRoot, "apps", "app");
	const envLocalPath = path.join(appRoot, ".env.local");
	const vercelProjectPath = path.join(appRoot, ".vercel", "project.json");
	const env = readDotEnv(envLocalPath);
	const setupStatePath = getSetupStatePath();
	const setupState = readSetupState(setupStatePath);
	const ghVersion = run(["gh", "--version"]);
	const ghToken = run(["gh", "auth", "token"]);
	const vercelVersion = run(["vercel", "--version"]);
	const vercelToken =
		process.env.VERCEL_TOKEN ?? env.VERCEL_TOKEN ?? readVercelTokenFromDisk();
	const vercelProject = toJsonObject(readJson(vercelProjectPath));
	const nextActions = [];

	if (!existsSync(appRoot)) {
		nextActions.push(
			"Run this command from the Rhapsody repository root, or clone Rhapsody first.",
		);
	}
	if (!ghVersion.ok) {
		nextActions.push(
			"Install the GitHub CLI (`gh`) before setup can create or configure GitHub resources.",
		);
	} else if (!ghToken.ok || !ghToken.stdout.trim()) {
		nextActions.push(
			"Run `gh auth login` before setup can read or mutate GitHub resources.",
		);
	}
	if (!vercelToken) {
		nextActions.push(
			"Run `vercel login` or provide VERCEL_TOKEN before setup can configure Vercel resources.",
		);
	}
	if (!vercelProject) {
		nextActions.push(
			"The app is not linked to a Vercel project yet; setup will create or link one.",
		);
	}
	if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) {
		nextActions.push(
			"Turso is not configured yet; setup will provision it through Vercel Marketplace.",
		);
	}
	if (nextActions.length === 0) {
		nextActions.push(
			"Local setup prerequisites look present; continue with Vercel project and Turso provisioning.",
		);
	}

	return {
		ok:
			nextActions.length === 1 &&
			nextActions[0].startsWith("Local setup prerequisites"),
		paths: {
			workspaceRoot,
			appRoot,
			appExists: existsSync(appRoot),
		},
		tools: {
			gh: {
				installed: ghVersion.ok,
				version: firstLine(ghVersion.stdout),
				authTokenPresent: ghToken.ok && ghToken.stdout.trim().length > 0,
			},
			vercel: {
				installed: vercelVersion.ok,
				version: firstLine(vercelVersion.stdout || vercelVersion.stderr),
				tokenPresent: Boolean(vercelToken),
			},
		},
		app: {
			envLocalExists: existsSync(envLocalPath),
			vercelProjectLink: {
				exists: Boolean(vercelProject),
				orgIdPresent:
					typeof vercelProject?.orgId === "string" &&
					vercelProject.orgId.length > 0,
				projectIdPresent:
					typeof vercelProject?.projectId === "string" &&
					vercelProject.projectId.length > 0,
			},
			env: {
				tursoDatabaseUrlPresent: Boolean(env.TURSO_DATABASE_URL),
				tursoAuthTokenPresent: Boolean(env.TURSO_AUTH_TOKEN),
			},
			setupState: {
				path: setupStatePath,
				exists: existsSync(setupStatePath),
				lastUpdatedAt: (setupState.lastUpdatedAt as string | null) ?? null,
				lastCommand:
					typeof setupState.commandState?.["command"] === "string"
						? setupState.commandState["command"]
						: null,
				nextAction:
					typeof setupState.commandState?.["nextAction"] === "string"
						? setupState.commandState["nextAction"]
						: null,
			},
		},
		nextActions,
	};
}

function collectProjectReadiness() {
	const workspaceRoot = findWorkspaceRoot(process.cwd());
	const appRoot = path.join(workspaceRoot, "apps", "app");
	const statePath = getSetupStatePath();
	const env = readDotEnv(path.join(appRoot, ".env.local"));
	const vercelProjectPath = path.join(appRoot, ".vercel", "project.json");
	const vercelProject = toJsonObject(readJson(vercelProjectPath));
	const vercelToken =
		process.env.VERCEL_TOKEN ?? env.VERCEL_TOKEN ?? readVercelTokenFromDisk();
	const blockers: string[] = [];

	const ghVersion = run(["gh", "--version"]);
	const ghToken = run(["gh", "auth", "token"]);
	const vercelVersion = run(["vercel", "--version"]);
	const remoteUrl = readGitRemoteOriginUrl();
	const repoTarget = normalizeGitRemoteTarget(remoteUrl);

	const github: {
		installed: boolean;
		version: string | null;
		authTokenPresent: boolean;
		remoteUrl: string | null;
		repository: string | null;
		repoReadable: boolean;
		repoSummary: string | null;
	} = {
		installed: ghVersion.ok,
		version: firstLine(ghVersion.stdout),
		authTokenPresent: ghToken.ok && ghToken.stdout.trim().length > 0,
		remoteUrl,
		repository: repoTarget,
		repoReadable: false,
		repoSummary: null,
	};

	if (github.installed && github.authTokenPresent && repoTarget) {
		const repoResult = run([
			"gh",
			"repo",
			"view",
			repoTarget,
			"--json",
			"nameWithOwner,url,defaultBranchRef",
		]);
		if (repoResult.ok) {
			try {
				const repo = JSON.parse(repoResult.stdout) as {
					nameWithOwner?: unknown;
					url?: unknown;
					defaultBranchRef?: { name?: unknown };
				};
				github.repoReadable = true;
				github.repository =
					typeof repo.nameWithOwner === "string" ? repo.nameWithOwner : null;
				github.repoSummary = [
					repo.nameWithOwner,
					repo.url,
					typeof repo.defaultBranchRef?.name === "string"
						? repo.defaultBranchRef.name
						: null,
				]
					.filter(Boolean)
					.join(" | ");
			} catch {
				blockers.push("GitHub repo view returned non-JSON output.");
			}
		} else {
			blockers.push(
				`gh repo view could not read ${repoTarget}; check authentication and repository access.`,
			);
		}
	}

	if (!github.installed) {
		blockers.push(
			"Install the GitHub CLI (`gh`) before setup can read GitHub repository state.",
		);
	}
	if (!github.authTokenPresent) {
		blockers.push(
			"Run `gh auth login` before setup can read repository metadata.",
		);
	}
	if (!remoteUrl) {
		blockers.push(
			"Configure `remote.origin.url` so setup can identify the repository.",
		);
	}

	const projectLink = {
		exists: Boolean(vercelProject),
		orgIdPresent:
			typeof vercelProject?.orgId === "string" &&
			vercelProject.orgId.length > 0,
		projectIdPresent:
			typeof vercelProject?.projectId === "string" &&
			vercelProject.projectId.length > 0,
	};
	const vercel = {
		installed: vercelVersion.ok,
		version: firstLine(vercelVersion.stdout),
		tokenPresent: Boolean(vercelToken),
		projectLink: {
			exists: projectLink.exists,
			orgIdPresent: projectLink.orgIdPresent,
			projectIdPresent: projectLink.projectIdPresent,
		},
	};
	if (!vercel.installed) {
		blockers.push(
			"Install the Vercel CLI (`vercel`) before setup can read project linkage.",
		);
	}
	if (!vercel.tokenPresent) {
		blockers.push(
			"Run `vercel login` or provide VERCEL_TOKEN before setup can verify project linkage.",
		);
	}
	if (!vercel.projectLink.exists) {
		blockers.push(
			"Create or link a Vercel project (`vercel link`) before setup can proceed.",
		);
	}
	if (
		!vercel.projectLink.orgIdPresent ||
		!vercel.projectLink.projectIdPresent
	) {
		blockers.push(
			"The Vercel project link file exists but is missing orgId/projectId metadata.",
		);
	}

	const nextActions = blockers.length
		? [
				"Fix blockers above, then re-run `rhapsody setup check-projects --json`.",
				"Run `rhapsody setup check-projects` for human-readable guidance.",
			]
		: [
				"GitHub and Vercel project prerequisites are ready. Run `rhapsody setup plan` to continue.",
				"Re-run `rhapsody setup check-projects --json` after any configuration changes.",
			];

	return {
		ok: blockers.length === 0,
		statePath,
		github,
		vercel,
		blockers,
		nextActions,
	};
}

function readGitRemoteOriginUrl() {
	const result = run(["git", "config", "--get", "remote.origin.url"]);
	return result.ok ? result.stdout.trim() : null;
}

function normalizeGitRemoteTarget(remote: string | null) {
	const trimmed = remote?.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("http")) {
		const match = trimmed.match(/github\.com\/([^/]+\/[^/?#]+)/);
		if (match) return normalizeGithubOwnerRepo(match[1]);
		return trimmed;
	}
	if (/^git@github\.com:/.test(trimmed)) {
		const match = trimmed.match(/^git@github\.com:([^/]+\/.+)$/);
		if (match) return normalizeGithubOwnerRepo(match[1]);
		return trimmed;
	}
	return trimmed;
}

function normalizeGithubOwnerRepo(value: string) {
	return value.replace(/\.git$/, "");
}

function recordWaitEnvSetupState(result: WaitEnvResult) {
	recordSetupState({
		command: "wait-env",
		nextAction: result.ok ? "complete" : "waiting-for-env",
		requiredEnvKeys: result.requiredEnvKeys,
		presentEnvKeys: result.presentEnvKeys,
		missingEnvKeys: result.missingEnvKeys,
		timeoutSeconds: result.timeoutSeconds,
		intervalSeconds: result.intervalSeconds,
		ok: result.ok,
	});
}

function findWorkspaceRoot(start: string): string {
	let current = start;
	while (true) {
		if (
			existsSync(path.join(current, "pnpm-workspace.yaml")) &&
			existsSync(path.join(current, "apps", "app", "package.json"))
		) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) return start;
		current = parent;
	}
}

function inferTursoProjectJsonPath() {
	const workspaceRoot = findWorkspaceRoot(process.cwd());
	return path.join(workspaceRoot, "apps", "app", ".vercel", "project.json");
}

function getSetupStatePath() {
	const workspaceRoot = findWorkspaceRoot(process.cwd());
	return path.join(
		workspaceRoot,
		"apps",
		"app",
		".rhapsody",
		"setup-state.json",
	);
}

function readSetupState(statePath: string): SetupStateFile {
	const value = readJson(statePath);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}
	const stateRecord = value as Record<string, unknown>;
	const commandState = toJsonObject(stateRecord.commandState);
	return {
		lastUpdatedAt:
			stateRecord.lastUpdatedAt === null ||
			typeof stateRecord.lastUpdatedAt === "string"
				? stateRecord.lastUpdatedAt
				: undefined,
		commandState: commandState ?? undefined,
	};
}

function recordSetupState(payload: Record<string, unknown>) {
	const statePath = getSetupStatePath();
	const previous = readSetupState(statePath);
	const timestamp = new Date().toISOString();
	const next = {
		...previous,
		lastUpdatedAt: timestamp,
		commandState: {
			...payload,
			updatedAt: timestamp,
		},
	};
	const stateDir = path.dirname(statePath);
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(statePath, JSON.stringify(next, null, 2) + "\n", "utf8");
}

function prepareTursoLinkDirectory({
	linkDir,
	projectJsonPath,
}: {
	linkDir: string;
	projectJsonPath: string;
}) {
	let linkDirExisted = true;
	if (!existsSync(linkDir)) {
		mkdirSync(linkDir, { recursive: true });
		linkDirExisted = false;
	}

	let prepared = false;
	if (existsSync(projectJsonPath)) {
		const targetDir = path.join(linkDir, ".vercel");
		mkdirSync(targetDir, { recursive: true });
		copyFileSync(projectJsonPath, path.join(targetDir, "project.json"));
		prepared = true;
	}

	return {
		linkDirExisted,
		prepared,
		projectJsonTarget: path.join(linkDir, ".vercel", "project.json"),
	};
}

function runProvisionTursoApply({
	commandArgv,
	cwd,
}: {
	commandArgv: string[];
	cwd: string;
}) {
	const result = spawnSync(commandArgv[0], commandArgv.slice(1), {
		cwd,
		stdio: "inherit",
		encoding: "utf8",
	});
	return {
		ok: result.status === 0,
		exitCode: result.status ?? 1,
		signal: result.signal,
	};
}

function runCommandFromApp({ cwd, argv }: { cwd: string; argv: string[] }) {
	const result = spawnSync(argv[0], argv.slice(1), {
		cwd,
		stdio: "inherit",
		encoding: "utf8",
	});
	return {
		ok: result.status === 0,
		exitCode: result.status ?? 1,
		signal: result.signal,
	};
}

function readDotEnv(filePath: string): Record<string, string> {
	if (!existsSync(filePath)) return {};
	const result: Record<string, string> = {};
	for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const index = trimmed.indexOf("=");
		if (index === -1) continue;
		const key = trimmed.slice(0, index).trim();
		let value = trimmed.slice(index + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		result[key] = value;
	}
	return result;
}

function readVercelTokenFromDisk() {
	const candidates = [
		path.join(
			homedir(),
			"Library",
			"Application Support",
			"com.vercel.cli",
			"auth.json",
		),
		path.join(homedir(), ".local", "share", "com.vercel.cli", "auth.json"),
	];
	for (const candidate of candidates) {
		const data = readJson(candidate);
		if (typeof data === "object" && data !== null) {
			const token = (data as { token?: unknown }).token;
			if (typeof token === "string" && token.length > 0) {
				return token;
			}
		}
	}
	return null;
}

function readJson(filePath: string): unknown {
	try {
		return JSON.parse(readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
}

function run(
	command: string[],
	options: { cwd?: string } = {},
): SyncCommandResult {
	const result = spawnSync(command[0], command.slice(1), {
		encoding: "utf8",
		cwd: options.cwd,
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		ok: result.status === 0,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

const sleepSyncState = { waitArray: new Int32Array(new SharedArrayBuffer(4)) };
function sleepSync(ms: number) {
	if (ms <= 0) return;
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const remaining = end - Date.now();
		Atomics.wait(sleepSyncState.waitArray, 0, 0, remaining);
	}
}

function firstLine(value: string): string | null {
	return (
		value
			.split(/\r?\n/)
			.find((line) => line.trim().length > 0)
			?.trim() ?? null
	);
}

function label(value: boolean): "yes" | "no" {
	return value ? "yes" : "no";
}
