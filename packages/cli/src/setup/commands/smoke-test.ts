#!/usr/bin/env node
import type {
	ParseSetupSmokeTestResult,
	SmokeClassification,
	SetupSmokeResult,
	LegacyExitCode,
} from "../types.js";
import { normalizeBaseUrl, runSmokeCheck } from "../http.js";
import { resolveRootPasswordForSmoke } from "../env.js";
import { getSetupStatePath, recordSetupState } from "../state.js";
import { printSetupSmokeTest } from "./status.js";

export async function runSmokeTestCommand(
	args: string[],
): Promise<LegacyExitCode> {
	const parse = parseSetupSmokeTestArgs(args);
	if (parse.ok === false) {
		console.error(parse.error);
		process.exit(1);
	}

	await runSetupSmokeTest({
		url: parse.url,
		json: parse.json,
		useRootPassword: parse.useRootPassword,
	}).catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
	return 0;
}

function parseSetupSmokeTestArgs(args: string[]): ParseSetupSmokeTestResult {
	if (args.includes("--help") || args.includes("-h")) {
		return {
			ok: false,
			error:
				"Usage: rhapsody setup smoke-test --url <preview-url> [--json] [--use-root-password]",
		};
	}

	let url = null;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "smoke-test") continue;
		if (arg === "--url") {
			const value = args[i + 1];
			if (!value || value.startsWith("--")) {
				return { ok: false, error: "Missing value for --url." };
			}
			url = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--url=")) {
			url = arg.slice("--url=".length);
			continue;
		}
		if (arg === "--json" || arg === "--use-root-password") continue;
		return { ok: false, error: `Unsupported argument: ${arg}` };
	}

	if (!url) {
		return {
			ok: false,
			error:
				"Missing required --url argument. Example: rhapsody setup smoke-test --url https://preview-url.vercel.app",
		};
	}

	return {
		ok: true,
		url,
		json: args.includes("--json"),
		useRootPassword: args.includes("--use-root-password"),
	};
}

async function runSetupSmokeTest({
	url,
	json,
	useRootPassword,
}: {
	url: string;
	json: boolean;
	useRootPassword: boolean;
}) {
	const statePath = getSetupStatePath();
	const start = Date.now();
	let baseUrlValue: string;
	try {
		baseUrlValue = normalizeBaseUrl(url);
	} catch {
		const result: SetupSmokeResult = {
			ok: false,
			phase: "smoke-test",
			baseUrl: url,
			statePath,
			checks: [],
			rootPassword: {
				requested: useRootPassword,
				available: false,
				source: "missing",
			},
			blockers: ["Invalid --url value."],
			nextActions: [
				"Use --url with a valid absolute URL, for example: https://preview.vercel.app",
			],
			elapsedMs: Date.now() - start,
		};
		recordSetupState({
			command: "smoke-test",
			baseUrl: url,
			checks: [],
			rootPassword: {
				requested: useRootPassword,
				available: false,
				source: "missing",
			},
			blockers: result.blockers,
			nextActions: result.nextActions,
			nextAction: "blocked",
		});
		printSetupSmokeTest({ json, result });
		process.exit(1);
		return;
	}

	const baseUrl = `${baseUrlValue}/`;
	const loginUrl = `${baseUrlValue}/login`;
	const dashboardUrl = `${baseUrlValue}/dashboard`;
	const stateUrl = `${baseUrlValue}/api/v1/state`;

	const password = resolveRootPasswordForSmoke();
	const rootPassword = {
		requested: useRootPassword,
		available: Boolean(password),
		source: password?.source ?? "missing",
	};

	const checks: Array<{
		name: string;
		url: string;
		status: number | null;
		classification: SmokeClassification;
		ok: boolean;
	}> = [];
	const baseCheck = await runSmokeCheck({ name: "base-url", url: baseUrl });
	const loginCheck = await runSmokeCheck({ name: "login-path", url: loginUrl });
	const dashboardCheck = await runSmokeCheck({
		name: "dashboard-path",
		url: dashboardUrl,
	});
	const stateCheck = await runSmokeCheck({ name: "state-path", url: stateUrl });
	const authStateRequestedCheck =
		useRootPassword && password
			? await runSmokeCheck({
					name: "state-path-authenticated",
					url: stateUrl,
					headers: {
						Authorization: `Bearer ${password.value}`,
					},
				})
			: null;
	checks.push(baseCheck, loginCheck, dashboardCheck, stateCheck);
	if (authStateRequestedCheck) {
		checks.push(authStateRequestedCheck);
	}

	const loginOrDashboardReachable =
		(loginCheck.ok && loginCheck.classification !== "network-error") ||
		(dashboardCheck.ok && dashboardCheck.classification !== "network-error");
	const blockers: string[] = [];
	const nextActions: string[] = [];

	if (baseCheck.classification === "network-error") {
		blockers.push("Base URL is not reachable.");
	}
	if (!loginOrDashboardReachable) {
		blockers.push("Both /login and /dashboard are unreachable.");
	}
	if (
		stateCheck.classification === "network-error" ||
		stateCheck.classification === "admin-auth-missing"
	) {
		blockers.push("/api/v1/state is not reachable or is missing admin auth.");
	}
	if (useRootPassword && !password) {
		blockers.push(
			"ROOT_PASSWORD was requested but not found in process env or apps/app/.env.local.",
		);
	}

	if (blockers.length === 0) {
		nextActions.push(
			"Smoke test passed. Continue setup and move to the next phase.",
		);
	} else {
		if (baseCheck.classification === "network-error") {
			nextActions.push(
				"Confirm the preview URL is accessible from this environment and rerun smoke-test.",
			);
		}
		if (!loginOrDashboardReachable) {
			nextActions.push(
				"Confirm /login or /dashboard routes exist on the deployment and rerun smoke-test.",
			);
		}
		if (
			stateCheck.classification === "network-error" ||
			stateCheck.classification === "admin-auth-missing"
		) {
			nextActions.push(
				"Confirm /api/v1/state is deployed and rerun smoke-test.",
			);
		}
		if (useRootPassword && !password) {
			nextActions.push(
				"Provide ROOT_PASSWORD in environment or apps/app/.env.local and rerun with --use-root-password.",
			);
		}
	}
	if (useRootPassword && password) {
		nextActions.push(
			"Authenticated state path check was attempted with --use-root-password.",
		);
	}

	const result: SetupSmokeResult = {
		ok: blockers.length === 0,
		phase: "smoke-test",
		baseUrl,
		statePath,
		checks: checks.map((check) => ({
			name: check.name,
			url: check.url,
			status: check.status,
			classification: check.classification,
			ok: check.ok,
		})),
		rootPassword,
		blockers,
		nextActions,
		elapsedMs: Date.now() - start,
	};

	recordSetupState({
		command: "smoke-test",
		baseUrl,
		statePath,
		checks: result.checks.map((check) => ({
			name: check.name,
			status: check.status,
			classification: check.classification,
		})),
		rootPassword,
		nextAction: result.ok ? "complete" : "blocked",
		blockers,
		nextActions,
	});
	printSetupSmokeTest({ json, result });
	process.exit(result.ok ? 0 : 1);
}
