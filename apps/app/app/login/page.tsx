import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
	getAdminSessionConfigError,
	hasAdminSessionConfig,
	readAdminSessionTokenFromCookieStore,
	sanitizeAdminNextPath,
	verifyAdminSessionToken,
} from "@/lib/server/admin-session";
import { loginAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
	title: "Login",
	description: "Sign in to the Rhapsody dashboard.",
};

export default async function LoginPage({
	searchParams,
}: {
	searchParams?: Promise<{ next?: string; error?: string }>;
}) {
	const cookieStore = await cookies();
	const resolvedSearchParams = searchParams ? await searchParams : undefined;
	const nextPath = sanitizeAdminNextPath(resolvedSearchParams?.next ?? null);
	const error = resolvedSearchParams?.error;
	const sessionToken = readAdminSessionTokenFromCookieStore(cookieStore);
	const configError = getAdminSessionConfigError();

	if (sessionToken && hasAdminSessionConfig()) {
		if (await verifyAdminSessionToken(sessionToken)) {
			redirect(nextPath);
		}
	}

	return (
		<main className="min-h-screen bg-zinc-950 px-6 py-10 text-zinc-100">
			<div className="mx-auto flex min-h-screen max-w-lg items-center">
				<div className="w-full rounded-3xl border border-zinc-800 bg-zinc-900/70 p-8 shadow-2xl shadow-black/20">
					<p className="text-xs font-semibold uppercase tracking-widest text-zinc-400">
						Rhapsody
					</p>
					<h1 className="mt-4 text-3xl font-semibold tracking-tight text-white">
						Admin sign in
					</h1>
					<p className="mt-3 text-sm leading-6 text-zinc-300">
						Use the root password to open the dashboard and human-operated API
						surfaces.
					</p>

					{configError ? (
						<p className="mt-5 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
							{configError}
						</p>
					) : error ? (
						<p className="mt-5 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
							{error === "configuration"
								? "Admin auth is not configured."
								: "Incorrect password."}
						</p>
					) : null}

					<form action={loginAction} className="mt-6 space-y-4">
						<input type="hidden" name="next" value={nextPath} />
						<label className="block">
							<span className="mb-2 block text-sm font-medium text-zinc-200">
								Root password
							</span>
							<input
								autoComplete="current-password"
								className="w-full rounded-2xl border border-zinc-700 bg-black/30 px-4 py-3 text-sm text-white outline-none transition placeholder:text-zinc-500 focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/20"
								name="password"
								required
								type="password"
							/>
						</label>

						<button
							className="inline-flex w-full items-center justify-center rounded-2xl border border-cyan-400/40 bg-cyan-400/10 px-4 py-3 text-sm font-medium text-cyan-100 transition hover:bg-cyan-400/20"
							type="submit"
						>
							Sign in
						</button>
					</form>

					<p className="mt-5 text-xs leading-5 text-zinc-500">
						Invalid attempts are delayed and the login only accepts internal
						paths for the post-auth redirect.
					</p>
				</div>
			</div>
		</main>
	);
}
