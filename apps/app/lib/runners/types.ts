import type { Client } from "@libsql/client";

import type { RhapsodyRunner } from "@/lib/config";
import type { RunDetail, StateStoreAttempt } from "@/lib/state";

export type RunnerRouteContext = {
	request: Request;
	runId: string;
	attemptId: string;
	detail: RunDetail;
	attempt: StateStoreAttempt;
	client: Client;
};

export type Runner = (context: RunnerRouteContext) => Promise<Response>;

export type RunnerKey = RhapsodyRunner;
