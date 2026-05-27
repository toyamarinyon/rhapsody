import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { loadRhapsodyConfig } from "@/lib/config";
import { createStateStoreClient } from "@/lib/state";
import { loadWorkItemDiagnosticsProjection } from "@/lib/server/dashboard";
import { parseEncodedWorkItemIdParam } from "@/lib/server/work-item-graph";

export const dynamic = "force-dynamic";

export async function generateMetadata({
	params,
}: {
	params: Promise<{ encodedWorkItemId: string }>;
}): Promise<Metadata> {
	const parsed = parseEncodedWorkItemIdParam((await params).encodedWorkItemId);

	return {
		title: parsed.ok ? `Work Item · ${parsed.value}` : "Work Item Diagnostics",
		description: "Work-item diagnostics and evidence.",
	};
}

export default async function WorkItemDiagnosticsPage({
	params,
}: {
	params: Promise<{ encodedWorkItemId: string }>;
}) {
	const { encodedWorkItemId } = await params;
	const parsed = parseEncodedWorkItemIdParam(encodedWorkItemId);

	if (!parsed.ok) {
		return <main className="p-8 text-sm text-red-300">{parsed.error}</main>;
	}

	const client = createStateStoreClient();
	const config = loadRhapsodyConfig();
	const githubBase = `https://github.com/${config.tracker.owner}/${config.tracker.repository}`;

	try {
		const projection = await loadWorkItemDiagnosticsProjection(
			client,
			parsed.value,
		);
		const issueUrl =
			projection.github.url ??
			(projection.github.issueNumber
				? `${githubBase}/issues/${projection.github.issueNumber}`
				: null);

		return (
			<main className="min-h-screen bg-zinc-950 text-zinc-100">
				<div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8 lg:px-8">
					<header className="rounded-3xl border border-zinc-800 bg-zinc-900/70 p-6">
						<p className="text-xs font-semibold uppercase tracking-widest text-zinc-400">
							Work item diagnostics
						</p>
						<div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
							<div>
								<h1 className="text-3xl font-semibold tracking-tight text-white">
									{projection.github.title ?? projection.workItemId}
								</h1>
								<p className="mt-2 text-sm text-zinc-300">
									What GitHub shows versus what Rhapsody knows, side by side.
								</p>
							</div>
							<div className="flex flex-wrap gap-3">
								{issueUrl ? (
									<a
										className="rounded-full border border-cyan-400/40 bg-cyan-400/10 px-4 py-2 text-sm text-cyan-200 hover:bg-cyan-400/20"
										href={issueUrl}
									>
										Open GitHub issue
									</a>
								) : null}
								<Link
									className="rounded-full border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-200 hover:border-zinc-500"
									href="/dashboard"
								>
									Back to dashboard
								</Link>
							</div>
						</div>
					</header>

					<section className="grid gap-6 lg:grid-cols-2">
						<div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-6">
							<h2 className="text-lg font-semibold text-white">
								What GitHub Shows
							</h2>
							<dl className="mt-4 grid gap-4 text-sm">
								<Field
									label="Title"
									value={projection.github.title ?? "unknown"}
								/>
								<Field label="URL" value={projection.github.url ?? "unknown"} />
								<Field
									label="Issue state"
									value={projection.github.issueState ?? "unknown"}
								/>
								<Field
									label="Project status"
									value={projection.github.projectStatus ?? "unknown"}
								/>
								<Field
									label="Issue number"
									value={projection.github.issueNumber ?? "unknown"}
								/>
								<Field
									label="Latest PR"
									value={projection.github.latestPrUrl ?? "none"}
								/>
								<Field
									label="Latest comment"
									value={projection.github.latestCommentUrl ?? "none"}
								/>
							</dl>
							<details className="mt-4 rounded-2xl border border-zinc-800 bg-black/20 p-4">
								<summary className="cursor-pointer text-sm font-medium text-zinc-200">
									Raw snapshot
								</summary>
								<pre className="mt-4 overflow-x-auto text-xs leading-5 text-zinc-300">
									{JSON.stringify(projection.github.snapshot, null, 2)}
								</pre>
							</details>
						</div>

						<div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-6">
							<h2 className="text-lg font-semibold text-white">
								What Rhapsody Knows
							</h2>
							<div className="mt-4 grid gap-4 text-sm">
								<Field
									label="Latest run"
									value={
										projection.rhapsody.latestRun
											? `${projection.rhapsody.latestRun.id} · ${projection.rhapsody.latestRun.status} · ${projection.rhapsody.latestRun.attemptCount} attempt(s)`
											: "none"
									}
								/>
								<Field
									label="Latest attempt"
									value={
										projection.rhapsody.latestAttempt
											? `${projection.rhapsody.latestAttempt.status}${projection.rhapsody.latestAttempt.command ? ` · ${projection.rhapsody.latestAttempt.command}` : ""}`
											: "none"
									}
								/>
								<Field
									label="Failure point"
									value={projection.rhapsody.latestRun?.failurePoint ?? "none"}
								/>
								<Field
									label="Last error"
									value={projection.rhapsody.latestRun?.lastError ?? "none"}
								/>
								<Field
									label="Next action"
									value={
										projection.rhapsody.latestDecision?.nextAction ?? "none"
									}
								/>
								<Field
									label="Active claim"
									value={
										projection.rhapsody.activeClaim
											? `${projection.rhapsody.activeClaim.claimedBy} until ${formatTimestamp(projection.rhapsody.activeClaim.expiresAt)}`
											: "none"
									}
								/>
								<Field
									label="Evidence counts"
									value={`${projection.rhapsody.summary.workerRuns} worker runs, ${projection.rhapsody.summary.decisions} decisions, ${projection.rhapsody.summary.artifacts} artifacts, ${projection.rhapsody.summary.links} links, ${projection.rhapsody.summary.sandboxSessions} sandbox sessions`}
								/>
							</div>
						</div>
					</section>

					<section className="grid gap-6 xl:grid-cols-2">
						<div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-6">
							<h2 className="text-lg font-semibold text-white">Run history</h2>
							<div className="mt-4 space-y-3">
								{projection.rhapsody.runs.length === 0 ? (
									<p className="text-sm text-zinc-400">No runs recorded.</p>
								) : (
									projection.rhapsody.runs.map((run) => (
										<Link
											key={run.id}
											className="block rounded-2xl border border-zinc-800 bg-black/20 p-4 text-sm hover:border-cyan-400/50"
											href={`/dashboard/runs/${encodeURIComponent(run.id)}`}
										>
											<div className="flex items-start justify-between gap-4">
												<div>
													<p className="font-medium text-white">{run.id}</p>
													<p className="mt-1 text-zinc-300">
														{run.status} · {run.runner} · {run.attemptCount}{" "}
														attempt(s)
													</p>
												</div>
												<span className="text-xs text-zinc-500">
													{formatTimestamp(run.updatedAt)}
												</span>
											</div>
											<p className="mt-2 text-xs text-zinc-400">
												{run.lastAttemptStatus ?? "no attempt"} ·{" "}
												{run.lastEventType ?? "no events"}
												{run.lastEventMessage
													? ` · ${run.lastEventMessage}`
													: ""}
											</p>
										</Link>
									))
								)}
							</div>
						</div>

						<div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-6">
							<h2 className="text-lg font-semibold text-white">
								Latest decision
							</h2>
							<div className="mt-4 grid gap-4 text-sm">
								<Field
									label="Decision id"
									value={projection.rhapsody.latestDecision?.id ?? "none"}
								/>
								<Field
									label="Phase"
									value={projection.rhapsody.latestDecision?.phase ?? "none"}
								/>
								<Field
									label="Outcome"
									value={projection.rhapsody.latestDecision?.outcome ?? "none"}
								/>
								<Field
									label="Next worker"
									value={
										projection.rhapsody.latestDecision?.nextWorkerKind ?? "none"
									}
								/>
							</div>
						</div>
					</section>

					<section className="grid gap-6 lg:grid-cols-2">
						<EvidencePanel
							title="Worker runs"
							data={projection.graph.workerRuns}
						/>
						<EvidencePanel
							title="Decisions"
							data={projection.graph.decisions}
						/>
						<EvidencePanel
							title="Artifacts"
							data={projection.graph.artifacts}
						/>
						<EvidencePanel title="Links" data={projection.graph.links} />
						<EvidencePanel
							title="Sandbox sessions"
							data={projection.graph.sandboxSessions}
						/>
					</section>
				</div>
			</main>
		);
	} finally {
		client.close();
	}
}

function Field({ label, value }: { label: string; value: ReactNode }) {
	return (
		<div className="rounded-2xl border border-zinc-800 bg-black/20 p-4">
			<dt className="text-xs uppercase tracking-widest text-zinc-500">
				{label}
			</dt>
			<dd className="mt-2 wrap-break-word text-zinc-200">{value}</dd>
		</div>
	);
}

function EvidencePanel({ title, data }: { title: string; data: unknown[] }) {
	return (
		<div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-6">
			<h3 className="text-base font-semibold text-white">{title}</h3>
			<p className="mt-1 text-sm text-zinc-400">{data.length} record(s)</p>
			<details className="mt-4 rounded-2xl border border-zinc-800 bg-black/20 p-4">
				<summary className="cursor-pointer text-sm font-medium text-zinc-200">
					View raw evidence
				</summary>
				<pre className="mt-4 overflow-x-auto text-xs leading-5 text-zinc-300">
					{JSON.stringify(data, null, 2)}
				</pre>
			</details>
		</div>
	);
}

function formatTimestamp(value: number) {
	return new Intl.DateTimeFormat("en-US", {
		dateStyle: "medium",
		timeStyle: "short",
		timeZone: "UTC",
	}).format(new Date(value));
}
