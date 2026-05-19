import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Client, Row } from "@libsql/client";
import { createStateStoreClient } from "@/lib/state";
import { loadRhapsodyAuthSecretEnv, loadRhapsodyCodexChatGPTEnv } from "@/lib/config";

const CREDENTIAL_ROW_ID = "default";
const CREDENTIAL_ACCOUNT_ID_FALLBACK = "acct_dummy";
const MEDIATOR_CREDENTIAL_TABLE_NAME = "codex_chatgpt_credentials";
const AES_GCM_IV_LENGTH = 12;

type EncryptedValue = {
	data: string;
	iv: string;
	tag: string;
};

type EncryptedCredentialRow = {
	encrypted_access_token: string;
	access_token_iv: string;
	access_token_tag: string;
	encrypted_refresh_token: string;
	refresh_token_iv: string;
	refresh_token_tag: string;
	account_id: string;
};

export type MediatorCredentialState = {
	accessToken: string;
	refreshToken: string;
	accountId: string;
};

export type SeedMediatorCredentialResult = {
	accountIdPresent: boolean;
	updatedAt: number;
};

export async function loadMediatorCredentialState(): Promise<MediatorCredentialState | null> {
	const client = createStateStoreClient();

	try {
		let fromDb: MediatorCredentialState | null = null;

		try {
			fromDb = await loadMediatorCredentialStateFromDb(client);
		} catch {
			fromDb = null;
		}

		if (fromDb) {
			return fromDb;
		}

		return await seedMediatorCredentialsFromEnv(client);
	} finally {
		client.close();
	}
}

export async function seedMediatorCredentialStateFromEnv(): Promise<SeedMediatorCredentialResult> {
	const env = loadRhapsodyCodexChatGPTEnv();
	const accountId = env.CHATGPT_ACCOUNT_ID?.trim() ?? CREDENTIAL_ACCOUNT_ID_FALLBACK;
	const accessToken = env.CHATGPT_ACCESS_TOKEN?.trim();
	const refreshToken = env.CHATGPT_REFRESH_TOKEN?.trim();

	if (!accessToken || !refreshToken) {
		throw new Error("CHATGPT_ACCESS_TOKEN and CHATGPT_REFRESH_TOKEN are required.");
	}

	const state: MediatorCredentialState = {
		accessToken,
		refreshToken,
		accountId,
	};
	const now = Date.now();

	const client = createStateStoreClient();

	try {
		await saveMediatorCredentialStateInDb(client, state, now);
	} finally {
		client.close();
	}

	return {
		accountIdPresent: Boolean(env.CHATGPT_ACCOUNT_ID?.trim()),
		updatedAt: now,
	};
}

export async function saveMediatorCredentialState(state: MediatorCredentialState): Promise<void> {
	const client = createStateStoreClient();

	try {
		await saveMediatorCredentialStateInDb(client, state);
	} finally {
		client.close();
	}
}

async function loadMediatorCredentialStateFromDb(client: Client): Promise<MediatorCredentialState | null> {
	const result = await client.execute({
		sql: `
			SELECT
				encrypted_access_token,
				access_token_iv,
				access_token_tag,
				encrypted_refresh_token,
				refresh_token_iv,
				refresh_token_tag,
				account_id
			FROM ${MEDIATOR_CREDENTIAL_TABLE_NAME}
			WHERE id = ?
			LIMIT 1
		`,
		args: [CREDENTIAL_ROW_ID],
	});

	const row = result.rows[0] as Row | undefined;
	if (!row) {
		return null;
	}

	const parsed: EncryptedCredentialRow = {
		encrypted_access_token: getString(row, "encrypted_access_token"),
		access_token_iv: getString(row, "access_token_iv"),
		access_token_tag: getString(row, "access_token_tag"),
		encrypted_refresh_token: getString(row, "encrypted_refresh_token"),
		refresh_token_iv: getString(row, "refresh_token_iv"),
		refresh_token_tag: getString(row, "refresh_token_tag"),
		account_id: getString(row, "account_id"),
	};

	const key = getEncryptionKey();
	return {
		accessToken: decryptValue({
			data: parsed.encrypted_access_token,
			iv: parsed.access_token_iv,
			tag: parsed.access_token_tag,
		}, key),
		refreshToken: decryptValue({
			data: parsed.encrypted_refresh_token,
			iv: parsed.refresh_token_iv,
			tag: parsed.refresh_token_tag,
		}, key),
		accountId: parsed.account_id,
	};
}

async function seedMediatorCredentialsFromEnv(client: Client): Promise<MediatorCredentialState | null> {
	const env = loadRhapsodyCodexChatGPTEnv();
	const accountId = env.CHATGPT_ACCOUNT_ID ?? CREDENTIAL_ACCOUNT_ID_FALLBACK;
	const accessToken = env.CHATGPT_ACCESS_TOKEN?.trim();
	const refreshToken = env.CHATGPT_REFRESH_TOKEN?.trim();

	if (!accessToken || !refreshToken) {
		return null;
	}

	const state = {
		accessToken,
		refreshToken,
		accountId,
	};

	await saveMediatorCredentialStateInDb(client, state);

	return state;
}

async function saveMediatorCredentialStateInDb(
	client: Client,
	state: MediatorCredentialState,
	now: number = Date.now(),
): Promise<void> {
	const key = getEncryptionKey();
	const accessTokenSecret = encryptValue(state.accessToken, key);
	const refreshTokenSecret = encryptValue(state.refreshToken, key);

	await client.execute({
		sql: `
			INSERT INTO ${MEDIATOR_CREDENTIAL_TABLE_NAME} (
				id,
				encrypted_access_token,
				access_token_iv,
				access_token_tag,
				encrypted_refresh_token,
				refresh_token_iv,
				refresh_token_tag,
				account_id,
				updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET
				encrypted_access_token = excluded.encrypted_access_token,
				access_token_iv = excluded.access_token_iv,
				access_token_tag = excluded.access_token_tag,
				encrypted_refresh_token = excluded.encrypted_refresh_token,
				refresh_token_iv = excluded.refresh_token_iv,
				refresh_token_tag = excluded.refresh_token_tag,
				account_id = excluded.account_id,
				updated_at = excluded.updated_at
		`,
		args: [
			CREDENTIAL_ROW_ID,
			accessTokenSecret.data,
			accessTokenSecret.iv,
			accessTokenSecret.tag,
			refreshTokenSecret.data,
			refreshTokenSecret.iv,
			refreshTokenSecret.tag,
			state.accountId,
			now,
		],
	});
}

function encryptValue(value: string, key: Buffer): EncryptedValue {
	const iv = randomBytes(AES_GCM_IV_LENGTH);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
	return {
		data: encrypted.toString("base64"),
		iv: iv.toString("base64"),
		tag: cipher.getAuthTag().toString("base64"),
	};
}

function decryptValue(value: EncryptedValue, key: Buffer): string {
	const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
	decipher.setAuthTag(Buffer.from(value.tag, "base64"));
	return Buffer.concat([decipher.update(Buffer.from(value.data, "base64")), decipher.final()]).toString(
		"utf8",
	);
}

function getEncryptionKey(): Buffer {
	const env = loadRhapsodyAuthSecretEnv();

	return createHash("sha256").update(env.AUTH_SECRET).digest();
}

function getString(row: Row, column: string): string {
	const value = row[column];

	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`Expected ${column} to be a non-empty string.`);
	}

	return value;
}

export async function updateMediatorCredentialsFromOAuthResponse(
	state: MediatorCredentialState,
	upstream: Record<string, unknown>,
): Promise<MediatorCredentialState> {
	const nextAccessToken = safeStringFromObject(upstream, "access_token") ?? state.accessToken;
	const nextRefreshToken =
		safeStringFromObject(upstream, "refresh_token") ?? state.refreshToken;
	const idToken = safeStringFromObject(upstream, "id_token");
	const nextAccountIdFromIdToken = parseAccountIdFromIdToken(idToken);
	const nextAccountId =
		safeStringFromObject(upstream, "account_id") ??
		safeStringFromObject(upstream, "chatgpt_account_id") ??
		nextAccountIdFromIdToken ??
		state.accountId;

	const updatedState = {
		accessToken: nextAccessToken,
		refreshToken: nextRefreshToken,
		accountId: nextAccountId,
	};

	await saveMediatorCredentialState(updatedState);

	return updatedState;
}

function safeStringFromObject(payload: Record<string, unknown>, key: string): string | null {
	const value = payload[key];

	if (typeof value === "string" && value.trim()) {
		return value;
	}

	return null;
}

function parseAccountIdFromIdToken(idToken: string | null): string | null {
	if (!idToken) {
		return null;
	}

	const payload = idToken.split(".")[1];
	if (!payload) {
		return null;
	}

	try {
		const decoded = Buffer.from(payload, "base64url").toString("utf8");
		const claims = JSON.parse(decoded) as {
			"https://api.openai.com/auth"?: {
				chatgpt_account_id?: string;
			};
		};

		const authClaims = claims["https://api.openai.com/auth"];
		if (authClaims?.chatgpt_account_id?.trim()) {
			return authClaims.chatgpt_account_id;
		}
	} catch {
		return null;
	}

	return null;
}
