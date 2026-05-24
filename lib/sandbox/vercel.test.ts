import { expect, test } from "vitest";

import {
	buildVercelSandboxCodexNetworkPolicy,
	buildVercelSandboxDependencyNetworkPolicy,
	buildVercelSandboxGitHubNetworkPolicy,
	mergeNetworkPolicies,
} from "./vercel";

function expectAllowPolicy(policy: ReturnType<typeof mergeNetworkPolicies>) {
	if (
		policy === "allow-all" ||
		policy === "deny-all" ||
		typeof policy.allow !== "object" ||
		Array.isArray(policy.allow) ||
		!policy.allow
	) {
		throw new Error("Expected allowlist network policy.");
	}

	return policy as { allow: Record<string, unknown[]> };
}

test("builds dependency network policy with unique hosts", () => {
	const policy = expectAllowPolicy(
		buildVercelSandboxDependencyNetworkPolicy([
			"registry.npmjs.org",
			"registry.npmjs.org",
			"*.registry.npmjs.org",
		]),
	);

	const hosts = Object.keys(policy.allow);

	expect(hosts).toHaveLength(2);
	expect(hosts).toContain("registry.npmjs.org");
	expect(hosts).toContain("*.registry.npmjs.org");
});

test("merges dependency network policy with codex and github policies", () => {
	const merged = expectAllowPolicy(
		mergeNetworkPolicies(
			buildVercelSandboxCodexNetworkPolicy({
				callbackUrl: "https://app.example/callback",
				mediatorSecret: "secret",
				codexProxyUrl: "https://chatgpt.com",
				proxyChatGPTAccountApi: false,
			}),
			buildVercelSandboxGitHubNetworkPolicy({ githubToken: "token" }),
			buildVercelSandboxDependencyNetworkPolicy(["registry.npmjs.org"]),
		),
	);

	expect(merged.allow["registry.npmjs.org"]).toEqual([]);
	expect(merged.allow["github.com"]?.length).toBe(1);
	expect(merged.allow["chatgpt.com"]?.length).toBe(1);
});
