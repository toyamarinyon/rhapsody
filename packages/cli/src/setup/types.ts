export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };
export type JsonRecord = Record<string, JsonValue>;
export type JsonObject = Record<string, unknown>;

export type ParseResult<TData> =
	| ({ ok: true } & TData)
	| { ok: false; error: string };

export function isParseFailure<TData>(
	value: ParseResult<TData>,
): value is { ok: false; error: string } {
	return value.ok === false;
}

export type CommandMode = "apply" | "dry-run";

export type RootPasswordSource = "process" | ".env.local" | "missing";
export type ClaimTokenSource =
	| "process"
	| ".env.local"
	| "run-detail"
	| "missing";

export type Region = "iad1" | "cle1" | "pdx1" | "dub1" | "bom1" | "hnd1";
export type VercelTokenLookup = string | null;

export type SmokeClassification =
	| "ok"
	| "network-error"
	| "redirect"
	| `status-${number}`
	| "admin-auth-missing"
	| "auth-required"
	| "forbidden";

export type FirstIssuePostClassification =
	| "ok"
	| "validation-error"
	| "unauthorized"
	| "existing-run"
	| "network-error"
	| "server-error"
	| `status-${number}`;

export type StartAttemptClassification =
	| "ok"
	| "validation-error"
	| "unauthorized"
	| "not-found"
	| "already-started"
	| "network-error"
	| "server-error"
	| `status-${number}`;

export type PostResponseBase = {
	status: number | null;
	contentType: string | null;
	classification: string | `status-${number}`;
	objectKeys: string[] | null;
	error?: string;
};

export type FirstIssuePostResponse = PostResponseBase & {
	classification: FirstIssuePostClassification;
	runId: string | null;
	attemptId: string | null;
};

export type StartAttemptPostResponse = PostResponseBase & {
	classification: StartAttemptClassification;
	runnerWorkflowRunId: string | null;
};

export type RunClaimResponse = PostResponseBase & {
	classification: StartAttemptClassification;
	claimToken: string | null;
};

export type SyncCommandResult = {
	ok: boolean;
	stdout: string;
	stderr: string;
};

export type RunResult = {
	ok: boolean;
	exitCode: number;
	signal: string | null;
};

export type SecretResolution<TSource extends string> = {
	value: string;
	source: TSource;
};

export type ParseSetupCheckProjectsResult = ParseResult<{ json: boolean }>;

export type ParseSetupSmokeTestResult = ParseResult<{
	url: string;
	json: boolean;
	useRootPassword: boolean;
}>;

export type ParseSetupCreateFirstIssueResult = ParseResult<{
	mode: CommandMode;
	yes: boolean;
	dryRun: boolean;
	title: string;
	body: string;
	json: boolean;
}>;
export type ParseSetupCreateFirstIssueSuccess = Extract<
	ParseSetupCreateFirstIssueResult,
	{ ok: true }
>;

export type ParseSetupFirstIssueResult = ParseResult<{
	url: string;
	issueNumber: number;
	mode: CommandMode;
	apply: boolean;
	yes: boolean;
	useRootPassword: boolean;
	json: boolean;
}>;

export type ParseSetupStartAttemptResult = ParseResult<{
	url: string;
	runId: string;
	attemptId: string;
	mode: CommandMode;
	apply: boolean;
	yes: boolean;
	useRootPassword: boolean;
	json: boolean;
}>;

export type ParseSetupPlanResult = ParseResult<{
	json: boolean;
	region: Region;
}>;

export type ParseSetupDeployPreviewResult = ParseResult<{
	json: boolean;
	dryRun: boolean;
	yes: boolean;
}>;

export type ParseSetupProvisionTursoResult = ParseResult<{
	json: boolean;
	region: Region;
	dryRun: boolean;
	yes: boolean;
}>;

export type ParseSetupWaitEnvResult = ParseResult<{
	json: boolean;
	timeoutSeconds: number;
	intervalSeconds: number;
}>;

export type SetupPlanPhase = {
	name: string;
	command: string;
	status: "ready" | "blocked";
};

export type SetupPlanResult = {
	ok: boolean;
	region: Region;
	phases: SetupPlanPhase[];
	commands: string[];
	nextActions: string[];
};

export type DeployPreviewPlanResult = {
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

export type CreateFirstIssuePlanResult = {
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

export type CreateFirstIssueApplyResult = {
	ok: boolean;
	issue: { number: number; url: string } | null;
	blockers: string[];
	nextActions: string[];
};

export type WaitEnvResult = {
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

export type ParsedIssueCreateOutput =
	| {
			ok: false;
			error: string;
	  }
	| {
			ok: true;
			issueUrl: string;
			issueNumber: number;
	  };

export type SetupStateFile = {
	lastUpdatedAt?: string | null;
	commandState?: {
		command?: string | null;
		nextAction?: string | null;
		[x: string]: unknown;
	};
};

export type FirstIssueRootPasswordState = {
	requested: boolean;
	available: boolean;
	source: RootPasswordSource;
};

export type ClaimTokenState = {
	available: boolean;
	source: ClaimTokenSource;
};

export type FirstIssueInput = {
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

export type StartAttemptInput = {
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

export type SetupSmokeResult = {
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

export type EnvSnapshot = Record<string, string>;

export type LegacyRunnerArgs = {
	command: string;
	subcommand?: string;
	args: string[];
};

export type LegacyExitCode = number;

export const SMOKE_TEST_TIMEOUT_MS = 12_000;
