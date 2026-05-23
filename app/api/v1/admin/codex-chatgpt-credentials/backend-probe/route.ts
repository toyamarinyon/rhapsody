import { loadMediatorCredentialState } from "@/lib/codex/credentials";
import { requireAdminAuth } from "@/lib/server/admin-auth";
import { safeBodyPreview, safeProbeUrl, serializeError } from "../_probe";

export const runtime = "nodejs";

const DEFAULT_BACKEND_PROBE_URL =
	"https://chatgpt.com/backend-api/codex/models?client_version=0.130.0";

export async function POST(request: Request) {
	const auth = requireAdminAuth(request);

	if (!auth.ok) {
		return auth.response;
	}

	const state = await loadMediatorCredentialState();
	if (!state?.accessToken || !state.accountId) {
		return Response.json(
			{
				ok: false,
				error: "Missing ChatGPT mediator credentials.",
			},
			{ status: 500 },
		);
	}

	const startedAt = Date.now();
	try {
		const upstream = await fetch(DEFAULT_BACKEND_PROBE_URL, {
			method: "GET",
			headers: {
				authorization: `Bearer ${state.accessToken}`,
				"ChatGPT-Account-ID": state.accountId,
			},
		});
		const body = await upstream.text();
		const durationMs = Date.now() - startedAt;

		return Response.json({
			ok: upstream.ok,
			upstream: {
				url: safeProbeUrl(DEFAULT_BACKEND_PROBE_URL),
				status: upstream.status,
				statusText: upstream.statusText,
				contentType: upstream.headers.get("content-type"),
				rhapsodyProxyHeader: upstream.headers.get("x-rhapsody-proxy"),
				bodyLength: body.length,
				bodyPreview: safeBodyPreview(body),
			},
			credential: {
				accountIdPresent: Boolean(state.accountId),
			},
			durationMs,
			checkedAt: new Date().toISOString(),
		});
	} catch (error) {
		return Response.json(
			{
				ok: false,
				error: "ChatGPT backend probe failed before receiving a response.",
				detail: serializeError(error),
				durationMs: Date.now() - startedAt,
				checkedAt: new Date().toISOString(),
			},
			{ status: 502 },
		);
	}
}
