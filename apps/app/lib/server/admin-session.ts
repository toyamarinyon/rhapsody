import { timingSafeEqual } from "node:crypto";

import { SignJWT, jwtVerify } from "jose";
import { redirect } from "next/navigation";

import { loadRhapsodyAuthSecretEnv } from "@/lib/config";

export const ADMIN_SESSION_COOKIE_NAME = "rhapsody_admin_session";
const ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const DEFAULT_DASHBOARD_PATH = "/dashboard";

type CookieStoreLike = {
	get(name: string):
		| {
				value?: string;
		  }
		| undefined;
};
type EnvInput = Record<string, string | undefined>;

export type AdminSession = {
	sub: "rhapsody-admin";
};

export function createAdminSessionToken(env?: EnvInput): Promise<string> {
	const resolvedEnv = env ?? (process.env as unknown as EnvInput);
	const { AUTH_SECRET } = loadRhapsodyAuthSecretEnv(
		resolvedEnv as unknown as NodeJS.ProcessEnv,
	);
	const secret = new TextEncoder().encode(AUTH_SECRET);

	return new SignJWT({})
		.setProtectedHeader({ alg: "HS256", typ: "JWT" })
		.setSubject("rhapsody-admin")
		.setIssuedAt()
		.setExpirationTime(`${ADMIN_SESSION_TTL_SECONDS}s`)
		.sign(secret);
}

export async function verifyAdminSessionToken(
	token: string,
	env?: EnvInput,
): Promise<AdminSession | null> {
	try {
		const resolvedEnv = env ?? (process.env as unknown as EnvInput);
		const { AUTH_SECRET } = loadRhapsodyAuthSecretEnv(
			resolvedEnv as unknown as NodeJS.ProcessEnv,
		);
		const secret = new TextEncoder().encode(AUTH_SECRET);
		const result = await jwtVerify(token, secret, {
			subject: "rhapsody-admin",
		});

		return result.payload.sub === "rhapsody-admin"
			? { sub: "rhapsody-admin" }
			: null;
	} catch {
		return null;
	}
}

export function buildAdminSessionCookie(token: string, secure = true) {
	return [
		`${ADMIN_SESSION_COOKIE_NAME}=${token}`,
		"HttpOnly",
		"Path=/",
		"SameSite=Lax",
		...(secure ? ["Secure"] : []),
		`Max-Age=${ADMIN_SESSION_TTL_SECONDS}`,
	].join("; ");
}

export function buildAdminSessionCookieOptions(secure = true) {
	return {
		httpOnly: true,
		path: "/",
		sameSite: "lax" as const,
		secure,
		maxAge: ADMIN_SESSION_TTL_SECONDS,
	};
}

export function clearAdminSessionCookie() {
	return [
		`${ADMIN_SESSION_COOKIE_NAME}=`,
		"HttpOnly",
		"Path=/",
		"SameSite=Lax",
		"Secure",
		"Max-Age=0",
	].join("; ");
}

export async function createAdminSessionCookie(env?: EnvInput) {
	const token = await createAdminSessionToken(env);
	return buildAdminSessionCookie(token);
}

export function hasAdminSessionConfig(env?: EnvInput) {
	const resolvedEnv = env ?? (process.env as unknown as EnvInput);

	return Boolean(
		resolvedEnv.ROOT_PASSWORD?.trim() && resolvedEnv.AUTH_SECRET?.trim(),
	);
}

export function getAdminSessionConfigError(env?: EnvInput) {
	const resolvedEnv = env ?? (process.env as unknown as EnvInput);

	if (hasAdminSessionConfig(resolvedEnv)) {
		return null;
	}

	return "Admin dashboard access requires both ROOT_PASSWORD and AUTH_SECRET.";
}

export function readAdminSessionToken(request: Request): string | null {
	const cookie = request.headers.get("cookie");

	if (!cookie) {
		return null;
	}

	const token = cookie
		.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith(`${ADMIN_SESSION_COOKIE_NAME}=`))
		?.slice(ADMIN_SESSION_COOKIE_NAME.length + 1);

	return token?.trim() ? token : null;
}

export function readAdminSessionTokenFromCookieStore(
	cookieStore: CookieStoreLike,
): string | null {
	const token = cookieStore.get(ADMIN_SESSION_COOKIE_NAME)?.value;

	return token?.trim() ? token : null;
}

export function sanitizeAdminNextPath(
	value: FormDataEntryValue | string | null,
) {
	if (typeof value !== "string" || !value.startsWith("/")) {
		return DEFAULT_DASHBOARD_PATH;
	}

	if (value.startsWith("//")) {
		return DEFAULT_DASHBOARD_PATH;
	}

	try {
		const parsed = new URL(value, "https://rhapsody.local");

		if (
			parsed.pathname !== DEFAULT_DASHBOARD_PATH &&
			!parsed.pathname.startsWith(`${DEFAULT_DASHBOARD_PATH}/`)
		) {
			return DEFAULT_DASHBOARD_PATH;
		}

		return `${parsed.pathname}${parsed.search}${parsed.hash}`;
	} catch {
		return DEFAULT_DASHBOARD_PATH;
	}
}

export function isSecureRequest(headers: Headers) {
	const forwardedProto = headers.get("x-forwarded-proto");

	if (forwardedProto) {
		return forwardedProto.split(",")[0]?.trim().toLowerCase() === "https";
	}

	return process.env.VERCEL_ENV === "production";
}

export function verifyAdminPassword(
	submittedPassword: string,
	rootPassword: string,
) {
	const submitted = Buffer.from(submittedPassword);
	const expected = Buffer.from(rootPassword);

	if (submitted.length !== expected.length) {
		const length = Math.max(submitted.length, expected.length, 1);
		const paddedSubmitted = Buffer.alloc(length);
		const paddedExpected = Buffer.alloc(length);

		submitted.copy(paddedSubmitted);
		expected.copy(paddedExpected);
		timingSafeEqual(paddedSubmitted, paddedExpected);

		return false;
	}

	return timingSafeEqual(submitted, expected);
}

export function buildAdminLoginUrl(nextPath: string) {
	return `/login?next=${encodeURIComponent(sanitizeAdminNextPath(nextPath))}`;
}

export async function requireAdminDashboardSession({
	nextPath,
	cookieStore,
	env,
}: {
	nextPath: string;
	cookieStore: CookieStoreLike | Promise<CookieStoreLike>;
	env?: EnvInput;
}) {
	const resolvedEnv = env ?? (process.env as unknown as EnvInput);

	if (!hasAdminSessionConfig(resolvedEnv)) {
		redirect(buildAdminLoginUrl(nextPath));
	}

	const resolvedCookieStore = await cookieStore;
	const token = readAdminSessionTokenFromCookieStore(resolvedCookieStore);

	if (token) {
		const session = await verifyAdminSessionToken(token, resolvedEnv);

		if (session) {
			return session;
		}
	}

	redirect(buildAdminLoginUrl(nextPath));
}
