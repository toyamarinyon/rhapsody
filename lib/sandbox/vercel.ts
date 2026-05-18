import { Sandbox, type NetworkPolicy } from "@vercel/sandbox";

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

export type CreateVercelSandboxInput = {
	runtime?: string;
	env?: Record<string, string>;
	networkPolicy?: NetworkPolicy;
};

export type RhapsodyVercelSandbox = Awaited<ReturnType<typeof Sandbox.create>>;
export type WithVercelSandboxOptions = CreateVercelSandboxInput & {
	stop?: boolean;
};

const DEFAULT_SANDBOX_RUNTIME = "node24";

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

export async function createVercelSandbox(input: CreateVercelSandboxInput = {}) {
	const env = loadRhapsodySandboxEnv();

	return Sandbox.create({
		...(env
			? {
					token: env.VERCEL_TOKEN,
					teamId: env.VERCEL_TEAM_ID,
					projectId: env.VERCEL_PROJECT_ID,
				}
			: {}),
		runtime: input.runtime ?? DEFAULT_SANDBOX_RUNTIME,
		env: input.env,
		networkPolicy: input.networkPolicy,
	});
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

export async function stopVercelSandbox(sandbox: RhapsodyVercelSandbox) {
	await sandbox.stop({ blocking: true });
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
