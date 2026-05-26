import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

test("wrapper rejects unrelated files changed by conflict resolver", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "rhapsody-wrapper-"));
	const originPath = path.join(directory, "origin.git");
	const seedPath = path.join(directory, "seed");
	const repositoryPath = path.join(directory, "repository");
	const fakeCodexPath = path.join(directory, "fake-codex.cjs");
	const metadataPath = path.join(directory, "metadata.json");
	const promptPath = path.join(directory, "prompt.txt");
	const wrapperPath = path.resolve(
		"lib",
		"workers",
		"integration-repair",
		"wrapper.cjs",
	);

	try {
		git(["init", "--bare", originPath], directory);
		git(["init", seedPath], directory);
		git(["config", "user.name", "Test User"], seedPath);
		git(["config", "user.email", "test@example.com"], seedPath);
		writeFileSync(path.join(seedPath, "conflict.txt"), "initial\n");
		git(["add", "conflict.txt"], seedPath);
		git(["commit", "-m", "initial"], seedPath);
		git(["branch", "-M", "main"], seedPath);
		git(["remote", "add", "origin", originPath], seedPath);
		git(["push", "-u", "origin", "main"], seedPath);

		git(["checkout", "-b", "feature"], seedPath);
		writeFileSync(path.join(seedPath, "conflict.txt"), "feature\n");
		git(["commit", "-am", "feature change"], seedPath);
		git(["push", "-u", "origin", "feature"], seedPath);

		git(["checkout", "main"], seedPath);
		writeFileSync(path.join(seedPath, "conflict.txt"), "main\n");
		git(["commit", "-am", "main change"], seedPath);
		git(["push", "origin", "main"], seedPath);

		writeFileSync(
			fakeCodexPath,
			[
				"const { execFileSync } = require('node:child_process');",
				"const { writeFileSync } = require('node:fs');",
				"writeFileSync('conflict.txt', 'resolved\\n');",
				"writeFileSync('unrelated.txt', 'unexpected\\n');",
				"execFileSync('git', ['add', 'conflict.txt']);",
			].join("\n"),
		);
		writeFileSync(promptPath, "resolve conflict");
		writeFileSync(
			metadataPath,
			JSON.stringify(
				{
					owner: "toyamarinyon",
					repository: "rhapsody",
					repositoryPath,
					repositoryUrl: `file://${originPath}`,
					headRef: "feature",
					baseRef: "main",
					commitMessage: "merge main",
					codexTimeoutMs: 10_000,
					codexCommand: {
						command: process.execPath,
						argv: [fakeCodexPath],
						cwd: repositoryPath,
					},
				},
				null,
				2,
			),
		);

		const result = spawnSync(process.execPath, [wrapperPath], {
			cwd: directory,
			env: {
				...process.env,
				RHAPSODY_METADATA_PATH: metadataPath,
				RHAPSODY_PROMPT_PATH: promptPath,
			},
			encoding: "utf8",
		});

		expect(result.status).toBe(0);
		const output = JSON.parse(result.stdout);
		expect(output).toEqual(
			expect.objectContaining({
				ok: false,
				outcome: "integration_repair_conflict_unresolved",
				unexpectedChangedFiles: ["unrelated.txt"],
			}),
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

function git(args: string[], cwd: string) {
	execFileSync("git", args, {
		cwd,
		stdio: "pipe",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test User",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test User",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
	});
}
