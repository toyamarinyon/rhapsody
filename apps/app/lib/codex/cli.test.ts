import { expect, test } from "vitest";
import { buildCodexExecCommand } from "@/lib/codex/cli";

test("buildCodexExecCommand includes --output-schema when configured", () => {
	const command = buildCodexExecCommand({
		cwd: "/workspace/project",
		prompt: "classify",
		outputSchemaFile: "/tmp/schema.json",
		json: true,
	});

	expect(command.execArgv).toContain("--output-schema");
	expect(command.execArgv).toContain("/tmp/schema.json");
});
