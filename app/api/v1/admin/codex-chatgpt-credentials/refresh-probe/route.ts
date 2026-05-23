import {
	loadMediatorCredentialState,
	updateMediatorCredentialsFromOAuthResponse,
} from "@/lib/codex/credentials";
import { requireAdminAuth } from "@/lib/server/admin-auth";
import { safeBodyPreview, safeTokenPresence, serializeError } from "../_probe";

export const runtime = "nodejs";

// Default is dry-run to avoid rotating production credentials unless explicitly requested.
const CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export async function POST(request: Request) {
	const auth = requireAdminAuth(request);

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
		const upstreamResponse = await fetch(
			"https://auth.openai.com/oauth/token",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
				},
				body: JSON.stringify({
					client_id: CHATGPT_OAUTH_CLIENT_ID,
					grant_type: "refresh_token",
					refresh_token: state.refreshToken,
				}),
			},
		);

		const bodyText = await upstreamResponse.text();
		let returned = {
			accessTokenPresent: false,
			refreshTokenPresent: false,
			idTokenPresent: false,
			accountIdPresent: false,
		};
		let persisted = false;

		try {
			const parsedBody = JSON.parse(bodyText) as Record<string, unknown>;

			if (parsedBody && typeof parsedBody === "object") {
				returned = safeTokenPresence(parsedBody);

				if (persist && upstreamResponse.ok) {
					await updateMediatorCredentialsFromOAuthResponse(state, parsedBody);
					persisted = true;
				}
			}
		} catch {
			// Non-JSON upstream responses keep safe preview only.
		}

		const durationMs = Date.now() - startedAt;
		const upstream = {
			status: upstreamResponse.status,
			statusText: upstreamResponse.statusText,
			contentType: upstreamResponse.headers.get("content-type"),
			bodyPreview: safeBodyPreview(bodyText),
			durationMs,
		};

		return Response.json(
			{
				ok: upstreamResponse.ok,
				upstream,
				returned,
				persisted,
				checkedAt,
			},
			{ status: upstreamResponse.ok ? 200 : upstreamResponse.status },
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
