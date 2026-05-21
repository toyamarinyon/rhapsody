export type AdminAuthResult = { ok: true } | { ok: false; response: Response };

export function requireAdminAuth(
	request: Request,
	env = process.env,
): AdminAuthResult {
	const rootPassword = env.ROOT_PASSWORD;

	if (!rootPassword?.trim()) {
		return {
			ok: false,
			response: Response.json(
				{ error: "Admin auth is not configured." },
				{ status: 500 },
			),
		};
	}

	const authorization = request.headers.get("authorization");
	const expected = `Bearer ${rootPassword}`;

	if (authorization !== expected) {
		return {
			ok: false,
			response: Response.json({ error: "Unauthorized." }, { status: 401 }),
		};
	}

	return { ok: true };
}
