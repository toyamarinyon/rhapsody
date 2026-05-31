import { expect, test } from "vitest";
import { summarizeAuthResult } from "@/scripts/setup-rhapsody-inspect";

test("summarizes failed gh auth status with the first diagnostic line", () => {
	expect(
		summarizeAuthResult(
			{
				status: 1,
				signal: null,
				output: [],
				pid: 123,
				stdout: "",
				stderr:
					"github.com\n  X github.com: authentication failed\n  - Run `gh auth login` to authenticate\n",
			},
			"gh auth status",
			10_000,
		),
	).toBe("X github.com: authentication failed");
});
