import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { expect, test } from "vitest";

import {
	createAttempt,
	createEvent,
	createManualRun,
	createWorkerRun,
	getRunDetail,
	listWorkItemGraph,
	migrateStateStore,
	projectSandboxSessions,
	type StateStoreEvent,
} from "@/lib/state";

test("projectSandboxSessions groups multiple sandboxes and commands", () => {
	const events: StateStoreEvent[] = [
		{
			id: "evt_builder_created",
			runId: "run_builder",
			attemptId: "att_builder",
			level: "info",
			type: "sandbox.created",
			message: "Sandbox created.",
			data: {
				sandboxId: "sandbox-builder",
				purpose: "builder_execution",
				workerKind: "builder",
				workItemId: "github_issue:owner/repo#88",
				runId: "run_builder",
				attemptId: "att_builder",
				workerRunId: "wrn_builder",
				sourceSnapshotId: "snap_123",
				timeoutMs: 300_000,
			},
			createdAt: 10,
		},
		{
			id: "evt_builder_clone_started",
			runId: "run_builder",
			attemptId: "att_builder",
			level: "info",
			type: "sandbox.command_started",
			message: "Sandbox command started.",
			data: {
				sandboxId: "sandbox-builder",
				commandId: "cmd_clone",
				commandName: "source_clone",
				cwd: "/vercel/sandbox",
				startedAt: 20,
			},
			createdAt: 20,
		},
		{
			id: "evt_builder_clone_finished",
			runId: "run_builder",
			attemptId: "att_builder",
			level: "info",
			type: "sandbox.command_finished",
			message: "Sandbox command finished.",
			data: {
				sandboxId: "sandbox-builder",
				commandId: "cmd_clone",
				commandName: "source_clone",
				cwd: "/vercel/sandbox",
				startedAt: 20,
				exitCode: 0,
			},
			createdAt: 21,
		},
		{
			id: "evt_builder_wrapper_started",
			runId: "run_builder",
			attemptId: "att_builder",
			level: "info",
			type: "sandbox.command_started",
			message: "Sandbox command started.",
			data: {
				sandboxId: "sandbox-builder",
				commandId: "cmd_wrapper",
				commandName: "wrapper",
				cwd: "/vercel/sandbox",
				startedAt: 30,
				timeoutMs: 120_000,
			},
			createdAt: 30,
		},
		{
			id: "evt_builder_retained",
			runId: "run_builder",
			attemptId: "att_builder",
			level: "info",
			type: "sandbox.retained",
			message: "Sandbox retained.",
			data: {
				sandboxId: "sandbox-builder",
				reason: "waiting_for_callback",
			},
			createdAt: 31,
		},
		{
			id: "evt_intake_created",
			runId: null,
			attemptId: null,
			level: "info",
			type: "sandbox.created",
			message: "Sandbox created.",
			data: {
				sandboxId: "sandbox-intake",
				purpose: "intake_classification",
				workerKind: "intake_curator",
				workItemId: "github_issue:owner/repo#88",
				workerRunId: "wrn_intake",
				timeoutMs: 150_000,
			},
			createdAt: 40,
		},
		{
			id: "evt_intake_wrapper_started",
			runId: null,
			attemptId: null,
			level: "info",
			type: "sandbox.command_started",
			message: "Sandbox command started.",
			data: {
				sandboxId: "sandbox-intake",
				commandId: "cmd_intake_wrapper",
				commandName: "classifier_wrapper",
				cwd: "/vercel/sandbox",
				startedAt: 41,
			},
			createdAt: 41,
		},
		{
			id: "evt_intake_wrapper_finished",
			runId: null,
			attemptId: null,
			level: "info",
			type: "sandbox.command_finished",
			message: "Sandbox command finished.",
			data: {
				sandboxId: "sandbox-intake",
				commandId: "cmd_intake_wrapper",
				commandName: "classifier_wrapper",
				cwd: "/vercel/sandbox",
				startedAt: 41,
				exitCode: 0,
			},
			createdAt: 42,
		},
		{
			id: "evt_intake_output_started",
			runId: null,
			attemptId: null,
			level: "info",
			type: "sandbox.command_started",
			message: "Sandbox command started.",
			data: {
				sandboxId: "sandbox-intake",
				commandId: "cmd_read_output",
				commandName: "read_output",
				cwd: "/vercel/sandbox",
				startedAt: 43,
			},
			createdAt: 43,
		},
		{
			id: "evt_intake_output_finished",
			runId: null,
			attemptId: null,
			level: "info",
			type: "sandbox.command_finished",
			message: "Sandbox command finished.",
			data: {
				sandboxId: "sandbox-intake",
				commandId: "cmd_read_output",
				commandName: "read_output",
				cwd: "/vercel/sandbox",
				startedAt: 43,
				exitCode: 0,
			},
			createdAt: 44,
		},
		{
			id: "evt_intake_stop_requested",
			runId: null,
			attemptId: null,
			level: "info",
			type: "sandbox.stop_requested",
			message: "Sandbox stop requested.",
			data: {
				sandboxId: "sandbox-intake",
				reason: "intake_classifier_completed",
			},
			createdAt: 45,
		},
		{
			id: "evt_intake_stopped",
			runId: null,
			attemptId: null,
			level: "info",
			type: "sandbox.stopped",
			message: "Sandbox stopped.",
			data: {
				sandboxId: "sandbox-intake",
				reason: "intake_classifier_completed",
			},
			createdAt: 46,
		},
	];

	const sessions = projectSandboxSessions(events);

	expect(sessions).toHaveLength(2);
	expect(sessions[0]).toEqual(
		expect.objectContaining({
			sandboxId: "sandbox-builder",
			status: "retained",
			reason: "waiting_for_callback",
			workerRunId: "wrn_builder",
			runId: "run_builder",
			attemptId: "att_builder",
		}),
	);
	expect(sessions[0]?.commands).toEqual([
		expect.objectContaining({
			commandId: "cmd_clone",
			commandName: "source_clone",
			status: "finished",
			exitCode: 0,
		}),
		expect.objectContaining({
			commandId: "cmd_wrapper",
			commandName: "wrapper",
			status: "started",
			timeoutMs: 120_000,
		}),
	]);

	expect(sessions[1]).toEqual(
		expect.objectContaining({
			sandboxId: "sandbox-intake",
			status: "stopped",
			reason: "intake_classifier_completed",
			workerRunId: "wrn_intake",
			stopRequestedAt: 45,
			stoppedAt: 46,
		}),
	);
	expect(sessions[1]?.commands.map((command) => command.commandName)).toEqual([
		"classifier_wrapper",
		"read_output",
	]);
});

test("getRunDetail includes sandboxSessions projected from run events", async () => {
	const database = await createTestDatabase();
	const client = database.client;

	try {
		const run = await createManualRun(client, {
			workItemId: "github_issue:owner/repo#201",
			claimToken: "claim_201",
			runner: "sandbox-codex",
			workItemTitle: "Track sandbox usage",
		});
		const attempt = await createAttempt(client, {
			runId: run.id,
			attemptNumber: 1,
		});

		await createEvent(client, {
			runId: run.id,
			attemptId: attempt.id,
			type: "sandbox.created",
			data: {
				sandboxId: "sandbox-run-detail",
				purpose: "builder_execution",
				workerKind: "builder",
				workItemId: "github_issue:owner/repo#201",
				runId: run.id,
				attemptId: attempt.id,
			},
			now: 100,
		});
		await createEvent(client, {
			runId: run.id,
			attemptId: attempt.id,
			type: "sandbox.retained",
			data: {
				sandboxId: "sandbox-run-detail",
				reason: "waiting_for_callback",
			},
			now: 101,
		});

		const detail = await getRunDetail(client, run.id);
		expect(detail).not.toBeNull();
		expect(detail?.events).toHaveLength(2);
		expect(detail?.sandboxSessions).toEqual([
			expect.objectContaining({
				sandboxId: "sandbox-run-detail",
				status: "retained",
				reason: "waiting_for_callback",
			}),
		]);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("listWorkItemGraph includes sandboxSessions from run and worker lifecycle events", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:owner/repo#202";

	try {
		const workerRun = await createWorkerRun(client, {
			id: "wrn_intake_graph",
			workItemId,
			kind: "intake_curator",
			status: "completed",
		});
		const run = await createManualRun(client, {
			workItemId,
			claimToken: "claim_202",
			runner: "sandbox-codex",
			workItemTitle: "Graph sandbox projection",
		});
		const attempt = await createAttempt(client, {
			runId: run.id,
			attemptNumber: 1,
		});

		await createEvent(client, {
			runId: run.id,
			attemptId: attempt.id,
			type: "sandbox.created",
			data: {
				sandboxId: "sandbox-builder-graph",
				purpose: "builder_execution",
				workerKind: "builder",
				workItemId,
				runId: run.id,
				attemptId: attempt.id,
			},
			now: 200,
		});
		await createEvent(client, {
			runId: run.id,
			attemptId: attempt.id,
			type: "sandbox.retained",
			data: {
				sandboxId: "sandbox-builder-graph",
				reason: "waiting_for_callback",
			},
			now: 201,
		});
		await createEvent(client, {
			type: "sandbox.created",
			data: {
				sandboxId: "sandbox-intake-graph",
				purpose: "intake_classification",
				workerKind: "intake_curator",
				workItemId,
				workerRunId: workerRun.id,
			},
			now: 202,
		});
		await createEvent(client, {
			type: "sandbox.stopped",
			data: {
				sandboxId: "sandbox-intake-graph",
				workItemId,
				workerRunId: workerRun.id,
				reason: "intake_classifier_completed",
			},
			now: 203,
		});

		const graph = await listWorkItemGraph(client, workItemId);
		expect(graph.sandboxSessions).toHaveLength(2);
		expect(graph.sandboxSessions.map((session) => session.status)).toEqual([
			"retained",
			"stopped",
		]);
		expect(graph.sandboxSessions.map((session) => session.sandboxId)).toEqual([
			"sandbox-builder-graph",
			"sandbox-intake-graph",
		]);
	} finally {
		client.close();
		database.cleanup();
	}
});

async function createTestDatabase(): Promise<{
	client: Client;
	cleanup: () => void;
}> {
	const directory = mkdtempSync(path.join(tmpdir(), "rhapsody-test-"));
	const client = createClient({
		url: `file:${path.join(directory, "state.db")}`,
	});
	await migrateStateStore(client);
	return {
		client,
		cleanup: () => rmSync(directory, { force: true, recursive: true }),
	};
}
