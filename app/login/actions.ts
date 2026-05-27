"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import {
	ADMIN_SESSION_COOKIE_NAME,
	buildAdminSessionCookieOptions,
	createAdminSessionToken,
	isSecureRequest,
	sanitizeAdminNextPath,
	verifyAdminPassword,
} from "@/lib/server/admin-session";

const INVALID_LOGIN_DELAY_MS = 750;

export async function loginAction(formData: FormData) {
	const submittedPassword = String(formData.get("password") ?? "");
	const nextPath = sanitizeAdminNextPath(formData.get("next"));

	const rootPassword = process.env.ROOT_PASSWORD ?? "";
	const authSecret = process.env.AUTH_SECRET ?? "";
	const requestHeaders = await headers();
	const secure = isSecureRequest(requestHeaders);

	if (!rootPassword?.trim() || !authSecret?.trim()) {
		await delay(INVALID_LOGIN_DELAY_MS);
		redirect("/login?error=configuration");
	}

	if (!verifyAdminPassword(submittedPassword, rootPassword)) {
		await delay(INVALID_LOGIN_DELAY_MS);
		redirect(`/login?error=invalid&next=${encodeURIComponent(nextPath)}`);
	}

	const sessionToken = await createAdminSessionToken({
		AUTH_SECRET: authSecret,
	});
	const cookieStore = await cookies();
	cookieStore.set(
		ADMIN_SESSION_COOKIE_NAME,
		sessionToken,
		buildAdminSessionCookieOptions(secure),
	);

	redirect(nextPath);
}

function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
