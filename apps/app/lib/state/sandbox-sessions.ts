import type { StateStoreEvent } from "./store";

export const SANDBOX_LIFECYCLE_EVENT_TYPES = [
	"sandbox.created",
	"sandbox.command_started",
	"sandbox.command_finished",
	"sandbox.stop_requested",
	"sandbox.stopped",
	"sandbox.stop_failed",
	"sandbox.retained",
] as const;

export type SandboxLifecycleEventType =
	(typeof SANDBOX_LIFECYCLE_EVENT_TYPES)[number];

export type SandboxSessionStatus =
	| "created"
	| "command_started"
	| "command_finished"
	| "stop_requested"
	| "stopped"
	| "stop_failed"
	| "retained";

export type SandboxSessionCommandStatus = "started" | "finished";

export type SandboxSessionCommandProjection = {
	commandId: string;
	commandName: string | null;
	status: SandboxSessionCommandStatus;
	cwd: string | null;
	startedAt: number | null;
	finishedAt: number | null;
	exitCode: number | null;
	timedOut: boolean | null;
	timeoutMs: number | null;
	error: string | null;
};

export type SandboxSessionProjection = {
	sandboxId: string;
	purpose: string | null;
	workerKind: string | null;
	workItemId: string | null;
	runId: string | null;
	attemptId: string | null;
	workerRunId: string | null;
	sourceSnapshotId: string | null;
	timeoutMs: number | null;
	status: SandboxSessionStatus;
	reason: string | null;
	error: string | null;
	createdAt: number;
	updatedAt: number;
	retainedAt: number | null;
	stopRequestedAt: number | null;
	stoppedAt: number | null;
	commands: SandboxSessionCommandProjection[];
};

type MutableSandboxSessionProjection = Omit<
	SandboxSessionProjection,
	"commands"
> & {
	commands: Map<string, SandboxSessionCommandProjection>;
};

const SANDBOX_EVENT_TYPE_SET = new Set<string>(SANDBOX_LIFECYCLE_EVENT_TYPES);

export function projectSandboxSessions(
	events: readonly StateStoreEvent[],
): SandboxSessionProjection[] {
	const sessions = new Map<string, MutableSandboxSessionProjection>();

	for (const event of [...events].sort(
		(left, right) => left.createdAt - right.createdAt,
	)) {
		if (!isSandboxLifecycleEventType(event.type)) {
			continue;
		}

		const data = asRecord(event.data);
		const sandboxId = readString(data, "sandboxId");

		if (!sandboxId) {
			continue;
		}

		const session =
			sessions.get(sandboxId) ??
			createSessionProjection({
				sandboxId,
				runId: event.runId ?? readString(data, "runId"),
				attemptId: event.attemptId ?? readString(data, "attemptId"),
				purpose: readString(data, "purpose"),
				workerKind: readString(data, "workerKind"),
				workItemId: readString(data, "workItemId"),
				workerRunId: readString(data, "workerRunId"),
				sourceSnapshotId: readString(data, "sourceSnapshotId"),
				timeoutMs: readNumber(data, "timeoutMs"),
				createdAt: event.createdAt,
				status: typeToStatus(event.type),
			});

		session.updatedAt = Math.max(session.updatedAt, event.createdAt);
		session.status = typeToStatus(event.type);
		session.runId ??= event.runId ?? readString(data, "runId");
		session.attemptId ??= event.attemptId ?? readString(data, "attemptId");
		session.purpose ??= readString(data, "purpose");
		session.workerKind ??= readString(data, "workerKind");
		session.workItemId ??= readString(data, "workItemId");
		session.workerRunId ??= readString(data, "workerRunId");
		session.sourceSnapshotId ??= readString(data, "sourceSnapshotId");
		session.timeoutMs ??= readNumber(data, "timeoutMs");

		const reason = readString(data, "reason");
		const error = readString(data, "error");

		if (reason) {
			session.reason = reason;
		}

		if (error) {
			session.error = error;
		}

		if (event.type === "sandbox.retained") {
			session.retainedAt = event.createdAt;
		}

		if (event.type === "sandbox.stop_requested") {
			session.stopRequestedAt = event.createdAt;
		}

		if (event.type === "sandbox.stopped") {
			session.stoppedAt = event.createdAt;
		}

		if (
			event.type === "sandbox.command_started" ||
			event.type === "sandbox.command_finished"
		) {
			const commandId = readString(data, "commandId");

			if (commandId) {
				const command =
					session.commands.get(commandId) ?? createCommandProjection(commandId);

				command.commandName ??= readString(data, "commandName");
				command.cwd ??= readString(data, "cwd");
				command.startedAt ??=
					readNumber(data, "startedAt") ??
					(event.type === "sandbox.command_started" ? event.createdAt : null);
				command.timeoutMs ??= readNumber(data, "timeoutMs");

				if (event.type === "sandbox.command_started") {
					command.status = "started";
				} else {
					command.status = "finished";
					command.finishedAt = event.createdAt;
					command.exitCode = readNumber(data, "exitCode");
					command.timedOut = readBoolean(data, "timedOut");
					command.error = readString(data, "error");
				}

				session.commands.set(commandId, command);
			}
		}

		sessions.set(sandboxId, session);
	}

	return [...sessions.values()]
		.sort((left, right) => left.createdAt - right.createdAt)
		.map((session) => ({
			...session,
			commands: [...session.commands.values()].sort((left, right) => {
				const leftTime = left.startedAt ?? left.finishedAt ?? 0;
				const rightTime = right.startedAt ?? right.finishedAt ?? 0;
				return leftTime - rightTime;
			}),
		}));
}

function isSandboxLifecycleEventType(
	type: string,
): type is SandboxLifecycleEventType {
	return SANDBOX_EVENT_TYPE_SET.has(type);
}

function createSessionProjection(input: {
	sandboxId: string;
	purpose: string | null;
	workerKind: string | null;
	workItemId: string | null;
	runId: string | null;
	attemptId: string | null;
	workerRunId: string | null;
	sourceSnapshotId: string | null;
	timeoutMs: number | null;
	createdAt: number;
	status: SandboxSessionStatus;
}): MutableSandboxSessionProjection {
	return {
		sandboxId: input.sandboxId,
		purpose: input.purpose,
		workerKind: input.workerKind,
		workItemId: input.workItemId,
		runId: input.runId,
		attemptId: input.attemptId,
		workerRunId: input.workerRunId,
		sourceSnapshotId: input.sourceSnapshotId,
		timeoutMs: input.timeoutMs,
		status: input.status,
		reason: null,
		error: null,
		createdAt: input.createdAt,
		updatedAt: input.createdAt,
		retainedAt: null,
		stopRequestedAt: null,
		stoppedAt: null,
		commands: new Map(),
	};
}

function createCommandProjection(
	commandId: string,
): SandboxSessionCommandProjection {
	return {
		commandId,
		commandName: null,
		status: "started",
		cwd: null,
		startedAt: null,
		finishedAt: null,
		exitCode: null,
		timedOut: null,
		timeoutMs: null,
		error: null,
	};
}

function typeToStatus(type: SandboxLifecycleEventType): SandboxSessionStatus {
	return type.replace("sandbox.", "") as SandboxSessionStatus;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;
}

function readString(
	value: Record<string, unknown> | null,
	key: string,
): string | null {
	const candidate = value?.[key];
	return typeof candidate === "string" && candidate.trim() ? candidate : null;
}

function readNumber(
	value: Record<string, unknown> | null,
	key: string,
): number | null {
	const candidate = value?.[key];
	return typeof candidate === "number" && Number.isFinite(candidate)
		? candidate
		: null;
}

function readBoolean(
	value: Record<string, unknown> | null,
	key: string,
): boolean | null {
	const candidate = value?.[key];
	return typeof candidate === "boolean" ? candidate : null;
}
