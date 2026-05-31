export const DUMMY_CHATGPT_REFRESH_TOKEN = "dummy-refresh-token";

export type CodexAuthPayload = {
	auth_mode: "chatgpt";
	OPENAI_API_KEY: null;
	tokens: {
		id_token: string;
		access_token: string;
		refresh_token: string;
		account_id: string;
	};
	last_refresh: string;
};

export function buildCodexChatGPTDummyAuthFile(
	accountId: string | undefined,
): CodexAuthPayload {
	const resolvedAccountId = accountId?.trim() || "acct_dummy";
	const now = Math.floor(Date.now() / 1000);
	const nextHour = now + 60 * 60;

	return {
		auth_mode: "chatgpt",
		OPENAI_API_KEY: null,
		tokens: {
			id_token: buildDummyIdToken(resolvedAccountId),
			access_token: buildDummyAccessToken(resolvedAccountId, nextHour),
			refresh_token: DUMMY_CHATGPT_REFRESH_TOKEN,
			account_id: resolvedAccountId,
		},
		last_refresh: new Date().toISOString(),
	};
}

function buildDummyIdToken(accountId: string) {
	const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const iat = Math.floor(Date.now() / 1000);
	const payload = base64UrlEncode(
		JSON.stringify({
			iat,
			exp: iat + 60 * 60,
			scope: "openid chatgpt",
			"https://api.openai.com/auth": {
				chatgpt_plan_type: "free",
				chatgpt_user_id: "user_dummy",
				chatgpt_account_id: accountId,
				chatgpt_account_is_fedramp: false,
			},
		}),
	);
	const signature = base64UrlEncode(
		`${accountId}.id.${DUMMY_CHATGPT_REFRESH_TOKEN}`,
	);

	return `${header}.${payload}.${signature}`;
}

function buildDummyAccessToken(accountId: string, exp: number) {
	const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const payload = base64UrlEncode(
		JSON.stringify({
			account_id: accountId,
			iat: Math.floor(Date.now() / 1000),
			exp,
			scope: "chatgpt_api",
		}),
	);
	const signature = base64UrlEncode(
		`${accountId}.access.${DUMMY_CHATGPT_REFRESH_TOKEN}`,
	);

	return `${header}.${payload}.${signature}`;
}

function base64UrlEncode(input: string) {
	return Buffer.from(input).toString("base64url");
}
