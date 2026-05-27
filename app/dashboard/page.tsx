import type { Metadata } from "next";
import Link from "next/link";

import { loadRhapsodyConfig } from "@/lib/config";
import { createStateStoreClient } from "@/lib/state";
import { loadDashboardProjection } from "@/lib/server/dashboard";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
	title: "Dashboard",
	description: "Diagnostics-first overview of operational state.",
};

export default async function DashboardPage() {
	const client = createStateStoreClient();
	const config = loadRhapsodyConfig();

	try {
		const dashboard = await loadDashboardProjection(client);
		const githubBase = `https://github.com/${config.tracker.owner}/${config.tracker.repository}`;

		return (
			<main className="min-h-screen bg-zinc-950 text-zinc-100">
				<div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-6 py-8 lg:px-8">
					<header className="rounded-3xl border border-zinc-800 bg-zinc-900/70 p-6 shadow-2xl shadow-black/20">
						<p className="text-xs font-semibold uppercase tracking-widest text-zinc-400">
							Rhapsody diagnostics
						</p>
						<div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
							<div>
								<h1 className="text-3xl font-semibold tracking-tight text-white">
									Needs attention first, then recent activity.
								</h1>
								<p className="mt-3 max-w-3xl text-sm leading-6 text-zinc-300">
									GitHub remains the source of truth for issue state. Rhapsody
									extends it with claims, runs, attempts, decisions, artifacts,
									and sandbox evidence so operators can diagnose the last known
									state quickly.
								</p>
							</div>
							<a
								className="inline-flex items-center justify-center rounded-full border border-cyan-400/40 bg-cyan-400/10 px-4 py-2 text-sm font-medium text-cyan-200 transition hover:bg-cyan-400/20"
								href={githubBase}
							>
								Open GitHub repository
							</a>
						</div>
					</header>

					<section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
						<MetricCard
							label="Runs"
							value={dashboard.stateSummary.runStatusCounts}
						/>
						<MetricCard
							label="Attempts"
							value={dashboard.stateSummary.attemptStatusCounts}
						/>
						<MetricCard
							label="Active claims"
							value={String(dashboard.stateSummary.activeClaimCount)}
						/>
						<MetricCard
							label="Recent events"
							value={String(dashboard.stateSummary.recentEvents.length)}
						/>
					</section>

					<section className="grid gap-6 xl:grid-cols-2">
						<div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-6">
							<div className="flex items-center justify-between gap-4">
								<h2 className="text-lg font-semibold text-white">
									Needs attention
								</h2>
								<span className="text-sm text-zinc-400">
									High-signal live runs
								</span>
							</div>
							<div className="mt-5 space-y-4">
								{dashboard.attentionItems.length === 0 ? (
									<p className="text-sm text-zinc-400">
										No failed runs, stale claims, or warning-level items need
										operator attention right now.
									</p>
								) : (
									dashboard.attentionItems.map((item) => (
										<RunListItem
											key={item.runId}
											href={`/dashboard/runs/${encodeURIComponent(item.runId)}`}
											label={item.workItemTitle}
											subtitle={`${item.status} · ${item.runner} · ${item.attemptCount} attempt(s)`}
											meta={
												item.claimIsActive
													? `${item.attentionReason} · claim expires ${formatTimestamp(item.claimExpiresAt)}`
													: `${item.attentionReason}${item.lastEventMessage ? ` · ${item.lastEventMessage}` : ""}`
											}
										/>
									))
								)}
							</div>
						</div>

						<div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-6">
							<div className="flex items-center justify-between gap-4">
								<h2 className="text-lg font-semibold text-white">
									Operational activity
								</h2>
								<Link
									className="text-sm text-cyan-300 hover:text-cyan-200"
									href="/dashboard"
								>
									Refresh view
								</Link>
							</div>
							<div className="mt-5 space-y-4">
								{dashboard.recentActivity.map((item) => (
									<RunListItem
										key={item.runId}
										href={`/dashboard/runs/${encodeURIComponent(item.runId)}`}
										label={item.workItemTitle}
										subtitle={`${item.status} · ${item.runner} · ${item.attemptCount} attempt(s)`}
										meta={
											item.lastEventType
												? `${item.lastEventType}${item.lastEventMessage ? ` · ${item.lastEventMessage}` : ""}`
												: `Updated ${formatTimestamp(item.updatedAt)}`
										}
									/>
								))}
							</div>
						</div>
					</section>

					<section className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-6">
						<div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
							<div>
								<h2 className="text-lg font-semibold text-white">
									Recent evidence
								</h2>
								<p className="mt-1 text-sm text-zinc-400">
									Recent events are kept collapsed so the summary stays
									readable.
								</p>
							</div>
						</div>
						<details className="mt-4 rounded-2xl border border-zinc-800 bg-black/20 p-4">
							<summary className="cursor-pointer text-sm font-medium text-zinc-200">
								View raw recent events
							</summary>
							<pre className="mt-4 overflow-x-auto text-xs leading-5 text-zinc-300">
								{JSON.stringify(dashboard.stateSummary.recentEvents, null, 2)}
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

function MetricCard({
	label,
	value,
}: {
	label: string;
	value: string | Record<string, number>;
}) {
	return (
		<div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-5">
			<p className="text-sm text-zinc-400">{label}</p>
			{typeof value === "string" ? (
				<p className="mt-3 text-2xl font-semibold text-white">{value}</p>
			) : (
				<div className="mt-3 space-y-1 text-sm text-zinc-200">
					{Object.entries(value).map(([key, count]) => (
						<div key={key} className="flex items-center justify-between gap-4">
							<span>{key}</span>
							<span className="tabular-nums text-zinc-400">{count}</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function RunListItem({
	href,
	label,
	subtitle,
	meta,
}: {
	href: string;
	label: string;
	subtitle: string;
	meta: string;
}) {
	return (
		<Link
			className="block rounded-2xl border border-zinc-800 bg-black/20 p-4 transition hover:border-cyan-400/50 hover:bg-cyan-400/5"
			href={href}
		>
			<div className="flex flex-col gap-2">
				<div className="flex items-start justify-between gap-4">
					<p className="font-medium text-white">{label}</p>
					<span className="shrink-0 text-xs text-zinc-500">Open</span>
				</div>
				<p className="text-sm text-zinc-300">{subtitle}</p>
				<p className="text-xs text-zinc-400">{meta}</p>
			</div>
		</Link>
	);
}

function formatTimestamp(value: number | null | undefined) {
	if (value === null || value === undefined) {
		return "unknown";
	}

	return new Intl.DateTimeFormat("en-US", {
		dateStyle: "medium",
		timeStyle: "short",
		timeZone: "UTC",
	}).format(new Date(value));
}
