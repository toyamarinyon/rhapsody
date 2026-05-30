import { createRemoteJWKSet, jwtVerify } from "jose";

import { loadRhapsodyVercelOidcEnv } from "@/lib/config";

export type VercelSandboxOidcPayload = {
	iss?: string;
	aud?: string | string[];
	sub?: string;
	owner?: string;
	owner_id?: string;
	project?: string;
	project_id?: string;
	environment?: string;
	sandbox_id?: string;
	session_id?: string;
	[key: string]: unknown;
};

const VERCEL_OIDC_JWKS_URL = "https://oidc.vercel.com/.well-known/jwks.json";

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

type OidcAudienceSource = {
	projectId: string;
	teamId?: string;
	audience: string;
};

type VerifyVercelSandboxOidcTokenOptions = {
	audienceSource: OidcAudienceSource;
};

export async function verifyVercelSandboxOidcToken(
	token: string,
	options: VerifyVercelSandboxOidcTokenOptions,
): Promise<{ payload: VercelSandboxOidcPayload } | null> {
	if (!token?.trim()) {
		return null;
	}

	const audienceSource = options.audienceSource;

	const env = loadRhapsodyVercelOidcEnv();
	const jwks = getJwksFetcher();
	const issuer = resolveIssuer(env, audienceSource.teamId);
	const expectedAudience = audienceSource.audience;

	try {
		const verifyOptions: {
			issuer?: string;
			audience?: string;
		} = {};

		if (issuer) {
			verifyOptions.issuer = issuer;
		}

		if (expectedAudience) {
			verifyOptions.audience = expectedAudience;
		}

		const { payload } = await jwtVerify(token, jwks, verifyOptions);

		if (payload.project_id !== audienceSource.projectId) {
			return null;
		}

		if (
			audienceSource.teamId &&
			payload.owner_id !== undefined &&
			String(payload.owner_id).trim() !== audienceSource.teamId
		) {
			return null;
		}

		if (
			audienceSource.teamId &&
			payload.team_id !== undefined &&
			String(payload.team_id).trim() !== audienceSource.teamId
		) {
			return null;
		}

		return { payload: payload as VercelSandboxOidcPayload };
	} catch {
		return null;
	}
}

function getJwksFetcher() {
	if (!cachedJwks) {
		cachedJwks = createRemoteJWKSet(new URL(VERCEL_OIDC_JWKS_URL));
	}

	return cachedJwks;
}

function resolveIssuer(
	env: ReturnType<typeof loadRhapsodyVercelOidcEnv>,
	teamId?: string,
) {
	if (env.VERCEL_OIDC_ISSUER?.trim()) {
		return env.VERCEL_OIDC_ISSUER.trim();
	}

	if (teamId?.trim()) {
		return `https://oidc.vercel.com/${teamId.trim()}`;
	}

	if (env.VERCEL_TEAM_SLUG?.trim()) {
		return `https://oidc.vercel.com/${env.VERCEL_TEAM_SLUG.trim()}`;
	}

	return undefined;
}

export function extractSafeOidcClaimSnapshot(
	payload: VercelSandboxOidcPayload,
) {
	const keys = [
		"iss",
		"aud",
		"sub",
		"owner",
		"owner_id",
		"project",
		"project_id",
		"environment",
		"sandbox_id",
		"session_id",
	] as const;
	const snapshot: Record<string, unknown> = {};

	for (const key of Object.keys(payload)) {
		if (
			key.includes("sandbox") ||
			key.includes("session") ||
			key.includes("id")
		) {
			snapshot[key] = payload[key];
		}
	}

	for (const key of keys) {
		if (payload[key] !== undefined) {
			snapshot[key] = payload[key];
		}
	}

	return snapshot;
}
