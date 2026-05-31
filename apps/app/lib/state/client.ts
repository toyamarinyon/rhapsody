import { createClient, type Client } from "@libsql/client";

import {
	loadRhapsodyStateStoreEnv,
	type RhapsodyStateStoreEnv,
} from "../config";

export function createStateStoreClient(
	env: RhapsodyStateStoreEnv = loadRhapsodyStateStoreEnv(),
): Client {
	return createClient({
		url: env.TURSO_DATABASE_URL,
		authToken: env.TURSO_AUTH_TOKEN,
	});
}
