import { expect, test } from "vitest";
import { parseRepairConfig } from "./repair-config";

test("parses format repair rules from .rhapsody/config.toml", () => {
	const config = parseRepairConfig(`
[repair]

[[repair.format_checks]]
workflow_path = ".github/workflows/ci.yml"
job_name = "Static checks"
step_names = ["Format check", "Format"]

[post_run]
human_review_status = "Human Review"
`);

	expect(config).toEqual({
		repair: {
			format_checks: [
				{
					workflowPath: ".github/workflows/ci.yml",
					jobName: "Static checks",
					stepNames: [
						"Format check", "Format" ],
				},
			],
		},
	});
});
