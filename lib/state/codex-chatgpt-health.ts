import type { Client, Row } from "@libsql/client";

const CREDENTIAL_HEALTH_ROW_ID = "default";
const CREDENTIAL_HEALTH_TABLE_NAME = "codex_chatgpt_credential_health";

export type CodexChatGptCredentialHealth = {
	ok: boolean;
	needsReauth: boolean;
	checkedAt: number;
	lastSucceededAt: number | null;
	upstreamStatus: number | null;
	upstreamStatusText: string | null;
	errorCategory: string | null;
};

export async function getCodexChatGptCredentialHealth(
	client: Client,
): Promise<CodexChatGptCredentialHealth | null> {
	const result = await client.execute({
		sql: `
			SELECT
				ok,
				needs_reauth,
				checked_at,
				last_succeeded_at,
				upstream_status,
				upstream_status_text,
				error_category
			FROM ${CREDENTIAL_HEALTH_TABLE_NAME}
			WHERE id = ?
			LIMIT 1
		`,
		args: [CREDENTIAL_HEALTH_ROW_ID],
	});
	const row = result.rows[0];

	if (!row) {
		return null;
	}

	return mapCredentialHealth(row);
}

export async function saveCodexChatGptCredentialHealth(
	client: Client,
	health: CodexChatGptCredentialHealth,
): Promise<CodexChatGptCredentialHealth> {
	await client.execute({
		sql: `
			INSERT INTO ${CREDENTIAL_HEALTH_TABLE_NAME} (
				id,
				ok,
				needs_reauth,
				checked_at,
				last_succeeded_at,
				upstream_status,
				upstream_status_text,
				error_category
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET
				ok = excluded.ok,
				needs_reauth = excluded.needs_reauth,
				checked_at = excluded.checked_at,
				last_succeeded_at = excluded.last_succeeded_at,
				upstream_status = excluded.upstream_status,
				upstream_status_text = excluded.upstream_status_text,
				error_category = excluded.error_category
		`,
		args: [
			CREDENTIAL_HEALTH_ROW_ID,
			health.ok ? 1 : 0,
			health.needsReauth ? 1 : 0,
			health.checkedAt,
			health.lastSucceededAt,
			health.upstreamStatus,
			health.upstreamStatusText,
			health.errorCategory,
		],
	});

	return health;
}

function mapCredentialHealth(row: Row): CodexChatGptCredentialHealth {
	return {
		ok: getBoolean(row, "ok"),
		needsReauth: getBoolean(row, "needs_reauth"),
		checkedAt: getNumber(row, "checked_at"),
		lastSucceededAt: getNullableNumber(row, "last_succeeded_at"),
		upstreamStatus: getNullableNumber(row, "upstream_status"),
		upstreamStatusText: getNullableString(row, "upstream_status_text"),
		errorCategory: getNullableString(row, "error_category"),
	};
}

function getBoolean(row: Row, column: string): boolean {
	const value = row[column];

	if (typeof value === "number") {
		return value !== 0;
	}

	if (typeof value === "bigint") {
		return value !== 0n;
	}

	throw new Error(`Expected ${column} to be a boolean-like integer.`);
}

function getNumber(row: Row, column: string): number {
	const value = row[column];

	if (typeof value === "number") {
		return value;
	}

	if (typeof value === "bigint") {
		return Number(value);
	}

	throw new Error(`Expected ${column} to be a number.`);
}

function getNullableNumber(row: Row, column: string): number | null {
	const value = row[column];

	if (value === null) {
		return null;
	}

	if (typeof value === "number") {
		return value;
	}

	if (typeof value === "bigint") {
		return Number(value);
	}

	throw new Error(`Expected ${column} to be a nullable number.`);
}

function getNullableString(row: Row, column: string): string | null {
	const value = row[column];

	if (value === null) {
		return null;
	}

	if (typeof value === "string") {
		return value;
	}

	throw new Error(`Expected ${column} to be a nullable string.`);
}
