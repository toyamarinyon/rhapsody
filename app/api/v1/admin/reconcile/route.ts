import { loadRhapsodyCronEnv } from "@/lib/config";
import { runReconcilerTick } from "@/lib/reconciler/tick";
import { requireAdminAuth } from "@/lib/server/admin-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
	return handleReconcile(request);
}

export async function GET(request: Request) {
	return handleReconcile(request);
}

async function handleReconcile(request: Request) {
	const auth = requireCronOrAdminAuth(request);

	if (!auth.ok) {
		return auth.response;
	}

	const url = new URL(request.url);
	const maxRunningAttemptAgeMs = parsePositiveIntegerParam(
		url,
		"maxRunningAttemptAgeMs",
	);
	const limit = parsePositiveIntegerParam(url, "limit");

	if (!maxRunningAttemptAgeMs.ok) {
		return Response.json(
			{ error: maxRunningAttemptAgeMs.error },
			{ status: 400 },
		);
	}

	if (!limit.ok) {
		return Response.json({ error: limit.error }, { status: 400 });
	}

	const result = await runReconcilerTick({
		maxRunningAttemptAgeMs: maxRunningAttemptAgeMs.value,
		limit: limit.value,
	});

	return Response.json(result);
}

function requireCronOrAdminAuth(request: Request) {
	const cronSecret = loadRhapsodyCronEnv().CRON_SECRET;
	const authorization = request.headers.get("authorization");

	if (cronSecret?.trim() && authorization === `Bearer ${cronSecret}`) {
		return { ok: true } as const;
	}

	return requireAdminAuth(request);
}

function parsePositiveIntegerParam(requestUrl: URL, name: string) {
	const raw = requestUrl.searchParams.get(name);

	if (raw === null) {
		return { ok: true as const, value: undefined };
	}

	const parsed = Number(raw);

	if (!Number.isInteger(parsed) || parsed <= 0) {
		return { ok: false as const, error: `${name} must be a positive integer.` };
	}

	return { ok: true as const, value: parsed };
}
