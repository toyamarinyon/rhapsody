import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Client, createClient } from "@libsql/client";
import { expect, test, vi } from "vitest";

import {
	createDecision,
	createWorkerRun,
	listWorkItemGraph,
	migrateStateStore,
} from "@/lib/state";
import {
	buildIntakeInputFingerprint,
	type IntakeClassification,
	type IntakeClassifierRunner,
	type IntakeCuratorWorkItem,
	intakeClassificationJsonSchema,
	intakeClassificationSchema,
	isIntakeBuildable,
	runIntakeCurator,
} from "@/lib/workers/intake-curator";

type MockComment = {
	owner: string;
	repository: string;
	issueNumber: number;
	body: string;
};

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

function buildProjectItem(input: {
	issueNumber: number;
	issueTitle: string;
	issueBody?: string | null;
	issueState?: string;
	projectStatus?: string | null;
	blockedBy?: IntakeCuratorWorkItem["blockedBy"];
}): IntakeCuratorWorkItem {
	return {
		issueNumber: input.issueNumber,
		issueTitle: input.issueTitle,
		issueBody:
			input.issueBody ??
			"Please move this issue forward with a small focused implementation.",
		issueUrl: `https://github.com/toyamarinyon/rhapsody/issues/${input.issueNumber}`,
		issueState: input.issueState ?? "OPEN",
		projectStatus: input.projectStatus ?? "Todo",
		blockedBy: [],
		projectFields: {},
		repository: {
			owner: "toyamarinyon",
			name: "rhapsody",
		},
		...(input.blockedBy ? { blockedBy: input.blockedBy } : {}),
	};
}

function mockCommentCapture(list: MockComment[]): ReturnType<typeof vi.fn> {
	return vi.fn(async (comment: MockComment) => {
		list.push(comment);
		return {
			id: list.length + 1000,
			htmlUrl: `https://github.com/toyamarinyon/rhapsody/issues/${comment.issueNumber}#issuecomment-${list.length}`,
		};
	});
}

const noNativeDependenciesFetcher = async () => [];

function buildClassifierResult(
	classification: IntakeClassification,
): Awaited<ReturnType<IntakeClassifierRunner>> {
	return {
		classification,
		raw: "{}",
		command: "mock",
	};
}

test("intake classification schema validates decision-specific requirements", () => {
	expect(() =>
		intakeClassificationSchema.parse({
			decision: "buildable",
			summary: "Ready to build.",
			implementation_plan: "Make the requested focused change.",
			comment: "Start implementation with existing details.",
		}),
	).not.toThrow();

	expect(() =>
		intakeClassificationSchema.parse({
			decision: "ask_human",
			summary: "Need acceptance criteria.",
			question: "What should the final behavior be?",
			comment: "Please specify expected result.",
		}),
	).not.toThrow();

	expect(() =>
		intakeClassificationSchema.parse({
			decision: "skip",
			summary: "External dependency not ready.",
			reason: "External dependency not ready.",
			comment: "Wait for dependency and retry later.",
		}),
	).not.toThrow();

	expect(() =>
		intakeClassificationSchema.parse({
			decision: "buildable",
			summary: "Ready",
		}),
	).toThrow();

	expect(intakeClassificationJsonSchema.title).toBe("IntakeClassification");
	expect(intakeClassificationJsonSchema).toHaveProperty("oneOf");
});

test("runIntakeCurator dedupes by fingerprint and reuses decision", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItem = buildProjectItem({
		issueNumber: 210,
		issueTitle: "Small fix request",
		issueBody: "This is a full sentence body for intake validation.",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#210";

	try {
		const workerRun = await createWorkerRun(client, {
			id: "wrn_existing",
			workItemId,
			kind: "intake_curator",
			status: "completed",
		});
		const decisionId = await createDecision(client, {
			id: "dec_existing",
			workItemId,
			workerRunId: workerRun.id,
			phase: "intake",
			outcome: "buildable",
			evidence: {
				inputFingerprint: buildIntakeInputFingerprint(workItem),
				reason: "cached",
			},
			nextAction: "use previous run",
			nextWorkerKind: "builder",
		});

		const result = await runIntakeCurator(client, workItem, workItemId, {
			dependencies: {
				fetchBlockedBy: noNativeDependenciesFetcher,
			},
			classify: async () =>
				buildClassifierResult({
					decision: "buildable",
					summary: "Ready.",
					implementation_plan: "Use previous context.",
					comment: "Proceeding with the cached plan.",
				}),
			existingDecisions: [
				{
					id: decisionId,
					workItemId,
					workerRunId: workerRun.id,
					phase: "intake",
					outcome: "buildable",
					deterministic: true,
					policyVersion: null,
					policyRuleId: null,
					evidence: {
						inputFingerprint: buildIntakeInputFingerprint(workItem),
						reason: "cached",
					},
					nextWorkerKind: "builder",
					nextAction: "use previous run",
					createdAt: 0,
					updatedAt: 0,
				},
			],
		});

		expect(result.decisionId).toBe(decisionId);
		expect(result.skippedFreshDuplicate).toBe(true);
		expect(result.workerRunId).toBeNull();
		expect(result.shouldStartBuilder).toBe(true);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("runIntakeCurator does not reuse stale fingerprint decisions", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItem = buildProjectItem({
		issueNumber: 211,
		issueTitle: "Small fix request",
		issueBody: "Stale body",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#211";

	try {
		const workerRun = await createWorkerRun(client, {
			id: "wrn_stale",
			workItemId,
			kind: "intake_curator",
			status: "completed",
		});
		await createDecision(client, {
			id: "dec_stale",
			workItemId,
			workerRunId: workerRun.id,
			phase: "intake",
			outcome: "buildable",
			evidence: {
				inputFingerprint: "old-fingerprint",
				reason: "stale",
			},
		});

		const result = await runIntakeCurator(client, workItem, workItemId, {
			dependencies: {
				fetchBlockedBy: noNativeDependenciesFetcher,
			},
			classify: async () =>
				buildClassifierResult({
					decision: "buildable",
					summary: "Ready.",
					implementation_plan: "Implement the small request.",
					comment: "Proceeding with implementation.",
				}),
			existingDecisions: [
				{
					id: "dec_stale",
					workItemId,
					workerRunId: workerRun.id,
					phase: "intake",
					outcome: "buildable",
					deterministic: true,
					policyVersion: null,
					policyRuleId: null,
					evidence: {
						inputFingerprint: "old-fingerprint",
						reason: "stale",
					},
					nextWorkerKind: "builder",
					nextAction: null,
					createdAt: 1,
					updatedAt: 1,
				},
			],
		});

		expect(result.skippedFreshDuplicate).toBe(false);
		expect(result.workerRunId).not.toBeNull();
	} finally {
		client.close();
		database.cleanup();
	}
});

test("runIntakeCurator records open blocker as blocked", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItem = buildProjectItem({
		issueNumber: 212,
		issueTitle: "Needs later",
		issueBody: "Implement feature after dependency.",
		blockedBy: [{ id: "#111", state: "open" }],
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#212";
	const posted: MockComment[] = [];

	try {
		const result = await runIntakeCurator(client, workItem, workItemId, {
			dependencies: {
				fetchBlockedBy: async () => {
					throw new Error("fallback to project field");
				},
			},
			comment: mockCommentCapture(posted),
			classify: async () =>
				buildClassifierResult({
					decision: "buildable",
					summary: "Closed blocker no longer blocks.",
					implementation_plan: "Proceed with the requested implementation.",
					comment: "The blocker is closed, so I will proceed.",
				}),
		});

		expect(result.outcome).toBe("blocked");
		expect(result.shouldStartBuilder).toBe(false);
		expect(result.commentPosted).toBe(true);
		expect(posted).toHaveLength(1);
		expect(posted[0]?.body).toContain(
			"Rhapsody intake classification: blocked",
		);

		const graph = await listWorkItemGraph(client, workItemId);
		expect(
			graph.decisions.some((decision) => decision.outcome === "blocked"),
		).toBe(true);
		expect(
			graph.artifacts.some((artifact) => artifact.kind === "intake_comment"),
		).toBe(true);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("native open blocker blocks and skips classifier", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItem = buildProjectItem({
		issueNumber: 218,
		issueTitle: "Native blocker",
		issueBody: "Implement after dependent issue.",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#218";
	const posted: MockComment[] = [];
	const classify: IntakeClassifierRunner = vi.fn(async () =>
		buildClassifierResult({
			decision: "buildable",
			summary: "Should not run for native blocker",
			implementation_plan: "Proceed anyway.",
			comment: "Should not run for native blocker.",
		}),
	);

	try {
		const result = await runIntakeCurator(client, workItem, workItemId, {
			dependencies: {
				fetchBlockedBy: async () => [
					{
						id: "I_blocker_open",
						nodeId: "node_open",
						number: 33,
						title: "Open dependency",
						htmlUrl: "https://github.com/toyamarinyon/rhapsody/issues/33",
						repositoryUrl: "https://api.github.com/repos/toyamarinyon/rhapsody",
						state: "open",
						repository: {
							owner: "toyamarinyon",
							name: "rhapsody",
						},
					},
				],
			},
			comment: mockCommentCapture(posted),
			classify,
		});

		expect(result.outcome).toBe("blocked");
		expect(result.shouldStartBuilder).toBe(false);
		expect(result.commentPosted).toBe(true);
		expect(classify).not.toHaveBeenCalled();
		expect(posted).toHaveLength(1);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("native closed blocker does not block and classifier runs", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItem = buildProjectItem({
		issueNumber: 219,
		issueTitle: "Native closed blocker",
		issueBody:
			"This can be handled while blocker is already closed in dependency graph.",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#219";
	const posted: MockComment[] = [];

	try {
		const result = await runIntakeCurator(client, workItem, workItemId, {
			dependencies: {
				fetchBlockedBy: async () => [
					{
						id: "I_blocker_closed",
						nodeId: "node_closed",
						number: 34,
						title: "Closed dependency",
						htmlUrl: "https://github.com/toyamarinyon/rhapsody/issues/34",
						repositoryUrl: "https://api.github.com/repos/toyamarinyon/rhapsody",
						state: "closed",
						repository: {
							owner: "toyamarinyon",
							name: "rhapsody",
						},
					},
				],
			},
			comment: mockCommentCapture(posted),
			classify: async () =>
				buildClassifierResult({
					decision: "buildable",
					summary: "No active blockers.",
					implementation_plan: "Proceed because dependency is closed.",
					comment: "Proceed with implementation.",
					next_action: "start_builder",
				}),
		});

		expect(result.outcome).toBe("buildable");
		expect(result.shouldStartBuilder).toBe(true);
		expect(result.commentPosted).toBe(true);
		expect(posted).toHaveLength(1);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("native empty dependencies proceeds to classifier", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItem = buildProjectItem({
		issueNumber: 220,
		issueTitle: "No blockers",
		issueBody:
			"Classifier should run even when native dependencies endpoint returns empty list.",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#220";
	const posted: MockComment[] = [];

	try {
		const result = await runIntakeCurator(client, workItem, workItemId, {
			dependencies: {
				fetchBlockedBy: async () => [],
			},
			comment: mockCommentCapture(posted),
			classify: async () =>
				buildClassifierResult({
					decision: "skip",
					summary: "External waiting.",
					reason: "No automatic work needed now.",
					comment: "Skip for now.",
				}),
		});

		expect(result.outcome).toBe("skip");
		expect(result.shouldStartBuilder).toBe(false);
		expect(result.commentPosted).toBe(true);
		expect(posted).toHaveLength(1);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("native fetch failure falls back to project text blockers", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItem = buildProjectItem({
		issueNumber: 221,
		issueTitle: "Failed dependency lookup",
		issueBody: "Use project text fallback when native lookup fails.",
		blockedBy: [{ id: "toyamarinyon/rhapsody#300", state: "open" }],
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#221";
	const posted: MockComment[] = [];
	const classify: IntakeClassifierRunner = vi.fn(async () =>
		buildClassifierResult({
			decision: "buildable",
			summary: "Should not run on fallback block.",
			implementation_plan: "Nope",
			comment: "Nope",
		}),
	);

	try {
		const result = await runIntakeCurator(client, workItem, workItemId, {
			dependencies: {
				fetchBlockedBy: async () => {
					throw new Error("blocked dependencies endpoint unavailable");
				},
			},
			comment: mockCommentCapture(posted),
			classify,
		});

		expect(result.outcome).toBe("blocked");
		expect(classify).not.toHaveBeenCalled();
		expect(posted).toHaveLength(1);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("runIntakeCurator does not block when blocker is closed", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItem = buildProjectItem({
		issueNumber: 213,
		issueTitle: "Closed blocker",
		issueBody: "Closed blockers do not prevent build.",
		blockedBy: [{ id: "#111", state: "closed" }],
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#213";
	const posted: MockComment[] = [];

	try {
		const result = await runIntakeCurator(client, workItem, workItemId, {
			dependencies: {
				fetchBlockedBy: async () => {
					throw new Error("fallback to project field");
				},
			},
			comment: mockCommentCapture(posted),
			classify: async () =>
				buildClassifierResult({
					decision: "buildable",
					summary: "Closed blocker no longer blocks.",
					implementation_plan: "Proceed with the requested implementation.",
					comment: "The blocker is closed, so I will proceed.",
				}),
		});

		expect(result.outcome).toBe("buildable");
		expect(result.shouldStartBuilder).toBe(true);
		expect(result.commentPosted).toBe(true);
		expect(posted).toHaveLength(1);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("runIntakeCurator records ask_human for short body", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItem = buildProjectItem({
		issueNumber: 214,
		issueTitle: "Nope",
		issueBody: "short",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#214";

	try {
		const posted: MockComment[] = [];
		const result = await runIntakeCurator(client, workItem, workItemId, {
			dependencies: {
				fetchBlockedBy: noNativeDependenciesFetcher,
			},
			comment: mockCommentCapture(posted),
			classify: async () =>
				buildClassifierResult({
					decision: "ask_human",
					summary: "The issue needs more detail.",
					question: "What should Rhapsody change?",
					comment:
						"Please provide a clear description, constraints, and expected outcome.",
					next_action: "add_context_and_acceptance_criteria",
				}),
		});

		expect(result.outcome).toBe("ask_human");
		expect(result.shouldStartBuilder).toBe(false);
		expect(result.nextAction).toBe("add_context_and_acceptance_criteria");
		expect(isIntakeBuildable(workItem)).toBe(false);
		expect(result.commentPosted).toBe(true);
		expect(posted).toHaveLength(1);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("runIntakeCurator posts comment for buildable items", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItem = buildProjectItem({
		issueNumber: 215,
		issueTitle: "Great title",
		issueBody:
			"This one is detailed enough for a buildable outcome with enough context.",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#215";
	const posted: MockComment[] = [];

	try {
		const result = await runIntakeCurator(client, workItem, workItemId, {
			dependencies: {
				fetchBlockedBy: noNativeDependenciesFetcher,
			},
			comment: mockCommentCapture(posted),
			classify: async () =>
				buildClassifierResult({
					decision: "buildable",
					summary: "Ready to build.",
					implementation_plan:
						"Implement the requested change with a focused patch.",
					comment: "I will implement this with a focused patch.",
					next_action: "start_builder",
				}),
		});

		expect(result.outcome).toBe("buildable");
		expect(result.shouldStartBuilder).toBe(true);
		expect(result.commentPosted).toBe(true);
		expect(posted).toHaveLength(1);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("runIntakeCurator heals once and then succeeds", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItem = buildProjectItem({
		issueNumber: 216,
		issueTitle: "Good title",
		issueBody:
			"This one is detailed enough for classification, with sufficient body length.",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#216";
	let attempts = 0;
	const runner: IntakeClassifierRunner = async () => {
		attempts += 1;
		if (attempts === 1) {
			return buildClassifierResult({
				decision: "ask_human",
				summary: "Needs details.",
				question: "", // fail business validation
				comment: "Needs details",
			});
		}

		return buildClassifierResult({
			decision: "buildable",
			summary: "Ready now.",
			implementation_plan: "Implement the requested change.",
			comment: "Implementation plan exists.",
			next_action: "build",
		});
	};

	try {
		const result = await runIntakeCurator(client, workItem, workItemId, {
			dependencies: {
				fetchBlockedBy: noNativeDependenciesFetcher,
			},
			classify: runner,
		});

		expect(attempts).toBe(2);
		expect(result.outcome).toBe("buildable");
		expect(result.classificationReason).toBe("Implement the requested change.");
	} finally {
		client.close();
		database.cleanup();
	}
});

test("primary+healing invalid runs fallback ask_human", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItem = buildProjectItem({
		issueNumber: 217,
		issueTitle: "Fallback title",
		issueBody:
			"This one is detailed enough for classification, with sufficient body length.",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#217";
	const posted: MockComment[] = [];
	const runner: IntakeClassifierRunner = async () =>
		buildClassifierResult({
			decision: "buildable",
			summary: "Invalid.",
			implementation_plan: "",
			comment: "",
		});

	try {
		const result = await runIntakeCurator(client, workItem, workItemId, {
			dependencies: {
				fetchBlockedBy: noNativeDependenciesFetcher,
			},
			classify: runner,
			comment: mockCommentCapture(posted),
		});

		expect(result.outcome).toBe("ask_human");
		expect(result.classificationReason).toBe(
			"Could you clarify the expected change and acceptance criteria before Rhapsody starts implementation?",
		);
		expect(result.commentPosted).toBe(true);
		expect(posted).toHaveLength(1);
	} finally {
		client.close();
		database.cleanup();
	}
});
