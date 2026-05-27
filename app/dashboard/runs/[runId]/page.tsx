import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";

import { loadRhapsodyConfig } from "@/lib/config";
import { createStateStoreClient } from "@/lib/state";
import { requireAdminDashboardSession } from "@/lib/server/admin-session";
import { loadRunDiagnosticsProjection } from "@/lib/server/dashboard";

export const dynamic = "force-dynamic";

export async function generateMetadata({
	params,
}: {
	params: Promise<{ runId: string }>;
}): Promise<Metadata> {
	const { runId } = await params;
	return {
		title: `Run · ${runId}`,
		description: "Run diagnostics and raw evidence.",
	};
}

export default async function RunDiagnosticsPage({
	params,
}: {
	params: Promise<{ runId: string }>;
}) {
	const { runId } = await params;

	await requireAdminDashboardSession({
		nextPath: `/dashboard/runs/${encodeURIComponent(runId)}`,
		cookieStore: cookies(),
	});

	const client = createStateStoreClient();
	const config = loadRhapsodyConfig();
	const githubBase = `https://github.com/${config.tracker.owner}/${config.tracker.repository}`;

	try {
		const projection = await loadRunDiagnosticsProjection(client, runId);

		if (!projection) {
			return (
				<main className="p-8 text-sm text-zinc-300">
					Run not found.
					<div className="mt-4">
						<Link
							className="text-cyan-300 hover:text-cyan-200"
							href="/dashboard"
						>
							Back to dashboard
						</Link>
					</div>
				</main>
			);
		}

		const githubUrl =
			projection.workItem.url ??
			(projection.workItem.issueNumber
				? `${githubBase}/issues/${projection.workItem.issueNumber}`
				: null);

		return (
			<main className="min-h-screen bg-zinc-950 text-zinc-100">
				<div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8 lg:px-8">
					<header className="rounded-3xl border border-zinc-800 bg-zinc-900/70 p-6">
						<p className="text-xs font-semibold uppercase tracking-widest text-zinc-400">
							Run diagnostics
						</p>
						<div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
							<div>
								<h1 className="text-3xl font-semibold tracking-tight text-white">
									{projection.detail.run.id}
								</h1>
								<p className="mt-2 text-sm text-zinc-300">
									{projection.workItem.title}
								</p>
							</div>
							<div className="flex flex-wrap gap-3">
								{githubUrl ? (
									<a
										className="rounded-full border border-cyan-400/40 bg-cyan-400/10 px-4 py-2 text-sm text-cyan-200 hover:bg-cyan-400/20"
										href={githubUrl}
									>
										Open GitHub issue
									</a>
								) : null}
								<Link
									className="rounded-full border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-200 hover:border-zinc-500"
									href={`/dashboard/work-items/${encodeURIComponent(projection.detail.run.workItemId)}`}
								>
									Work-item diagnostics
								</Link>
							</div>
						</div>
					</header>

					<section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
						<Card label="Status" value={projection.detail.run.status} />
						<Card label="Runner" value={projection.detail.run.runner} />
						<Card
							label="Attempts"
							value={String(projection.summary.attemptCount)}
						/>
						<Card
							label="Events"
							value={String(projection.summary.eventCount)}
						/>
					</section>

					<section className="grid gap-6 lg:grid-cols-2">
						<div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-6">
							<h2 className="text-lg font-semibold text-white">Run summary</h2>
							<div className="mt-4 grid gap-4 text-sm">
								<Field label="Work item" value={projection.workItem.id} />
								<Field label="Title" value={projection.workItem.title} />
								<Field
									label="Failure point"
									value={projection.summary.failurePoint ?? "none"}
								/>
								<Field
									label="Last meaningful error"
									value={projection.summary.lastMeaningfulError ?? "none"}
								/>
								<Field
									label="PR / branch evidence"
									value={projection.summary.branchEvidence ?? "none"}
								/>
								<Field
									label="Sandbox sessions"
									value={String(projection.summary.sandboxSessionCount)}
								/>
							</div>
						</div>

						<div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-6">
							<h2 className="text-lg font-semibold text-white">
								Work item evidence
							</h2>
							<div className="mt-4 grid gap-4 text-sm">
								<Field
									label="GitHub status"
									value={projection.workItem.status ?? "unknown"}
								/>
								<Field
									label="Issue state"
									value={projection.workItem.issueState ?? "unknown"}
								/>
								<Field
									label="Project status"
									value={projection.workItem.projectStatus ?? "unknown"}
								/>
								<Field
									label="Last event"
									value={
										projection.summary.lastEventType
											? `${projection.summary.lastEventType}${projection.summary.lastEventMessage ? ` · ${projection.summary.lastEventMessage}` : ""}`
											: "none"
									}
								/>
							</div>
						</div>
					</section>

					<section className="grid gap-6 xl:grid-cols-2">
						<div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-6">
							<h2 className="text-lg font-semibold text-white">Attempts</h2>
							<div className="mt-4 overflow-x-auto">
								<table className="w-full border-separate border-spacing-0 text-sm">
									<thead className="text-left text-zinc-400">
										<tr>
											<th className="border-b border-zinc-800 px-3 py-2">#</th>
											<th className="border-b border-zinc-800 px-3 py-2">
												Status
											</th>
											<th className="border-b border-zinc-800 px-3 py-2">
												Sandbox
											</th>
											<th className="border-b border-zinc-800 px-3 py-2">
												Exit
											</th>
											<th className="border-b border-zinc-800 px-3 py-2">
												Command
											</th>
										</tr>
									</thead>
									<tbody>
										{projection.attempts.map((attempt) => (
											<tr key={attempt.id} className="align-top text-zinc-200">
												<td className="border-b border-zinc-800 px-3 py-2 tabular-nums">
													{attempt.attemptNumber}
												</td>
												<td className="border-b border-zinc-800 px-3 py-2">
													{attempt.status}
												</td>
												<td className="border-b border-zinc-800 px-3 py-2">
													{attempt.sandboxId ?? "none"}
												</td>
												<td className="border-b border-zinc-800 px-3 py-2 tabular-nums">
													{attempt.exitCode ?? "—"}
												</td>
												<td className="border-b border-zinc-800 px-3 py-2 wrap-break-word">
													{attempt.command ?? "none"}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</div>

						<div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-6">
							<h2 className="text-lg font-semibold text-white">Timeline</h2>
							<div className="mt-4 space-y-3">
								{projection.timeline.map((event) => (
									<div
										key={`${event.createdAt}-${event.type}`}
										className="rounded-2xl border border-zinc-800 bg-black/20 p-4"
									>
										<div className="flex items-start justify-between gap-4">
											<div>
												<p className="text-sm font-medium text-white">
													{event.type}
												</p>
												<p className="mt-1 text-xs text-zinc-400">
													{event.level}
												</p>
											</div>
											<span className="text-xs text-zinc-500">
												{formatTimestamp(event.createdAt)}
											</span>
										</div>
										{event.message ? (
											<p className="mt-2 text-sm text-zinc-300">
												{event.message}
											</p>
										) : null}
									</div>
								))}
							</div>
						</div>
					</section>

					<section className="grid gap-6 lg:grid-cols-2">
						<div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-6">
							<h2 className="text-lg font-semibold text-white">
								Sandbox sessions
							</h2>
							<p className="mt-1 text-sm text-zinc-400">
								{projection.summary.sandboxSessionCount} session(s)
							</p>
							<details className="mt-4 rounded-2xl border border-zinc-800 bg-black/20 p-4">
								<summary className="cursor-pointer text-sm font-medium text-zinc-200">
									View sandbox session JSON
								</summary>
								<pre className="mt-4 overflow-x-auto text-xs leading-5 text-zinc-300">
									{JSON.stringify(projection.detail.sandboxSessions, null, 2)}
								</pre>
							</details>
						</div>

						<div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-6">
							<h2 className="text-lg font-semibold text-white">
								PR and branch evidence
							</h2>
							<div className="mt-4 space-y-3">
								{projection.artifacts.filter(
									(artifact) =>
										artifact.kind === "pull_request" ||
										artifact.kind === "branch",
								).length === 0 ? (
									<p className="text-sm text-zinc-400">
										No PR or branch artifact persisted.
									</p>
								) : (
									projection.artifacts
										.filter(
											(artifact) =>
												artifact.kind === "pull_request" ||
												artifact.kind === "branch",
										)
										.map((artifact) => (
											<div
												key={`${artifact.kind}-${artifact.externalUrl ?? artifact.externalId ?? artifact.createdAt}`}
												className="rounded-2xl border border-zinc-800 bg-black/20 p-4 text-sm text-zinc-200"
											>
												<p className="font-medium text-white">
													{artifact.kind}
												</p>
												<p className="mt-1 wrap-break-word text-zinc-300">
													{artifact.externalUrl ??
														artifact.externalId ??
														"unlinked"}
												</p>
											</div>
										))
								)}
							</div>
						</div>
					</section>

					<section className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-6">
						<h2 className="text-lg font-semibold text-white">
							Persisted evidence
						</h2>
						<details className="mt-4 rounded-2xl border border-zinc-800 bg-black/20 p-4">
							<summary className="cursor-pointer text-sm font-medium text-zinc-200">
								View run detail JSON
							</summary>
							<pre className="mt-4 overflow-x-auto text-xs leading-5 text-zinc-300">
								{JSON.stringify(projection.detail, null, 2)}
							</pre>
						</details>
					</section>
				</div>
			</main>
		);
	} finally {
		client.close();
	}
}

function Card({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-5">
			<p className="text-sm text-zinc-400">{label}</p>
			<p className="mt-3 text-2xl font-semibold text-white">{value}</p>
		</div>
	);
}

function Field({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-2xl border border-zinc-800 bg-black/20 p-4">
			<p className="text-xs uppercase tracking-widest text-zinc-500">{label}</p>
			<p className="mt-2 wrap-break-word text-zinc-200">{value}</p>
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
