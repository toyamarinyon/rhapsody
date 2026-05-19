import { requireAdminAuth } from "@/lib/server/admin-auth";
import { runAttempt } from "@/lib/runners/registry";

export const runtime = "nodejs";

export async function POST(
	request: Request,
	context: { params: Promise<{ runId: string; attemptId: string }> },
) {
	const auth = requireAdminAuth(request);

	if (!auth.ok) {
		return auth.response;
	}

	const { runId, attemptId } = await context.params;
	return runAttempt(request, runId, attemptId);
}
