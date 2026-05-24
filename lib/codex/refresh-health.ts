import {
	createEvent,
	createStateStoreClient,
	getCodexChatGptCredentialHealth,
	saveCodexChatGptCredentialHealth,
	type CodexChatGptCredentialHealth,
} from "@/lib/state";
import {
	loadMediatorCredentialState,
	updateMediatorCredentialsFromOAuthResponse,
} from "./credentials";
import { requestChatGptOAuthRefresh } from "./chatgpt-oauth";

type RefreshHealthEventKind = "initial_success" | "recovered" | "failure";

export type ChatGptRefreshHealthCheckResult = {
	ok: boolean;
	needsReauth: boolean;
	checkedAt: string;
	lastSucceededAt: string | null;
	upstreamStatus: number | null;
	upstreamStatusText: string | null;
	errorCategory: string | null;
	eventRecorded: boolean;
};

export async function runChatGptRefreshHealthCheck(args?: {
	now?: number;
	fetchImpl?: typeof fetch;
}): Promise<ChatGptRefreshHealthCheckResult> {
	const client = createStateStoreClient();
	const checkedAt = args?.now ?? Date.now();
	const fetchImpl = args?.fetchImpl ?? fetch;

	try {
		const previous = await getCodexChatGptCredentialHealth(client);
		const state = await loadMediatorCredentialState();

		if (!state?.refreshToken) {
			return await persistHealthResult(client, previous, {
				ok: false,
				needsReauth: true,
				checkedAt,
				lastSucceededAt: previous?.lastSucceededAt ?? null,
				upstreamStatus: null,
				upstreamStatusText: null,
				errorCategory: "missing_refresh_token",
			});
		}

		try {
			const upstream = await requestChatGptOAuthRefresh(
				state.refreshToken,
				fetchImpl,
			);

			if (upstream.ok && upstream.parsedBody) {
				try {
					await updateMediatorCredentialsFromOAuthResponse(
						state,
						upstream.parsedBody,
					);
				} catch {
					return await persistHealthResult(client, previous, {
						ok: false,
						needsReauth: false,
						checkedAt,
						lastSucceededAt: previous?.lastSucceededAt ?? null,
						upstreamStatus: upstream.status,
						upstreamStatusText: upstream.statusText || null,
						errorCategory: "credential_state_update_error",
					});
				}
			}

			return await persistHealthResult(client, previous, {
				ok: upstream.ok,
				needsReauth: !upstream.ok,
				checkedAt,
				lastSucceededAt: upstream.ok
					? checkedAt
					: previous?.lastSucceededAt ?? null,
				upstreamStatus: upstream.status,
				upstreamStatusText: upstream.statusText || null,
				errorCategory: upstream.ok ? null : categorizeUpstreamFailure(upstream),
			});
		} catch {
			return await persistHealthResult(client, previous, {
				ok: false,
				needsReauth: true,
				checkedAt,
				lastSucceededAt: previous?.lastSucceededAt ?? null,
				upstreamStatus: null,
				upstreamStatusText: null,
				errorCategory: "network_error",
			});
		}
	} finally {
		client.close();
	}
}

async function persistHealthResult(
	client: ReturnType<typeof createStateStoreClient>,
	previous: CodexChatGptCredentialHealth | null,
	next: CodexChatGptCredentialHealth,
): Promise<ChatGptRefreshHealthCheckResult> {
	await saveCodexChatGptCredentialHealth(client, next);
	const event = buildHealthEvent(previous, next);

	if (event) {
		await createEvent(client, {
			level: event.level,
			type: event.type,
			message: event.message,
			data: serializeHealth(next),
			now: next.checkedAt,
		});
	}

	return {
		...serializeHealth(next),
		eventRecorded: Boolean(event),
	};
}

function buildHealthEvent(
	previous: CodexChatGptCredentialHealth | null,
	next: CodexChatGptCredentialHealth,
) {
	const kind = classifyEvent(previous, next);

	if (!kind) {
		return null;
	}

	if (kind === "initial_success") {
		return {
			level: "info" as const,
			type: "codex.chatgpt_credentials_health.ok",
			message: "ChatGPT credential refresh health check succeeded.",
		};
	}

	if (kind === "recovered") {
		return {
			level: "info" as const,
			type: "codex.chatgpt_credentials_health.ok",
			message: "ChatGPT credential refresh health check recovered.",
		};
	}

	return {
		level: "error" as const,
		type: "codex.chatgpt_credentials_health.needs_reauth",
		message: "ChatGPT credential refresh health check failed.",
	};
}

function classifyEvent(
	previous: CodexChatGptCredentialHealth | null,
	next: CodexChatGptCredentialHealth,
): RefreshHealthEventKind | null {
	if (next.ok) {
		if (!previous) {
			return "initial_success";
		}

		if (!previous.ok || previous.needsReauth) {
			return "recovered";
		}

		return null;
	}

	if (!previous || previous.ok || !previous.needsReauth) {
		return "failure";
	}

	if (
		previous.errorCategory !== next.errorCategory ||
		previous.upstreamStatus !== next.upstreamStatus ||
		previous.upstreamStatusText !== next.upstreamStatusText
	) {
		return "failure";
	}

	return null;
}

function categorizeUpstreamFailure(args: {
	status: number;
	parsedBody: Record<string, unknown> | null;
}) {
	const errorCode = sanitizeErrorCode(args.parsedBody?.error);

	if (errorCode === "invalid_grant") {
		return "oauth_invalid_grant";
	}

	if (errorCode) {
		return `oauth_${errorCode}`;
	}

	if (args.status >= 500) {
		return "oauth_upstream_error";
	}

	return "oauth_http_error";
}

function sanitizeErrorCode(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}

	const normalized = value.trim().toLowerCase();

	if (!normalized || normalized.length > 48) {
		return null;
	}

	if (!/^[a-z0-9_-]+$/.test(normalized)) {
		return null;
	}

	return normalized;
}

function serializeHealth(
	health: CodexChatGptCredentialHealth,
): Omit<ChatGptRefreshHealthCheckResult, "eventRecorded"> {
	return {
		ok: health.ok,
		needsReauth: health.needsReauth,
		checkedAt: new Date(health.checkedAt).toISOString(),
		lastSucceededAt:
			health.lastSucceededAt === null
				? null
				: new Date(health.lastSucceededAt).toISOString(),
		upstreamStatus: health.upstreamStatus,
		upstreamStatusText: health.upstreamStatusText,
		errorCategory: health.errorCategory,
	};
}
