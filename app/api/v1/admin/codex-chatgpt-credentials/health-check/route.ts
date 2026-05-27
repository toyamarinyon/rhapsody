import { loadRhapsodyCronEnv } from "@/lib/config";
import * as refreshHealth from "@/lib/codex/refresh-health";
import { requireAdminAuth } from "@/lib/server/admin-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
	return handleHealthCheck(request);
}

export async function POST(request: Request) {
	return handleHealthCheck(request);
}

async function handleHealthCheck(request: Request) {
	const auth = await requireCronOrAdminAuth(request);

	if (!auth.ok) {
		return auth.response;
	}

	const result = await refreshHealth.runChatGptRefreshHealthCheck();

	return Response.json(result, {
		status: result.ok ? 200 : 503,
	});
}

async function requireCronOrAdminAuth(request: Request) {
	const cronSecret = loadRhapsodyCronEnv().CRON_SECRET;
	const authorization = request.headers.get("authorization");

	if (cronSecret?.trim() && authorization === `Bearer ${cronSecret}`) {
		return { ok: true } as const;
	}

	return requireAdminAuth(request);
}
