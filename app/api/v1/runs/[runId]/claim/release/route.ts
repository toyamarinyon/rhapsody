import { requireAdminAuth } from "@/lib/server/admin-auth";
import { isRecord, readJson } from "@/lib/server/json";
import { createStateStoreClient, releaseClaimForRun } from "@/lib/state";

export const runtime = "nodejs";

type ClaimReleaseRequest = {
	claimToken: string;
};

export async function POST(
	request: Request,
	context: { params: Promise<{ runId: string }> },
) {
	const auth = await requireAdminAuth(request);

	if (!auth.ok) {
		return auth.response;
	}

	const body = await readJson(request);

	if (!body.ok) {
		return body.response;
	}

	const parsed = parseClaimReleaseRequest(body.value);

	if (!parsed.ok) {
		return Response.json({ error: parsed.error }, { status: 400 });
	}

	const { runId } = await context.params;
	const client = createStateStoreClient();

	try {
		const result = await releaseClaimForRun(client, {
			runId,
			claimToken: parsed.value.claimToken,
		});

		if (!result.released) {
			return Response.json(result, { status: 409 });
		}

		return Response.json(result);
	} finally {
		client.close();
	}
}

function parseClaimReleaseRequest(
	value: unknown,
): { ok: true; value: ClaimReleaseRequest } | { ok: false; error: string } {
	if (!isRecord(value)) {
		return { ok: false, error: "Request body must be a JSON object." };
	}

	if (typeof value.claimToken !== "string" || !value.claimToken.trim()) {
		return { ok: false, error: "claimToken must be a non-empty string." };
	}

	return { ok: true, value: { claimToken: value.claimToken } };
}
