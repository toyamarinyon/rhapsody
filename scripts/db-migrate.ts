import { loadEnvConfig } from "@next/env";

import { createStateStoreClient, migrateStateStore } from "@/lib/state";

loadEnvConfig(process.cwd());

async function main() {
	const client = createStateStoreClient();

	try {
		const applied = await migrateStateStore(client);

		if (applied.length === 0) {
			console.log("State store migrations: none applied.");
			return;
		}

		console.log(
			`State store migrations applied: ${applied.length} (${applied.map((migration) => migration.id).join(", ")})`,
		);
	} finally {
		client.close();
	}
}

main().catch((error: unknown) => {
	const message =
		error instanceof Error ? error.message : "Unknown migration failure";
	console.error(`State store migration failed: ${message}`);
	process.exitCode = 1;
});
