import { createClient, type Client } from "@libsql/client";

import { loadRhapsodyServerEnv, type RhapsodyServerEnv } from "../config";

export function createStateStoreClient(
	env: RhapsodyServerEnv = loadRhapsodyServerEnv(),
): Client {
	return createClient({
		url: env.TURSO_DATABASE_URL,
		authToken: env.TURSO_AUTH_TOKEN,
	});
}
