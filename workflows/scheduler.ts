import { createStateStoreClient } from "@/lib/state";
import { runSchedulerTick } from "@/lib/scheduler/tick";

export async function schedulerWorkflow() {
	"use workflow";

	return runSchedulerTickStep();
}

async function runSchedulerTickStep() {
	"use step";

	const client = createStateStoreClient();

	try {
		const result = await runSchedulerTick(client);
		return result;
	} finally {
		client.close();
	}
}
