import {
	readAdminSessionToken,
	verifyAdminSessionToken,
} from "@/lib/server/admin-session";

export type AdminAuthResult = { ok: true } | { ok: false; response: Response };
type AdminAuthEnvInput = Record<string, string | undefined>;

export async function requireAdminAuth(
	request: Request,
	env?: AdminAuthEnvInput,
): Promise<AdminAuthResult> {
	const resolvedEnv = env ?? (process.env as unknown as AdminAuthEnvInput);
	const rootPassword = resolvedEnv.ROOT_PASSWORD?.trim();
	const authorization = request.headers.get("authorization");

	if (rootPassword && authorization === `Bearer ${rootPassword}`) {
		return { ok: true };
	}

	if (resolvedEnv.AUTH_SECRET?.trim()) {
		const token = readAdminSessionToken(request);

		if (token) {
			const session = await verifyAdminSessionToken(token, resolvedEnv);

			if (session) {
				return { ok: true };
			}
		}
	}

	if (!rootPassword) {
		return {
			ok: false,
			response: Response.json(
				{ error: "Admin auth is not configured." },
				{ status: 500 },
			),
		};
	}

	return {
		ok: false,
		response: Response.json({ error: "Unauthorized." }, { status: 401 }),
	};
}

export function hasAdminAuthConfig(env?: AdminAuthEnvInput) {
	const resolvedEnv = env ?? (process.env as unknown as AdminAuthEnvInput);

	return Boolean(resolvedEnv.ROOT_PASSWORD?.trim());
}
