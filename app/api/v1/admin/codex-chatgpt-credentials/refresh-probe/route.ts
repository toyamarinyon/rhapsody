import { requestChatGptOAuthRefresh } from "@/lib/codex/chatgpt-oauth";
import {
	loadMediatorCredentialState,
	updateMediatorCredentialsFromOAuthResponse,
} from "@/lib/codex/credentials";
import { requireAdminAuth } from "@/lib/server/admin-auth";
import { safeBodyPreview, safeTokenPresence, serializeError } from "../_probe";

export const runtime = "nodejs";

export async function POST(request: Request) {
	const auth = await requireAdminAuth(request);

	if (!auth.ok) {
		return auth.response;
	}

	const { persist } = await parseBody(request);
	const state = await loadMediatorCredentialState();

	if (!state?.refreshToken) {
		return Response.json(
			{
				ok: false,
				error: "Missing ChatGPT refresh credentials.",
			},
			{ status: 500 },
		);
	}

	const startedAt = Date.now();
	const checkedAt = new Date().toISOString();

	try {
		const upstreamResult = await requestChatGptOAuthRefresh(state.refreshToken);
		const returned = safeTokenPresence(upstreamResult.parsedBody ?? {});
		let persisted = false;

		if (persist && upstreamResult.ok && upstreamResult.parsedBody) {
			await updateMediatorCredentialsFromOAuthResponse(
				state,
				upstreamResult.parsedBody,
			);
			persisted = true;
		}

		const durationMs = Date.now() - startedAt;
		const upstream = {
			status: upstreamResult.status,
			statusText: upstreamResult.statusText,
			contentType: upstreamResult.contentType,
			bodyPreview: safeBodyPreview(upstreamResult.bodyText),
			durationMs,
		};

		return Response.json(
			{
				ok: upstreamResult.ok,
				upstream,
				returned,
				persisted,
				checkedAt,
			},
			{ status: upstreamResult.ok ? 200 : upstream.status },
		);
	} catch (error) {
		return Response.json(
			{
				ok: false,
				error:
					"ChatGPT auth token refresh probe failed before receiving a response.",
				detail: serializeError(error),
				durationMs: Date.now() - startedAt,
				checkedAt: new Date().toISOString(),
			},
			{ status: 502 },
		);
	}
}

type RefreshProbePayload = {
	persist?: boolean;
};

async function parseBody(request: Request): Promise<RefreshProbePayload> {
	const raw = await request.text();

	if (!raw.trim()) {
		return {};
	}

	try {
		const value = JSON.parse(raw) as RefreshProbePayload;

		if (value && typeof value === "object" && "persist" in value) {
			return {
				persist: value.persist === true,
			};
		}
	} catch {
		// Invalid JSON is treated as dry-run to avoid false positives.
	}

	return {};
}
