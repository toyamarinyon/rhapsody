import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
	ADMIN_SESSION_COOKIE_NAME,
	buildAdminLoginUrl,
	getAdminSessionConfigError,
} from "@/lib/server/admin-session";

export const dynamic = "force-dynamic";

export default function DashboardLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	if (getAdminSessionConfigError()) {
		redirect(buildAdminLoginUrl("/dashboard"));
	}

	const cookieStore = cookies() as unknown as {
		get(name: string): { value?: string } | undefined;
	};
	const token = cookieStore.get(ADMIN_SESSION_COOKIE_NAME)?.value;

	if (!token?.trim()) {
		redirect(buildAdminLoginUrl("/dashboard"));
	}

	return <>{children}</>;
}
