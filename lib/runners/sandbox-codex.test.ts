import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	buildCodexExecCommand: vi.fn(),
	buildCodexChatGPTDummyAuthFile: vi.fn(),
	createEvent: vi.fn(),
	createVercelSandbox: vi.fn(),
	getRunDetail: vi.fn(),
	getVercelSandboxId: vi.fn(),
	loadMediatorCredentialState: vi.fn(),
	loadRhapsodyConfig: vi.fn(),
	loadRhapsodyCodexBaseSnapshotEnv: vi.fn(),
	loadRhapsodyGitHubEnv: vi.fn(),
	loadRhapsodyMediatorEnv: vi.fn(),
	loadRhapsodyProtectionBypassEnv: vi.fn(),
	loadRunnerCodexConfig: vi.fn(),
	markAttemptStarted: vi.fn(),
	recordSandboxCommandFinishedEvent: vi.fn(),
	recordSandboxCommandStartedEvent: vi.fn(),
	recordSandboxLifecycleEvent: vi.fn(),
	runVercelSandboxCommand: vi.fn(),
	startVercelSandboxCommand: vi.fn(),
	stopSandboxWithLifecycleEvents: vi.fn(),
	stopVercelSandbox: vi.fn(),
	writeVercelSandboxFiles: vi.fn(),
}));

vi.mock("@/lib/codex/auth", () => ({
	buildCodexChatGPTDummyAuthFile: mocks.buildCodexChatGPTDummyAuthFile,
}));

vi.mock("@/lib/codex/cli", () => ({
	buildCodexExecCommand: mocks.buildCodexExecCommand,
}));

vi.mock("@/lib/codex/credentials", () => ({
	loadMediatorCredentialState: mocks.loadMediatorCredentialState,
}));

vi.mock("@/lib/config", () => ({
	loadRhapsodyCodexBaseSnapshotEnv: mocks.loadRhapsodyCodexBaseSnapshotEnv,
	loadRhapsodyConfig: mocks.loadRhapsodyConfig,
	loadRhapsodyGitHubEnv: mocks.loadRhapsodyGitHubEnv,
	loadRhapsodyMediatorEnv: mocks.loadRhapsodyMediatorEnv,
	loadRhapsodyProtectionBypassEnv: mocks.loadRhapsodyProtectionBypassEnv,
}));

vi.mock("@/lib/runner-codex-config", () => ({
	expandSandboxNetworkPolicyForPreset: vi.fn((value) => value ?? []),
	loadRunnerCodexConfig: mocks.loadRunnerCodexConfig,
}));

vi.mock("@/lib/sandbox/vercel", () => ({
	buildVercelSandboxCodexNetworkPolicy: vi.fn(() => ({ allow: {} })),
	buildVercelSandboxDependencyNetworkPolicy: vi.fn(() => ({ allow: {} })),
	buildVercelSandboxGitHubNetworkPolicy: vi.fn(() => ({ allow: {} })),
	createVercelSandbox: mocks.createVercelSandbox,
	getVercelSandboxId: mocks.getVercelSandboxId,
	mergeNetworkPolicies: vi.fn(() => ({ allow: {} })),
	runVercelSandboxCommand: mocks.runVercelSandboxCommand,
	startVercelSandboxCommand: mocks.startVercelSandboxCommand,
	stopVercelSandbox: mocks.stopVercelSandbox,
	writeVercelSandboxFiles: mocks.writeVercelSandboxFiles,
}));

vi.mock("@/lib/state", () => ({
	createEvent: mocks.createEvent,
	getRunDetail: mocks.getRunDetail,
	markAttemptStarted: mocks.markAttemptStarted,
	recordSandboxCommandFinishedEvent: mocks.recordSandboxCommandFinishedEvent,
	recordSandboxCommandStartedEvent: mocks.recordSandboxCommandStartedEvent,
	recordSandboxLifecycleEvent: mocks.recordSandboxLifecycleEvent,
	stopSandboxWithLifecycleEvents: mocks.stopSandboxWithLifecycleEvents,
}));

vi.mock("@/lib/workflows/attempt-hook", () => ({
	buildAttemptHookToken: vi.fn(() => "hook-token"),
}));

import { runSandboxCodexRunner } from "./sandbox-codex";

function makeCommand(input: {
	commandId: string;
	cmd: string;
	args?: string[];
	exitCode: number;
	stdout?: string;
	stderr?: string;
}) {
	return {
		commandId: input.commandId,
		cwd: "/vercel/sandbox",
		startedAt: 1,
		exitCode: input.exitCode,
		stdout: input.stdout ?? "",
		stderr: input.stderr ?? "",
		...(input.exitCode !== 0 ? { error: "failed" } : {}),
	};
}

afterEach(() => {
	vi.clearAllMocks();
});

test("returns 422 and does not mark the attempt started when sandbox instructions are missing", async () => {
	mocks.loadRhapsodyConfig.mockReturnValue({
		repository: {
			owner: "toyamarinyon",
			name: "target-repo",
			defaultBranch: "main",
			branchPrefix: "rhapsody/",
		},
		runner: {
			timeoutMs: 1000,
			sandboxTimeoutMs: 1000,
			outputPreviewLength: 80,
			progressIntervalMs: 0,
			progressPreviewLength: 80,
		},
		tracker: {
			owner: "toyamarinyon",
			repository: "target-repo",
			projectNumber: 1,
			statusField: "Status",
		},
	});
	mocks.loadRunnerCodexConfig.mockResolvedValue({
		config: null,
		loadedFromPath: null,
	});
	mocks.loadRhapsodyMediatorEnv.mockReturnValue({
		MEDIATOR_SECRET: "mediator",
	});
	mocks.loadRhapsodyProtectionBypassEnv.mockReturnValue({});
	mocks.loadRhapsodyCodexBaseSnapshotEnv.mockReturnValue({
		RHAPSODY_CODEX_BASE_SNAPSHOT_ID: null,
	});
	mocks.loadRhapsodyGitHubEnv.mockReturnValue({ GITHUB_TOKEN: "token" });
	mocks.loadMediatorCredentialState.mockResolvedValue(null);
	mocks.buildCodexChatGPTDummyAuthFile.mockReturnValue({
		accountId: "acct_dummy",
		accessToken: "token",
	});
	mocks.buildCodexExecCommand.mockReturnValue({
		command: "codex",
		argv: ["--json"],
		cwd: "/vercel/sandbox/repository",
	});
	mocks.createVercelSandbox.mockResolvedValue({} as never);
	mocks.getVercelSandboxId.mockReturnValue("sandbox-1");
	mocks.createEvent.mockResolvedValue({ id: "event-1" });
	mocks.markAttemptStarted.mockResolvedValue({ applied: true });
	mocks.getRunDetail.mockResolvedValue({
		run: {
			id: "run-1",
			status: "running",
			claimToken: "claim-1",
			runner: "sandbox-codex",
			createdAt: "2026-05-29T00:00:00.000Z",
			updatedAt: "2026-05-29T00:00:00.000Z",
			workItemId: "github_issue:toyamarinyon/target-repo#10",
			workItemTitle: "Test",
			workItemStatus: "open",
			workItemSnapshot: {},
		},
		attempts: [
			{
				id: "attempt-1",
				runId: "run-1",
				attemptNumber: 1,
				status: "pending",
				createdAt: 0,
				updatedAt: 0,
				gitBranchName: "rhapsody/test-1",
				sandboxId: null,
				command: null,
			},
		],
	});
	mocks.runVercelSandboxCommand.mockImplementation(
		(_sandbox, { cmd, args }) => {
			if (cmd === "git" && args?.[0] === "clone") {
				return Promise.resolve(
					makeCommand({
						commandId: "clone",
						cmd,
						args,
						exitCode: 0,
					}),
				);
			}

			if (cmd === "git" && args?.includes("checkout")) {
				return Promise.resolve(
					makeCommand({
						commandId: "checkout",
						cmd,
						args,
						exitCode: 0,
					}),
				);
			}

			if (cmd === "cat") {
				return Promise.resolve(
					makeCommand({
						commandId: "read-instructions",
						cmd,
						args,
						exitCode: 1,
						stderr: "cat: not found",
					}),
				);
			}

			return Promise.resolve(
				makeCommand({
					commandId: "other",
					cmd,
					args,
					exitCode: 0,
				}),
			);
		},
	);

	const response = await runSandboxCodexRunner({
		client: {
			close() {},
		} as never,
		request: new Request("https://example.test/api", {
			method: "POST",
			body: "{}",
		}),
		runId: "run-1",
		attemptId: "attempt-1",
		detail: {
			run: {
				id: "run-1",
				status: "running",
				runner: "sandbox-codex",
				claimToken: "claim-1",
				runnerWorkflowRunId: null,
				workItemId: "github_issue:toyamarinyon/target-repo#10",
				workItemTitle: "Test",
				workItemUrl: null,
				workItemStatus: "open",
				workItemSnapshot: {},
				createdAt: 0,
				updatedAt: 0,
				startedAt: null,
				finishedAt: null,
			},
			attempts: [
				{
					id: "attempt-1",
					runId: "run-1",
					attemptNumber: 1,
					status: "pending",
					createdAt: 0,
					updatedAt: 0,
					startedAt: null,
					finishedAt: null,
					gitBranchName: "rhapsody/test-1",
					sandboxId: null,
					command: null,
					exitCode: null,
				},
			],
			events: [],
			sandboxSessions: [],
			claim: null,
		},
		attempt: {
			id: "attempt-1",
			runId: "run-1",
			attemptNumber: 1,
			status: "pending",
			createdAt: 0,
			updatedAt: 0,
			startedAt: null,
			finishedAt: null,
			gitBranchName: "rhapsody/test-1",
			sandboxId: null,
			command: null,
			exitCode: null,
		},
	});

	const bodyText = await response.text();
	expect(response.status).toBe(422);
	expect(JSON.parse(bodyText)).toMatchObject({
		error: expect.stringContaining("Repository instructions file"),
		instructionPath: "/vercel/sandbox/repository/.rhapsody/INSTRUCTIONS.md",
	});
	expect(mocks.runVercelSandboxCommand).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			cmd: "cat",
			args: ["/vercel/sandbox/repository/.rhapsody/INSTRUCTIONS.md"],
		}),
	);
	expect(mocks.markAttemptStarted).not.toHaveBeenCalled();
	expect(mocks.startVercelSandboxCommand).not.toHaveBeenCalled();
});

test("reads sandbox instructions after clone and checkout before building and starting Codex", async () => {
	mocks.loadRhapsodyConfig.mockReturnValue({
		repository: {
			owner: "toyamarinyon",
			name: "target-repo",
			defaultBranch: "main",
			branchPrefix: "rhapsody/",
		},
		runner: {
			timeoutMs: 1000,
			sandboxTimeoutMs: 1000,
			outputPreviewLength: 80,
			progressIntervalMs: 0,
			progressPreviewLength: 80,
		},
		tracker: {
			owner: "toyamarinyon",
			repository: "target-repo",
			projectNumber: 1,
			statusField: "Status",
		},
	});
	mocks.loadRunnerCodexConfig.mockResolvedValue({
		config: null,
		loadedFromPath: null,
	});
	mocks.loadRhapsodyMediatorEnv.mockReturnValue({
		MEDIATOR_SECRET: "mediator",
	});
	mocks.loadRhapsodyProtectionBypassEnv.mockReturnValue({});
	mocks.loadRhapsodyCodexBaseSnapshotEnv.mockReturnValue({
		RHAPSODY_CODEX_BASE_SNAPSHOT_ID: null,
	});
	mocks.loadRhapsodyGitHubEnv.mockReturnValue({ GITHUB_TOKEN: "token" });
	mocks.loadMediatorCredentialState.mockResolvedValue(null);
	mocks.buildCodexExecCommand.mockReturnValue({
		command: "codex",
		argv: ["--json"],
		cwd: "/vercel/sandbox/repository",
	});
	mocks.createVercelSandbox.mockResolvedValue({} as never);
	mocks.getVercelSandboxId.mockReturnValue("sandbox-1");
	mocks.createEvent.mockResolvedValue({ id: "event-1" });
	mocks.markAttemptStarted.mockResolvedValue({ applied: true });
	mocks.getRunDetail.mockResolvedValue({
		run: {
			id: "run-1",
			status: "running",
			claimToken: "claim-1",
			runner: "sandbox-codex",
			createdAt: "2026-05-29T00:00:00.000Z",
			updatedAt: "2026-05-29T00:00:00.000Z",
			workItemId: "github_issue:toyamarinyon/target-repo#10",
			workItemTitle: "Test",
			workItemStatus: "open",
			workItemSnapshot: {},
		},
		attempts: [
			{
				id: "attempt-1",
				runId: "run-1",
				attemptNumber: 1,
				status: "pending",
				createdAt: 0,
				updatedAt: 0,
				gitBranchName: "rhapsody/test-1",
				sandboxId: null,
				command: null,
			},
		],
	});
	mocks.runVercelSandboxCommand.mockImplementation(
		(_sandbox, { cmd, args }) => {
			if (cmd === "git" && args?.[0] === "clone") {
				return Promise.resolve(
					makeCommand({
						commandId: "clone",
						cmd,
						args,
						exitCode: 0,
					}),
				);
			}

			if (cmd === "git" && args?.includes("checkout")) {
				return Promise.resolve(
					makeCommand({
						commandId: "checkout",
						cmd,
						args,
						exitCode: 0,
					}),
				);
			}

			if (cmd === "cat") {
				return Promise.resolve(
					makeCommand({
						commandId: "read-instructions",
						cmd,
						args,
						exitCode: 0,
						stdout: "# instructions\n",
					}),
				);
			}

			if (cmd === "node" && args?.[0] === "-e") {
				return Promise.resolve(
					makeCommand({
						commandId: "network-probe",
						cmd,
						args,
						exitCode: 0,
						stdout: JSON.stringify({
							status: 200,
							statusText: "OK",
							contentType: "application/json",
							bodyPreview: "{}",
							bodyLength: 2,
							looksLikeRhapsodyProxy: false,
						}),
					}),
				);
			}

			return Promise.resolve(
				makeCommand({
					commandId: "other",
					cmd,
					args,
					exitCode: 0,
				}),
			);
		},
	);
	mocks.startVercelSandboxCommand.mockResolvedValue(
		makeCommand({
			commandId: "wrapper",
			cmd: "node",
			args: ["wrapper.js"],
			exitCode: 0,
		}),
	);

	const response = await runSandboxCodexRunner({
		client: {
			close() {},
		} as never,
		request: new Request("https://example.test/api", {
			method: "POST",
			body: "{}",
		}),
		runId: "run-1",
		attemptId: "attempt-1",
		detail: {
			run: {
				id: "run-1",
				status: "running",
				runner: "sandbox-codex",
				claimToken: "claim-1",
				runnerWorkflowRunId: null,
				workItemId: "github_issue:toyamarinyon/target-repo#10",
				workItemTitle: "Test",
				workItemUrl: null,
				workItemStatus: "open",
				workItemSnapshot: {},
				createdAt: 0,
				updatedAt: 0,
				startedAt: null,
				finishedAt: null,
			},
			attempts: [
				{
					id: "attempt-1",
					runId: "run-1",
					attemptNumber: 1,
					status: "pending",
					createdAt: 0,
					updatedAt: 0,
					startedAt: null,
					finishedAt: null,
					gitBranchName: "rhapsody/test-1",
					sandboxId: null,
					command: null,
					exitCode: null,
				},
			],
			events: [],
			sandboxSessions: [],
			claim: null,
		},
		attempt: {
			id: "attempt-1",
			runId: "run-1",
			attemptNumber: 1,
			status: "pending",
			createdAt: 0,
			updatedAt: 0,
			startedAt: null,
			finishedAt: null,
			gitBranchName: "rhapsody/test-1",
			sandboxId: null,
			command: null,
			exitCode: null,
		},
	});

	expect(response.status).toBe(200);
	const commandInputs = mocks.runVercelSandboxCommand.mock.calls.map(
		([, input]) => input as { cmd: string; args?: string[] },
	);
	const cloneIndex = commandInputs.findIndex(
		(input) =>
			input.cmd === "git" &&
			input.args?.[0] === "clone" &&
			input.args?.includes("/vercel/sandbox/repository"),
	);
	const checkoutIndex = commandInputs.findIndex(
		(input) =>
			input.cmd === "git" &&
			input.args?.includes("checkout") &&
			input.args?.includes("rhapsody/test-1"),
	);
	const instructionsIndex = commandInputs.findIndex(
		(input) =>
			input.cmd === "cat" &&
			input.args?.[0] ===
				"/vercel/sandbox/repository/.rhapsody/INSTRUCTIONS.md",
	);
	expect(cloneIndex).toBeGreaterThanOrEqual(0);
	expect(checkoutIndex).toBeGreaterThan(cloneIndex);
	expect(instructionsIndex).toBeGreaterThan(checkoutIndex);
	expect(mocks.buildCodexExecCommand).toHaveBeenCalledTimes(1);
	expect(mocks.writeVercelSandboxFiles).toHaveBeenCalledTimes(1);
	expect(mocks.markAttemptStarted).toHaveBeenCalledTimes(1);
	expect(mocks.startVercelSandboxCommand).toHaveBeenCalledTimes(1);
	const instructionsCallOrder =
		mocks.runVercelSandboxCommand.mock.invocationCallOrder[instructionsIndex];
	expect(instructionsCallOrder).toBeLessThan(
		mocks.buildCodexExecCommand.mock.invocationCallOrder[0],
	);
	expect(mocks.buildCodexExecCommand.mock.invocationCallOrder[0]).toBeLessThan(
		mocks.writeVercelSandboxFiles.mock.invocationCallOrder[0],
	);
	expect(
		mocks.writeVercelSandboxFiles.mock.invocationCallOrder[0],
	).toBeLessThan(mocks.markAttemptStarted.mock.invocationCallOrder[0]);
	expect(mocks.markAttemptStarted.mock.invocationCallOrder[0]).toBeLessThan(
		mocks.startVercelSandboxCommand.mock.invocationCallOrder[0],
	);
});
