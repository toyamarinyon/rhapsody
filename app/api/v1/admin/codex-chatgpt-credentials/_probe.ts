const BODY_PREVIEW_LIMIT = 1000;

export function safeProbeUrl(raw: string) {
	const url = new URL(raw);
	return `${url.origin}${url.pathname}`;
}

export function safeBodyPreview(body: string) {
	return redactSensitiveText(body)
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, BODY_PREVIEW_LIMIT);
}

export function redactSensitiveText(input: string) {
	return input
		.replace(
			/"(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password)"\s*:\s*"[^"]+"/gi,
			'"[redacted]":"[redacted]"',
		)
		.replace(
			/\b(?:api[_-]?key|token|secret|password|credential|pat|bearer)\s*[:=]\s*[^\s,"]{4,}/gi,
			"[redacted]",
		)
		.replace(
			/\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token)\s*[:=]\s*[^\s,"]{4,}/gi,
			"[redacted]",
		)
		.replace(/\bbearer\s+[\w.-]+/gi, "bearer [redacted]");
}

export function safeTokenPresence(body: Record<string, unknown>) {
	const valueOrFalse = (value: unknown): boolean => {
		return typeof value === "string" && value.trim().length > 0;
	};

	return {
		accessTokenPresent: valueOrFalse(body.access_token),
		refreshTokenPresent: valueOrFalse(body.refresh_token),
		idTokenPresent: valueOrFalse(body.id_token),
		accountIdPresent: valueOrFalse(body.account_id),
	};
}

export function serializeError(error: unknown) {
	if (error instanceof Error) {
		return { name: error.name, message: error.message };
	}

	return { name: "UnknownError", message: String(error) };
}
