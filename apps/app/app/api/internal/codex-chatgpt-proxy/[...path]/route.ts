import { decodeJwt } from "jose";
import { handleAuthTokenExchange } from "./auth-token-exchange";
import {
	buildExpectedOidcAudience,
	isProxyRunContextActive,
	parseProxyPath,
	type ProxyRunContext,
} from "@/lib/codex/proxy-auth";
import { loadMediatorCredentialState } from "@/lib/codex/credentials";
import {
	extractSafeOidcClaimSnapshot,
	verifyVercelSandboxOidcToken,
} from "@/lib/vercel/oidc";

export const runtime = "nodejs";
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

function isBodyAllowedForMethod(method: string) {
	return method !== "GET" && method !== "HEAD";
}

function isWebsocketUpgrade(headers: Headers) {
	return headers.get("upgrade")?.toLowerCase() === "websocket";
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
