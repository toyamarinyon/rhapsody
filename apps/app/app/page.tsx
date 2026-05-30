import Link from "next/link";

export default function Home() {
	return (
		<main className="min-h-screen bg-zinc-950 px-6 py-10 text-zinc-100">
			<div className="mx-auto flex max-w-3xl flex-col gap-6 rounded-3xl border border-zinc-800 bg-zinc-900/70 p-8">
				<p className="text-xs font-semibold uppercase tracking-widest text-zinc-400">
					Rhapsody
				</p>
				<h1 className="text-3xl font-semibold tracking-tight text-white">
					Diagnostics-first scheduler dashboard
				</h1>
				<p className="text-sm leading-6 text-zinc-300">
					Use the dashboard to inspect live claims, runs, attempts, decisions,
					artifacts, and sandbox evidence.
				</p>
				<Link
					className="inline-flex w-fit rounded-full border border-cyan-400/40 bg-cyan-400/10 px-4 py-2 text-sm text-cyan-200 hover:bg-cyan-400/20"
					href="/dashboard"
				>
					Open dashboard
				</Link>
			</div>
		</main>
	);
}
