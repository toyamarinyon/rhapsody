import { requireAdminAuth } from "@/lib/server/admin-auth";
import { loadWorkItemGraphForRouteParam } from "@/lib/server/work-item-graph";
import { createStateStoreClient } from "@/lib/state";

export const runtime = "nodejs";

export async function GET(
	request: Request,
	context: { params: Promise<{ encodedWorkItemId: string }> },
) {
	const auth = requireAdminAuth(request);

	if (!auth.ok) {
		return auth.response;
	}

	const { encodedWorkItemId } = await context.params;
	const client = createStateStoreClient();

	try {
		const result = await loadWorkItemGraphForRouteParam(
			client,
			encodedWorkItemId,
		);

		if (!result.ok) {
			return Response.json({ error: result.error }, { status: 400 });
		}

		return Response.json(result.graph);
	} finally {
		client.close();
	}
}
