import type { Client } from "@libsql/client";
import { createEvent, type CreatedEvent, type EventLevel } from "./store";
import type { SandboxLifecycleEventType } from "./sandbox-sessions";

export type SandboxLifecycleEventContext = {
	sandboxId: string;
	purpose?: string | null;
	workerKind?: string | null;
	workItemId?: string | null;
	runId?: string | null;
	attemptId?: string | null;
	workerRunId?: string | null;
	sourceSnapshotId?: string | null;
	timeoutMs?: number | null;
};

export type SandboxLifecycleCommandSummary = {
	commandId: string;
	cwd: string;
	startedAt: number;
	exitCode?: number;
	timedOut?: boolean;
	error?: string;
};

export async function recordSandboxLifecycleEvent(input: {
	client: Client;
	type: SandboxLifecycleEventType;
	context: SandboxLifecycleEventContext;
	level?: EventLevel;
	message?: string | null;
	now?: number;
	data?: Record<string, unknown>;
}): Promise<CreatedEvent> {
	return createEvent(input.client, {
		runId: input.context.runId ?? null,
		attemptId: input.context.attemptId ?? null,
		level: input.level ?? defaultLevelForSandboxEvent(input.type),
		type: input.type,
		message: input.message ?? defaultMessageForSandboxEvent(input.type),
		now: input.now,
		data: buildSandboxEventData(input.context, input.data),
	});
}

export async function recordSandboxCommandStartedEvent(input: {
	client: Client;
	context: SandboxLifecycleEventContext;
	commandName?: string | null;
	timeoutMs?: number | null;
	summary: Pick<
		SandboxLifecycleCommandSummary,
		"commandId" | "cwd" | "startedAt"
	>;
}): Promise<CreatedEvent> {
	return recordSandboxLifecycleEvent({
		client: input.client,
		type: "sandbox.command_started",
		context: input.context,
		now: input.summary.startedAt,
		data: {
			commandId: input.summary.commandId,
			commandName: input.commandName ?? null,
			cwd: input.summary.cwd,
			startedAt: input.summary.startedAt,
			timeoutMs: input.timeoutMs ?? null,
		},
	});
}

export async function recordSandboxCommandFinishedEvent(input: {
	client: Client;
	context: SandboxLifecycleEventContext;
	commandName?: string | null;
	timeoutMs?: number | null;
	summary: SandboxLifecycleCommandSummary;
}): Promise<CreatedEvent> {
	return recordSandboxLifecycleEvent({
		client: input.client,
		type: "sandbox.command_finished",
		context: input.context,
		data: {
			commandId: input.summary.commandId,
			commandName: input.commandName ?? null,
			cwd: input.summary.cwd,
			startedAt: input.summary.startedAt,
			exitCode: input.summary.exitCode ?? null,
			timedOut: input.summary.timedOut ?? null,
			timeoutMs: input.timeoutMs ?? null,
			error: sanitizeError(input.summary.error),
		},
	});
}

export async function stopSandboxWithLifecycleEvents(input: {
	client: Client;
	context: SandboxLifecycleEventContext;
	reason?: string | null;
	stop: () => Promise<void>;
	throwOnFailure?: boolean;
}): Promise<void> {
	await recordSandboxLifecycleEventSafely({
		client: input.client,
		type: "sandbox.stop_requested",
		context: input.context,
		data: {
			reason: input.reason ?? null,
		},
	});

	try {
		await input.stop();
		await recordSandboxLifecycleEventSafely({
			client: input.client,
			type: "sandbox.stopped",
			context: input.context,
			data: {
				reason: input.reason ?? null,
			},
		});
	} catch (error) {
		await recordSandboxLifecycleEventSafely({
			client: input.client,
			type: "sandbox.stop_failed",
			level: "warn",
			context: input.context,
			data: {
				reason: input.reason ?? null,
				error: sanitizeError(
					error instanceof Error ? error.message : String(error),
				),
			},
		});
		if (input.throwOnFailure ?? true) {
			throw error;
		}
	}
}

async function recordSandboxLifecycleEventSafely(input: {
	client: Client;
	type: SandboxLifecycleEventType;
	context: SandboxLifecycleEventContext;
	level?: EventLevel;
	data?: Record<string, unknown>;
}) {
	try {
		await recordSandboxLifecycleEvent(input);
	} catch {
		return;
	}
}

function buildSandboxEventData(
	context: SandboxLifecycleEventContext,
	data: Record<string, unknown> | undefined,
) {
	return {
		sandboxId: context.sandboxId,
		purpose: context.purpose ?? null,
		workerKind: context.workerKind ?? null,
		workItemId: context.workItemId ?? null,
		runId: context.runId ?? null,
		attemptId: context.attemptId ?? null,
		workerRunId: context.workerRunId ?? null,
		commandId: null,
		sourceSnapshotId: context.sourceSnapshotId ?? null,
		timeoutMs: context.timeoutMs ?? null,
		reason: null,
		error: null,
		...data,
	};
}

function defaultLevelForSandboxEvent(
	type: SandboxLifecycleEventType,
): EventLevel {
	if (type === "sandbox.stop_failed") {
		return "warn";
	}

	return "info";
}

function defaultMessageForSandboxEvent(type: SandboxLifecycleEventType) {
	switch (type) {
		case "sandbox.created":
			return "Sandbox created.";
		case "sandbox.command_started":
			return "Sandbox command started.";
		case "sandbox.command_finished":
			return "Sandbox command finished.";
		case "sandbox.stop_requested":
			return "Sandbox stop requested.";
		case "sandbox.stopped":
			return "Sandbox stopped.";
		case "sandbox.stop_failed":
			return "Sandbox stop failed.";
		case "sandbox.retained":
			return "Sandbox retained.";
	}
}

function sanitizeError(value: string | undefined) {
	if (typeof value !== "string" || !value.trim()) {
		return null;
	}

	return value.slice(0, 1_000);
}
