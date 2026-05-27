import { requireAdminAuth } from "@/lib/server/admin-auth";
import { createStateStoreClient, getStateSummary } from "@/lib/state";

export const runtime = "nodejs";

export async function GET(request: Request) {
	const auth = await requireAdminAuth(request);

	if (!auth.ok) {
		return auth.response;
	}

	const client = createStateStoreClient();

	try {
		const summary = await getStateSummary(client);
		return Response.json(summary);
	} finally {
		client.close();
	}
}
