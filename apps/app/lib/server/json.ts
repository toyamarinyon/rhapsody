export type JsonParseResult =
	| { ok: true; value: unknown }
	| { ok: false; response: Response };

export async function readJson(request: Request): Promise<JsonParseResult> {
	try {
		return { ok: true, value: await request.json() };
	} catch {
		return {
			ok: false,
			response: Response.json(
				{ error: "Request body must be valid JSON." },
				{ status: 400 },
			),
		};
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function optionalString(value: unknown): string | null | undefined {
	if (value === undefined) {
		return undefined;
	}

	if (value === null) {
		return null;
	}

	return typeof value === "string" ? value : undefined;
}
