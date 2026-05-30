import {
	buildCodexChatGPTDummyAuthFile,
	DUMMY_CHATGPT_REFRESH_TOKEN,
} from "@/lib/codex/auth";
import { requestChatGptOAuthRefresh } from "@/lib/codex/chatgpt-oauth";
import {
	loadMediatorCredentialState,
	updateMediatorCredentialsFromOAuthResponse,
} from "@/lib/codex/credentials";

export async function handleAuthTokenExchange(
	_request: Request,
	_body: ArrayBuffer | null,
	method: string,
) {
	const state = await loadMediatorCredentialState();
	console.info("codex-chatgpt-proxy oauth_refresh state", {
		credentialStateSourced: Boolean(state),
		credentialStatePresent: Boolean(state?.refreshToken),
	});

	if (!state?.refreshToken) {
		return Response.json(
			{ error: "Missing ChatGPT refresh token in mediator state." },
			{ status: 500 },
		);
	}

	if (method !== "POST") {
		return Response.json(
			{ error: "Only POST is allowed for auth token refresh." },
			{ status: 405 },
		);
	}

	const upstreamResponse = await requestChatGptOAuthRefresh(state.refreshToken);

	console.info("codex-chatgpt-proxy oauth_refresh upstream", {
		forwardedHost: "auth.openai.com",
		method,
		branch: "oauth_refresh",
		upstreamStatus: upstreamResponse.status,
		upstreamStatusText: upstreamResponse.statusText,
	});

	if (!upstreamResponse.ok) {
		return Response.json(
			{
				status: upstreamResponse.status,
				statusText: upstreamResponse.statusText,
			},
			{ status: upstreamResponse.status },
		);
	}

	let updatedState = state;

	if (upstreamResponse.parsedBody) {
		updatedState = await updateMediatorCredentialsFromOAuthResponse(
			state,
			upstreamResponse.parsedBody,
		);
	}

	if (!updatedState.accessToken || !updatedState.accountId) {
		return Response.json(
			{ error: "OAuth refresh did not return usable credentials." },
			{ status: 500 },
		);
	}

	const accountId = updatedState.accountId;
	const dummyTokens = buildCodexChatGPTDummyAuthFile(accountId);

	return Response.json({
		id_token: dummyTokens.tokens.id_token,
		access_token: dummyTokens.tokens.access_token,
		refresh_token: DUMMY_CHATGPT_REFRESH_TOKEN,
	});
}
