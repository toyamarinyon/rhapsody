import { requireAdminAuth } from "@/lib/server/admin-auth";
import { createStateStoreClient, getRunDetail } from "@/lib/state";

export const runtime = "nodejs";

export async function GET(
	request: Request,
	context: { params: Promise<{ runId: string }> },
) {
	const auth = requireAdminAuth(request);

	if (!auth.ok) {
		return auth.response;
	}

	const { runId } = await context.params;
	const client = createStateStoreClient();

	try {
		const detail = await getRunDetail(client, runId);

		if (!detail) {
			return Response.json({ error: "Run not found." }, { status: 404 });
		}

		return Response.json(detail);
	} finally {
		client.close();
	}
}
