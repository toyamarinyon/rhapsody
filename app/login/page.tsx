import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
	getAdminSessionConfigError,
	hasAdminSessionConfig,
	readAdminSessionTokenFromCookieStore,
	sanitizeAdminNextPath,
	verifyAdminSessionToken,
} from "@/lib/server/admin-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
	title: "Login",
	description: "Sign in to the Rhapsody dashboard.",
};

export default async function LoginPage({
	searchParams,
}: {
	searchParams: Promise<{ next?: string; error?: string }>;
}) {
	const params = await searchParams;
	const nextPath = sanitizeAdminNextPath(params.next ?? null);
	const configurationError = getAdminSessionConfigError();
	const error = params.error === "invalid" ? "Invalid password." : null;

	if (hasAdminSessionConfig()) {
		const cookieStore = await cookies();
		const token = readAdminSessionTokenFromCookieStore(cookieStore);

		if (token && (await verifyAdminSessionToken(token))) {
			redirect(nextPath);
		}
	}

	return (
		<main className="min-h-screen bg-zinc-950 text-zinc-100">
			<div className="mx-auto flex min-h-screen w-full max-w-lg items-center px-6 py-12">
				<section className="w-full rounded-3xl border border-zinc-800 bg-zinc-900/80 p-8 shadow-2xl shadow-black/30">
					<p className="text-xs font-semibold uppercase tracking-widest text-zinc-400">
						Rhapsody access
					</p>
					<h1 className="mt-4 text-3xl font-semibold tracking-tight text-white">
						Enter the root password.
					</h1>
					<p className="mt-3 text-sm leading-6 text-zinc-300">
						This login sets a signed session cookie for the dashboard. Admin API
						routes still accept `Authorization: Bearer &lt;ROOT_PASSWORD&gt;`.
					</p>
					{configurationError ? (
						<p className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
							{configurationError}
						</p>
					) : null}
					{error ? (
						<p className="mt-4 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
							{error}
						</p>
					) : null}
					{configurationError ? (
						<div className="mt-6">
							<Link className="text-sm text-zinc-300 hover:text-white" href="/">
								Back home
							</Link>
						</div>
					) : (
						<form className="mt-6 space-y-4" action="/login" method="POST">
							<input type="hidden" name="next" value={nextPath} />
							<label className="block">
								<span className="mb-2 block text-sm font-medium text-zinc-200">
									Password
								</span>
								<input
									autoComplete="current-password"
									className="w-full rounded-2xl border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm text-white outline-none ring-0 placeholder:text-zinc-500 focus:border-cyan-400/60"
									name="password"
									type="password"
									required
								/>
							</label>
							<div className="flex items-center justify-between gap-3">
								<Link
									className="text-sm text-zinc-400 hover:text-zinc-200"
									href="/"
								>
									Back home
								</Link>
								<button
									className="rounded-full border border-cyan-400/40 bg-cyan-400/10 px-5 py-2 text-sm font-medium text-cyan-100 hover:bg-cyan-400/20"
									type="submit"
								>
									Sign in
								</button>
							</div>
						</form>
					)}
				</section>
			</div>
		</main>
	);
}
