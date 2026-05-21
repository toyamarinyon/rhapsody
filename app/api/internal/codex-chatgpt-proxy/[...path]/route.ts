import {
	DUMMY_CHATGPT_REFRESH_TOKEN,
	buildCodexChatGPTDummyAuthFile,
} from "@/lib/codex/auth";
import { decodeJwt } from "jose";
import {
	loadMediatorCredentialState,
	updateMediatorCredentialsFromOAuthResponse,
} from "@/lib/codex/credentials";
import {
	extractSafeOidcClaimSnapshot,
	verifyVercelSandboxOidcToken,
} from "@/lib/vercel/oidc";
import { createStateStoreClient, getRunDetail } from "@/lib/state";

export const runtime = "nodejs";

const CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const RHAPSODY_PROXY_HEADER_VALUE = "codex-chatgpt";

async function handleCodexChatGPTProxy(
	request: Request,
	context: { params: Promise<{ path: string[] }> },
) {
	const method = request.method.toUpperCase();
	const { path } = await context.params;
	const forwardedHost = normalizeForwardedHost(
		request.headers.get("vercel-forwarded-host") ?? "",
	);
	const proxyPath = parseProxyPath(path);
	const normalizedPath = proxyPath.upstreamPath;
	const auth = await requireMediatorAuth(request, proxyPath.runContext);

	if (!auth.ok) {
		return auth.response;
	}

	if (isWebsocketUpgrade(request.headers)) {
		console.warn("codex-chatgpt-proxy request", {
			forwardedHost,
			normalizedPath,
			method,
			branch: "websocket",
		});

		return Response.json(
			{
				error: "WebSocket upgrade is not supported for this mediator endpoint.",
			},
			{ status: 426 },
		);
	}

	const body = isBodyAllowedForMethod(method)
		? await request.arrayBuffer()
		: null;

	const routeBranch =
		forwardedHost === "auth.openai.com" &&
		normalizedPath.endsWith("/oauth/token")
			? "oauth_refresh"
			: forwardedHost === "chatgpt.com" &&
					normalizedPath.includes("/backend-api/")
				? "chatgpt_backend"
				: "unsupported";

	if (routeBranch === "oauth_refresh") {
		console.info("codex-chatgpt-proxy request", {
			forwardedHost,
			normalizedPath,
			method,
			branch: routeBranch,
		});
		return handleAuthTokenExchange(request, body, method);
	}

	if (routeBranch === "chatgpt_backend") {
		console.info("codex-chatgpt-proxy request", {
			forwardedHost,
			normalizedPath,
			method,
			branch: routeBranch,
		});
		return handleChatGPTBackendProxy(request, normalizedPath, body, method);
	}

	console.warn("codex-chatgpt-proxy request", {
		forwardedHost,
		normalizedPath,
		method,
		branch: routeBranch,
	});
	return Response.json(
		{ error: "Unsupported forwarded target." },
		{ status: 400 },
	);
}

export async function GET(
	request: Request,
	context: { params: Promise<{ path: string[] }> },
) {
	return handleCodexChatGPTProxy(request, context);
}

export async function POST(
	request: Request,
	context: { params: Promise<{ path: string[] }> },
) {
	return handleCodexChatGPTProxy(request, context);
}

export async function PUT(
	request: Request,
	context: { params: Promise<{ path: string[] }> },
) {
	return handleCodexChatGPTProxy(request, context);
}

export async function PATCH(
	request: Request,
	context: { params: Promise<{ path: string[] }> },
) {
	return handleCodexChatGPTProxy(request, context);
}

export async function DELETE(
	request: Request,
	context: { params: Promise<{ path: string[] }> },
) {
	return handleCodexChatGPTProxy(request, context);
}

async function handleAuthTokenExchange(
	_request: Request,
	body: ArrayBuffer | null,
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

	const upstreamResponse = await fetch("https://auth.openai.com/oauth/token", {
		method,
		headers: {
			"content-type": "application/json",
		},
		body: JSON.stringify({
			client_id: readOAuthClientId(body) ?? CHATGPT_OAUTH_CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: state.refreshToken,
		}),
	});

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

	try {
		const upstreamPayload = (await upstreamResponse.json()) as Record<
			string,
			unknown
		>;
		updatedState = await updateMediatorCredentialsFromOAuthResponse(
			state,
			upstreamPayload,
		);
	} catch {
		// Keep previously persisted credentials if the upstream body is not JSON.
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

async function handleChatGPTBackendProxy(
	request: Request,
	normalizedPath: string,
	body: ArrayBuffer | null,
	method: string,
) {
	const env = await loadMediatorCredentialState();
	console.info("codex-chatgpt-proxy chatgpt_backend state", {
		credentialStateSourced: Boolean(env),
		credentialStatePresent: Boolean(env?.accessToken && env?.accountId),
	});

	if (!env?.accessToken || !env?.accountId) {
		return Response.json(
			{ error: "Missing CHATGPT credentials in mediator state." },
			{ status: 500 },
		);
	}

	const requestUrl = new URL(request.url);
	const upstreamUrl = new URL(
		`https://chatgpt.com${normalizedPath}${requestUrl.search}`,
	);
	const upstreamResponse = await fetch(upstreamUrl.toString(), {
		method,
		headers: {
			...sanitizeMediatorRequestHeaders(request),
			authorization: `Bearer ${env.accessToken}`,
			"ChatGPT-Account-ID": env.accountId,
		},
		body,
	});
	console.info("codex-chatgpt-proxy chatgpt_backend upstream", {
		branch: "chatgpt_backend",
		method,
		forwardedHost: "chatgpt.com",
		upstreamStatus: upstreamResponse.status,
		upstreamStatusText: upstreamResponse.statusText,
	});

	const responseHeaders = {
		...sanitizeMediatorResponseHeaders(upstreamResponse.headers),
		"x-rhapsody-proxy": RHAPSODY_PROXY_HEADER_VALUE,
	};

	return new Response(upstreamResponse.body, {
		status: upstreamResponse.status,
		headers: responseHeaders,
	});
}

async function requireMediatorAuth(
	request: Request,
	runContext: ProxyRunContext | null,
): Promise<{ ok: true } | { ok: false; response: Response }> {
	const requestUrl = new URL(request.url);
	const expectedProjectId = process.env.VERCEL_PROJECT_ID;
	const expectedTeamId = process.env.VERCEL_TEAM_ID;
	const oidcToken = request.headers.get("vercel-sandbox-oidc-token");

	if (!oidcToken) {
		return unauthorized("missing_oidc_token");
	}

	if (!expectedProjectId) {
		return unauthorized("missing_vercel_context");
	}

	const audience = buildExpectedOidcAudience(requestUrl.origin, runContext);
	const decodedClaims = decodeSafeOidcClaims(oidcToken);
	const verified = await verifyVercelSandboxOidcToken(oidcToken, {
		audienceSource: {
			projectId: expectedProjectId,
			teamId: expectedTeamId,
			audience,
		},
	});

	console.info("codex-chatgpt-proxy oidc verification", {
		...extractSafeOidcClaimSnapshot(verified?.payload ?? decodedClaims ?? {}),
		authorized: Boolean(verified),
		expectedAudience: audience,
	});

	if (!verified) {
		return unauthorized("oidc_verification_failed");
	}

	if (!(await isProxyRunContextActive(runContext))) {
		return unauthorized("run_context_inactive");
	}

	return { ok: true };
}

function unauthorized(reason: string): { ok: false; response: Response } {
	return {
		ok: false,
		response: Response.json(
			{ error: "Unauthorized.", reason },
			{ status: 401 },
		),
	};
}

function decodeSafeOidcClaims(token: string) {
	try {
		return decodeJwt(token);
	} catch {
		return null;
	}
}

function buildExpectedOidcAudience(
	origin: string,
	runContext: ProxyRunContext | null,
) {
	if (!runContext) {
		return `${origin}/api/internal/codex-chatgpt-proxy`;
	}

	return `${origin}/api/internal/codex-chatgpt-proxy/runs/${runContext.runId}/attempts/${runContext.attemptId}${runContext.audienceSuffix}`;
}

type ProxyRunContext = {
	runId: string;
	attemptId: string;
	audienceSuffix: string;
};

function parseProxyPath(path: string[]): {
	upstreamPath: string;
	runContext: ProxyRunContext | null;
} {
	if (
		path.length >= 5 &&
		path[0] === "runs" &&
		path[2] === "attempts" &&
		path[1]?.trim() &&
		path[3]?.trim()
	) {
		const remainingPath = path.slice(4);
		const parsedPrefixedPath = parsePathPrefixForward(remainingPath);

		return {
			runContext: {
				runId: path[1],
				attemptId: path[3],
				audienceSuffix: parsedPrefixedPath.audienceSuffix,
			},
			upstreamPath: parsedPrefixedPath.upstreamPath,
		};
	}

	return {
		runContext: null,
		upstreamPath: `/${path.join("/")}`,
	};
}

function parsePathPrefixForward(path: string[]) {
	if (path[0] === "codex" && path[1] === "chatgpt") {
		return {
			audienceSuffix: "/codex/chatgpt",
			upstreamPath: `/${path.slice(2).join("/")}`,
		};
	}

	if (path[0] === "codex" && path[1] === "oauth" && path[2] === "token") {
		return {
			audienceSuffix: "/codex/oauth/token",
			upstreamPath: "/oauth/token",
		};
	}

	return {
		audienceSuffix: "",
		upstreamPath: `/${path.join("/")}`,
	};
}

async function isProxyRunContextActive(runContext: ProxyRunContext | null) {
	if (!runContext) {
		return false;
	}

	const client = createStateStoreClient();

	try {
		const detail = await getRunDetail(client, runContext.runId);
		const attempt = detail?.attempts.find(
			(candidate) => candidate.id === runContext.attemptId,
		);

		return detail?.run.status === "running" && attempt?.status === "running";
	} finally {
		client.close();
	}
}

function isBodyAllowedForMethod(method: string) {
	return method !== "GET" && method !== "HEAD";
}

function isWebsocketUpgrade(headers: Headers) {
	return headers.get("upgrade")?.toLowerCase() === "websocket";
}

function readOAuthClientId(body: ArrayBuffer | null) {
	if (!body) {
		return null;
	}

	try {
		const value = JSON.parse(Buffer.from(body).toString("utf8")) as unknown;

		if (
			value &&
			typeof value === "object" &&
			"client_id" in value &&
			typeof value.client_id === "string" &&
			value.client_id.trim()
		) {
			return value.client_id;
		}
	} catch {
		return null;
	}

	return null;
}

function sanitizeMediatorRequestHeaders(
	request: Request,
): Record<string, string> {
	const sanitized: Record<string, string> = {};
	const denylist = new Set([
		"authorization",
		"chatgpt-account-id",
		"connection",
		"cookie",
		"host",
		"keep-alive",
		"openai-organization",
		"proxy-connection",
		"proxy-authorization",
		"te",
		"trailers",
		"transfer-encoding",
		"upgrade",
		"x-openai-fedramp",
		"x-rhapsody-mediator-secret",
		"x-vercel-forwarded-host",
		"vercel-forwarded-host",
		"x-vercel-forwarded-scheme",
		"vercel-forwarded-scheme",
		"x-vercel-forwarded-port",
		"vercel-forwarded-port",
		"x-vercel-sandbox-oidc-token",
		"vercel-sandbox-oidc-token",
	]);

	for (const [key, value] of request.headers.entries()) {
		const normalizedKey = key.toLowerCase();

		if (denylist.has(normalizedKey)) {
			continue;
		}

		if (normalizedKey === "content-length") {
			continue;
		}

		sanitized[key] = value;
	}

	return sanitized;
}

function sanitizeMediatorResponseHeaders(headers: Headers) {
	const denied = new Set([
		"x-rhapsody-mediator-secret",
		"x-vercel-forwarded-host",
		"vercel-forwarded-host",
	]);
	const sanitized: Record<string, string> = {};

	for (const [key, value] of headers.entries()) {
		if (!denied.has(key.toLowerCase())) {
			sanitized[key] = value;
		}
	}

	return sanitized;
}

function normalizeForwardedHost(value: string) {
	return value.split(":")[0];
}
