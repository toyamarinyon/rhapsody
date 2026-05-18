import { loadRhapsodyConfig } from "@/lib/config";
import { requireAdminAuth } from "@/lib/server/admin-auth";
import { isRecord, optionalString, readJson } from "@/lib/server/json";
import { createClaimedManualRun, createStateStoreClient } from "@/lib/state";

export const runtime = "nodejs";

type ManualRunRequest = {
	workItemId: string;
	workItemTitle: string;
	workItemUrl?: string | null;
	workItemStatus?: string | null;
	workItemSnapshot?: unknown;
	claimedBy?: string;
};

export async function POST(request: Request) {
	const auth = requireAdminAuth(request);

	if (!auth.ok) {
		return auth.response;
	}

	const body = await readJson(request);

	if (!body.ok) {
		return body.response;
	}

	const parsed = parseManualRunRequest(body.value);

	if (!parsed.ok) {
		return Response.json({ error: parsed.error }, { status: 400 });
	}

	const config = loadRhapsodyConfig();
	const client = createStateStoreClient();

	try {
		const result = await createClaimedManualRun(client, {
			...parsed.value,
			claimedBy: parsed.value.claimedBy ?? "manual",
			claimTtlMs: config.scheduler.claimTtlMs,
		});

		if (!result.acquired) {
			return Response.json({ acquired: false, existingRunId: result.existingRunId }, { status: 409 });
		}

		return Response.json(result, { status: 201 });
	} finally {
		client.close();
	}
}

function parseManualRunRequest(value: unknown): { ok: true; value: ManualRunRequest } | { ok: false; error: string } {
	if (!isRecord(value)) {
		return { ok: false, error: "Request body must be a JSON object." };
	}

	if (typeof value.workItemId !== "string" || !value.workItemId.trim()) {
		return { ok: false, error: "workItemId must be a non-empty string." };
	}

	if (typeof value.workItemTitle !== "string" || !value.workItemTitle.trim()) {
		return { ok: false, error: "workItemTitle must be a non-empty string." };
	}

	const workItemUrl = optionalString(value.workItemUrl);

	if (workItemUrl === undefined && "workItemUrl" in value) {
		return { ok: false, error: "workItemUrl must be a string or null when provided." };
	}

	const workItemStatus = optionalString(value.workItemStatus);

	if (workItemStatus === undefined && "workItemStatus" in value) {
		return { ok: false, error: "workItemStatus must be a string or null when provided." };
	}

	const claimedBy = optionalString(value.claimedBy);

	if (claimedBy === null || (claimedBy === undefined && "claimedBy" in value)) {
		return { ok: false, error: "claimedBy must be a string when provided." };
	}

	if (claimedBy !== undefined && !claimedBy.trim()) {
		return { ok: false, error: "claimedBy must be a non-empty string when provided." };
	}

	return {
		ok: true,
		value: {
			workItemId: value.workItemId,
			workItemTitle: value.workItemTitle,
			workItemUrl,
			workItemStatus,
			workItemSnapshot: value.workItemSnapshot,
			claimedBy,
		},
	};
}
