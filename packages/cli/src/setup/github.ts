import { spawnSync } from "node:child_process";

import type { SyncCommandResult } from "./types.js";

export function getCreateFirstIssueRepository(): string | null {
	const remoteUrl = readGitRemoteOriginUrl();
	return normalizeGitRemoteTarget(remoteUrl);
}

export function readGitRemoteOriginUrl() {
	const result = run(["git", "config", "--get", "remote.origin.url"]);
	return result.ok ? result.stdout.trim() : null;
}

export function normalizeGitRemoteTarget(remote: string | null) {
	const trimmed = remote?.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("http")) {
		const match = trimmed.match(/github\.com\/([^/]+\/[^/?#]+)/);
		if (match) return normalizeGithubOwnerRepo(match[1]);
		return trimmed;
	}
	if (/^git@github\.com:/.test(trimmed)) {
		const match = trimmed.match(/^git@github\.com:([^/]+\/.+)$/);
		if (match) return normalizeGithubOwnerRepo(match[1]);
		return trimmed;
	}
	return trimmed;
}

export function normalizeGithubOwnerRepo(value: string) {
	return value.replace(/\.git$/, "");
}

export function collectCreateFirstIssueGhChecks({
	repository,
}: {
	repository: string | null;
}): string[] {
	const blockers: string[] = [];
	const ghVersion = run(["gh", "--version"]);
	const ghToken = run(["gh", "auth", "token"]);

	if (!ghVersion.ok) {
		blockers.push(
			"Install the GitHub CLI (`gh`) before setup can create the first issue.",
		);
	}
	if (!ghToken.ok || !ghToken.stdout.trim()) {
		blockers.push(
			"Run `gh auth login` before setup can create the first issue.",
		);
	}
	if (ghVersion.ok && ghToken.ok && ghToken.stdout.trim() && repository) {
		const repoCheck = run(["gh", "repo", "view", repository]);
		if (!repoCheck.ok) {
			blockers.push(
				`Cannot read repository ${repository}; verify gh access and repository owner permissions.`,
			);
		}
	}

	return blockers;
}

export function parseIssueCreateCommandOutput(stdout: string):
	| {
			ok: false;
			error: string;
	  }
	| {
			ok: true;
			issueUrl: string;
			issueNumber: number;
	  } {
	const matched = stdout
		.trim()
		.split(/\r?\n/)
		.find((line) =>
			/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+/.test(line),
		);
	if (!matched) {
		return {
			ok: false,
			error: "gh issue create did not print a parseable issue URL.",
		};
	}
	const issueNumberMatch = matched.match(/\/issues\/(\d+)(?:$|[/?#])/);
	const issueNumberText = issueNumberMatch?.[1];
	if (!issueNumberText) {
		return {
			ok: false,
			error: "gh issue create returned an unexpected issue URL.",
		};
	}
	const issueNumber = Number.parseInt(issueNumberText, 10);
	if (!Number.isInteger(issueNumber)) {
		return {
			ok: false,
			error: "gh issue create returned a non-numeric issue number.",
		};
	}
	return {
		ok: true,
		issueUrl: matched,
		issueNumber,
	};
}

export function runGithubCommand(argv: string[]): SyncCommandResult {
	return run(argv);
}

function run(command: string[]): SyncCommandResult {
	const result = spawnSync(command[0], command.slice(1), {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		ok: result.status === 0,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}
