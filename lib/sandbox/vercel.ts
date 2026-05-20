import { Sandbox, type NetworkPolicy, type NetworkPolicyRule } from "@vercel/sandbox";

import { loadRhapsodySandboxEnv } from "@/lib/config";

export type VercelSandboxFile = {
	path: string;
	content: Buffer | string | Uint8Array;
	mode?: number;
};

export type VercelSandboxRunCommandInput = {
	cmd: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
};

export type VercelSandboxCommandSummary = {
	commandId: string;
	cwd: string;
	startedAt: number;
	exitCode: number;
	stdout: string;
	stderr: string;
};

export type VercelSandboxSnapshot = {
	snapshotId: string;
	sourceSandboxId: string;
	status: string;
	sizeBytes: number;
	createdAt: number;
	expiresAt?: number;
};

export type VercelSandboxSnapshotSource = {
	type: "snapshot";
	snapshotId: string;
};

export type CreateVercelSandboxInput = {
	source?: VercelSandboxSnapshotSource;
	runtime?: string;
	timeout?: number;
	env?: Record<string, string>;
	networkPolicy?: NetworkPolicy;
};

export type RhapsodyVercelSandbox = Awaited<ReturnType<typeof Sandbox.create>>;
export type WithVercelSandboxOptions = CreateVercelSandboxInput & {
	stop?: boolean;
};

const DEFAULT_SANDBOX_RUNTIME = "node24";
// updateNetworkPolicy resolves when the API accepts the policy, but local probes
// showed the sandbox dataplane can take a few seconds before forwardURL rules
// are actually applied to commands running inside the sandbox.
const NETWORK_POLICY_PROPAGATION_DELAY_MS = 8_000;

export function mergeNetworkPolicies(...policies: NetworkPolicy[]): NetworkPolicy {
	if (policies.some((policy) => policy === "allow-all")) {
		return "allow-all";
	}

	const allowedPolicy = policies.filter(isAllowNetworkPolicy);
	const allow = allowedPolicy.reduce(
		(acc, policy) => {
			for (const [host, rules] of Object.entries(policy.allow)) {
				acc[host] = [...(acc[host] ?? []), ...rules];
			}

			return acc;
		},
		{} as Record<string, NetworkPolicyRule[]>,
	);

	return { allow };
}

function isAllowNetworkPolicy(
	policy: NetworkPolicy,
): policy is { allow: Record<string, NetworkPolicyRule[]> } {
	return typeof policy === "object";
}

export function buildVercelSandboxCallbackNetworkPolicy(args: {
	callbackUrl: string;
	mediatorSecret: string;
	vercelProtectionBypassSecret?: string;
}): NetworkPolicy {
	const callbackHost = new URL(args.callbackUrl).hostname;
	const headers = {
		"x-rhapsody-mediator-secret": args.mediatorSecret,
		...(args.vercelProtectionBypassSecret
			? { "x-vercel-protection-bypass": args.vercelProtectionBypassSecret }
			: {}),
	};

	return {
		allow: {
			[callbackHost]: [
				{
					transform: [
						{
							headers,
						},
					],
				},
			],
		},
	};
}

export function buildVercelSandboxGitHubNetworkPolicy(args: {
	githubToken: string;
	authorizationHeaderPrefix?: "token" | "bearer" | "basic";
}): NetworkPolicy {
	// WARNING: Broad github.com + *.github.com + api.github.com header transform is
	// exploratory for smoke testing and is not the final mediator model for
	// agent-scoped writes.
	const tokenHeaderPrefix = args.authorizationHeaderPrefix ?? "basic";
	const authorizationValue = buildTokenAuthorizationHeader(
		tokenHeaderPrefix,
		args.githubToken,
	);

	return {
		allow: {
			"github.com": buildAuthorizationTransformRule(authorizationValue),
			"*.github.com": buildAuthorizationTransformRule(authorizationValue),
			"api.github.com": buildAuthorizationTransformRule(authorizationValue),
		},
	};
}

function buildAuthorizationTransformRule(authorizationValue: string): NetworkPolicyRule[] {
	return [
		{
			transform: [
				{
					headers: {
						Authorization: authorizationValue,
					},
				},
			],
		},
	];
}

function buildTokenAuthorizationHeader(prefix: "token" | "bearer" | "basic", githubToken: string) {
	if (prefix === "basic") {
		return `Basic ${Buffer.from(`x-access-token:${githubToken}`, "utf8").toString("base64")}`;
	}

	return `${prefix} ${githubToken}`;
}

export function buildVercelSandboxCodexNetworkPolicy(args: {
	callbackUrl: string;
	codexProxyUrl: string;
	mediatorSecret: string;
	vercelProtectionBypassSecret?: string;
	proxyChatGPTAccountApi?: boolean;
}): NetworkPolicy {
	const callbackHost = new URL(args.callbackUrl).hostname;
	const mediatorHeaders = {
		"x-rhapsody-mediator-secret": args.mediatorSecret,
		...(args.vercelProtectionBypassSecret
			? { "x-vercel-protection-bypass": args.vercelProtectionBypassSecret }
			: {}),
	};
	const allow: Record<string, NetworkPolicyRule[]> = {
		[callbackHost]: [
			{
				transform: [{ headers: mediatorHeaders }],
			},
		],
		"chatgpt.com": [
			{
				forwardURL: args.codexProxyUrl,
				match: { path: { startsWith: "/backend-api/" } },
			},
		],
		"auth.openai.com": [
			{
				forwardURL: args.codexProxyUrl,
				match: {
					path: { startsWith: "/oauth/token" },
					method: ["POST"],
				},
			},
		],
	};

	if (args.proxyChatGPTAccountApi) {
		allow["api.openai.com"] = [
			{
				forwardURL: args.codexProxyUrl,
				match: { path: { startsWith: "/" } },
			},
		];
	}

	return {
		allow,
	};
}

export async function createVercelSandbox(input: CreateVercelSandboxInput = {}) {
	const env = loadRhapsodySandboxEnv();
	const credentials = env
		? {
				token: env.VERCEL_TOKEN,
				teamId: env.VERCEL_TEAM_ID,
				projectId: env.VERCEL_PROJECT_ID,
			}
		: {};

	const sandbox = await Sandbox.create({
		...credentials,
		...(input.source ? { source: input.source } : { runtime: input.runtime ?? DEFAULT_SANDBOX_RUNTIME }),
		timeout: input.timeout,
		env: input.env,
		networkPolicy: input.networkPolicy ? "allow-all" : undefined,
	});

	if (input.networkPolicy) {
		await sandbox.updateNetworkPolicy(input.networkPolicy);
		await delay(NETWORK_POLICY_PROPAGATION_DELAY_MS);
	}

	return sandbox;
}

function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function writeVercelSandboxFiles(sandbox: RhapsodyVercelSandbox, files: VercelSandboxFile[]) {
	await sandbox.writeFiles(files);
}

export async function runVercelSandboxCommand(
	sandbox: RhapsodyVercelSandbox,
	input: VercelSandboxRunCommandInput,
): Promise<VercelSandboxCommandSummary> {
	const command = await sandbox.runCommand({
		cmd: input.cmd,
		args: input.args,
		cwd: input.cwd,
		env: input.env,
	});
	const [stdout, stderr] = await Promise.all([command.stdout(), command.stderr()]);

	return {
		commandId: command.cmdId,
		cwd: command.cwd,
		startedAt: command.startedAt,
		exitCode: command.exitCode,
		stdout,
		stderr,
	};
}

export function getVercelSandboxId(sandbox: RhapsodyVercelSandbox) {
	return sandbox.name;
}

export async function createVercelSandboxSnapshot(sandbox: RhapsodyVercelSandbox) {
	const snapshot = await sandbox.snapshot();

	return {
		snapshotId: snapshot.snapshotId,
		sourceSandboxId: snapshot.sourceSessionId,
		status: snapshot.status,
		sizeBytes: snapshot.sizeBytes,
		createdAt: snapshot.createdAt.getTime(),
		expiresAt: snapshot.expiresAt?.getTime(),
	} satisfies VercelSandboxSnapshot;
}

export async function stopVercelSandbox(sandbox: RhapsodyVercelSandbox) {
	await sandbox.stop();
}

export async function withVercelSandbox<TResult>(
	input: WithVercelSandboxOptions,
	run: (sandbox: RhapsodyVercelSandbox) => Promise<TResult>,
) {
	const sandbox = await createVercelSandbox(input);

	try {
		return await run(sandbox);
	} finally {
		if (input.stop !== false) {
			await stopVercelSandbox(sandbox);
		}
	}
}
