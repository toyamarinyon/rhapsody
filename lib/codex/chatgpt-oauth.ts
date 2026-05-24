export const CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export type ChatGptOAuthRefreshResponse = {
	ok: boolean;
	status: number;
	statusText: string;
	contentType: string | null;
	bodyText: string;
	parsedBody: Record<string, unknown> | null;
};

export async function requestChatGptOAuthRefresh(
	refreshToken: string,
	fetchImpl: typeof fetch = fetch,
): Promise<ChatGptOAuthRefreshResponse> {
	const upstreamResponse = await fetchImpl("https://auth.openai.com/oauth/token", {
		method: "POST",
		headers: {
			"content-type": "application/json",
		},
		body: JSON.stringify({
			client_id: CHATGPT_OAUTH_CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		}),
	});
	const bodyText = await upstreamResponse.text();

	return {
		ok: upstreamResponse.ok,
		status: upstreamResponse.status,
		statusText: upstreamResponse.statusText,
		contentType: upstreamResponse.headers.get("content-type"),
		bodyText,
		parsedBody: parseJsonObject(bodyText),
	};
}

function parseJsonObject(bodyText: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(bodyText) as unknown;

		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// Non-JSON responses are still valid for status-only handling.
	}

	return null;
}
