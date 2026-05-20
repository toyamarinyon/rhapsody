import type { RunDetail, StateStoreEvent } from "@/lib/state/store";

type RunDiagnosticsClaim = {
	expiresAt: number | null;
	isExpired: boolean | null;
	secondsUntilExpiry: number | null;
};

export type RunDiagnostics = {
	summary: string;
	lastErrorEvent: StateStoreEvent | null;
	terminalCallbackError: string | null;
	claim: RunDiagnosticsClaim;
	recommendedAction: string;
};

const SECRET_REDACTIONS: Array<[RegExp, string]> = [
	[/gh[pousr]_[A-Za-z0-9_]+/g, "[redacted-github-token]"],
	[/github_pat_[A-Za-z0-9_]+/g, "[redacted-github-token]"],
	[/sk-[A-Za-z0-9_-]+/g, "[redacted-openai-token]"],
	[/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted-token]"],
	[/(refresh[_-]?token["':=\s]+)[^"',\s}]+/gi, "$1[redacted-token]"],
	[/(access[_-]?token["':=\s]+)[^"',\s}]+/gi, "$1[redacted-token]"],
];

export function buildRunDiagnostics(detail: RunDetail, now = Date.now()): RunDiagnostics {
	const lastAttempt = detail.attempts.at(-1) ?? null;
	const lastErrorEvent = findLastErrorEvent(detail.events);
	const terminalCallbackError = redactDiagnosticText(findTerminalCallbackError(detail.events));
	const claim = buildClaimDiagnostics(detail, now);
	const searchText = buildSearchText(detail, lastErrorEvent, terminalCallbackError);

	return {
		summary: buildSummary(detail, lastAttempt, lastErrorEvent, terminalCallbackError, claim),
		lastErrorEvent,
		terminalCallbackError,
		claim,
		recommendedAction: recommendAction(detail, searchText, claim),
	};
}

function findLastErrorEvent(events: StateStoreEvent[]) {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		if (events[index]?.level === "error") {
			return events[index];
		}
	}

	return null;
}

function findTerminalCallbackError(events: StateStoreEvent[]) {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];

		if (event?.type !== "attempt.terminal_callback") {
			continue;
		}

		const error = getStringProperty(event.data, "error");

		if (error) {
			return error;
		}
	}

	return null;
}

function buildClaimDiagnostics(detail: RunDetail, now: number): RunDiagnosticsClaim {
	if (!detail.claim) {
		return {
			expiresAt: null,
			isExpired: null,
			secondsUntilExpiry: null,
		};
	}

	const secondsUntilExpiry = Math.ceil((detail.claim.claimExpiresAt - now) / 1000);

	return {
		expiresAt: detail.claim.claimExpiresAt,
		isExpired: detail.claim.claimExpiresAt <= now,
		secondsUntilExpiry,
	};
}

function buildSummary(
	detail: RunDetail,
	lastAttempt: RunDetail["attempts"][number] | null,
	lastErrorEvent: StateStoreEvent | null,
	terminalCallbackError: string | null,
	claim: RunDiagnosticsClaim,
) {
	const attemptSummary = lastAttempt
		? `latest attempt ${lastAttempt.id} is ${lastAttempt.status}`
		: "no attempts are recorded";
	const parts = [`Run ${detail.run.id} is ${detail.run.status}; ${attemptSummary}.`];

	if (terminalCallbackError) {
		parts.push(`Terminal callback error: ${terminalCallbackError}`);
	} else if (lastErrorEvent) {
		parts.push(`Latest error event: ${lastErrorEvent.type}.`);
	}

	if (claim.isExpired === true) {
		parts.push("Claim is expired.");
	} else if (claim.secondsUntilExpiry !== null) {
		parts.push(`Claim expires in ${claim.secondsUntilExpiry} seconds.`);
	} else {
		parts.push("No active claim is recorded.");
	}

	return parts.join(" ");
}

function buildSearchText(
	detail: RunDetail,
	lastErrorEvent: StateStoreEvent | null,
	terminalCallbackError: string | null,
) {
	const relevantEvents = detail.events.filter((event) => {
		return (
			event.level === "error" ||
			event.type === "sandbox_codex_runner.network_probe" ||
			event.type === "attempt.terminal_callback"
		);
	});

	return [
		detail.run.runner,
		detail.run.status,
		terminalCallbackError,
		lastErrorEvent?.type,
		lastErrorEvent?.message,
		...relevantEvents.map((event) => {
			return `${event.type} ${event.message ?? ""} ${safeStringify(event.data)}`;
		}),
	]
		.filter(Boolean)
		.join("\n")
		.toLowerCase();
}

function recommendAction(detail: RunDetail, searchText: string, claim: RunDiagnosticsClaim) {
	if (searchText.includes("missing_vercel_context")) {
		return "Check Vercel platform environment and OIDC verification assumptions.";
	}

	if (searchText.includes("token_revoked")) {
		return "Refresh ChatGPT auth and seed mediator credentials from environment.";
	}

	if (searchText.includes("github_token is required")) {
		return "Configure production/preview GITHUB_TOKEN and redeploy.";
	}

	if (
		detail.run.runner === "sandbox-codex" &&
		searchText.includes("codex runner failed before completing postflight")
	) {
		return "Inspect Codex stderr and sandbox network probe events before retrying.";
	}

	if (claim.isExpired === true && (detail.run.status === "running" || detail.run.status === "pending")) {
		return "Run reconciliation; the claim is expired while the run is not terminal.";
	}

	if (detail.run.status === "failed" || detail.run.status === "stale" || detail.run.status === "timed_out") {
		return "Inspect the latest error event and terminal callback data before retrying.";
	}

	if (detail.run.status === "running" || detail.run.status === "pending") {
		return "Monitor the active attempt and claim expiry.";
	}

	return "No immediate operator action is suggested.";
}

function getStringProperty(value: unknown, key: string) {
	if (!value || typeof value !== "object" || !(key in value)) {
		return null;
	}

	const property = (value as Record<string, unknown>)[key];

	return typeof property === "string" && property.trim() ? property : null;
}

function redactDiagnosticText(value: string | null) {
	if (!value) {
		return null;
	}

	return SECRET_REDACTIONS.reduce((text, [pattern, replacement]) => {
		return text.replace(pattern, replacement);
	}, value);
}

function safeStringify(value: unknown) {
	try {
		return JSON.stringify(value);
	} catch {
		return "";
	}
}
