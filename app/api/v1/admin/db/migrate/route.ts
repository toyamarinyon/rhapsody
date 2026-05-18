import { requireAdminAuth } from "@/lib/server/admin-auth";
import { createStateStoreClient, migrateStateStore } from "@/lib/state";

export const runtime = "nodejs";

export async function POST(request: Request) {
	const auth = requireAdminAuth(request);

	if (!auth.ok) {
		return auth.response;
	}

	const client = createStateStoreClient();

	try {
		const applied = await migrateStateStore(client);
		return Response.json({ applied });
	} finally {
		client.close();
	}
}
