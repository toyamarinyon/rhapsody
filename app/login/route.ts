import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import {
	buildAdminSessionCookie,
	createAdminSessionToken,
	hasAdminSessionConfig,
	sanitizeAdminNextPath,
} from "@/lib/server/admin-session";

export const runtime = "nodejs";

const LOGIN_DELAY_MS = 750;

export async function POST(request: Request) {
	const formData = await request.formData();
	const password = formData.get("password");
	const nextPath = sanitizeAdminNextPath(formData.get("next"));
	const rootPassword = process.env.ROOT_PASSWORD?.trim() ?? "";
	const authSecret = process.env.AUTH_SECRET?.trim() ?? "";

	if (
		typeof password !== "string" ||
		!hasAdminSessionConfig() ||
		!matchesPassword(password, rootPassword)
	) {
		await delay(LOGIN_DELAY_MS);
		return NextResponse.redirect(
			new URL(
				`/login?error=invalid&next=${encodeURIComponent(nextPath)}`,
				request.url,
			),
			{ status: 303 },
		);
	}

	const token = await createAdminSessionToken({ AUTH_SECRET: authSecret });
	const response = NextResponse.redirect(new URL(nextPath, request.url), {
		status: 303,
	});
	response.headers.append(
		"Set-Cookie",
		buildAdminSessionCookie(token, isSecureRequest(request)),
	);

	return response;
}

function matchesPassword(input: string, expected: string) {
	const inputBuffer = Buffer.from(input);
	const expectedBuffer = Buffer.from(expected);

	if (inputBuffer.length !== expectedBuffer.length) {
		return false;
	}

	return timingSafeEqual(inputBuffer, expectedBuffer);
}

function isSecureRequest(request: Request) {
	return (
		process.env.NODE_ENV === "production" ||
		process.env.VERCEL_ENV === "production" ||
		request.url.startsWith("https://")
	);
}

function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
