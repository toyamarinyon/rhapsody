import { readFile } from "node:fs/promises";
import path from "node:path";

const RHAPSODY_POST_RUN_CONFIG_PATH = ".rhapsody/config.toml";

export type PostRunDecisionPolicy = {
	auto_merge_eligible: PostRunAutoMergeRule[];
	auto_merge_success_status: string;
	human_review_status: string;
	human_review_monitoring: PostRunHumanReviewMonitoringPolicy;
};

export type PostRunAutoMergeRule = {
	paths: string[];
	description?: string;
};

export type PostRunHumanReviewMonitoringPolicy = {
	enabled: boolean;
	auto_integrate_base_before_human_activity: boolean;
	auto_integrate_base_after_human_activity: boolean;
	comment_on_conflict: boolean;
};

export type PostRunDecisionConfig = {
	post_run: PostRunDecisionPolicy;
};

export type PostRunPolicyLoadResult = {
	config: PostRunDecisionConfig;
	loadedFromPath: string;
	errors: string[];
};

export type PostRunDecisionInput = {
	runStatus: string;
	attemptStatus: string;
	handoffStatus: "ok" | "not_applicable" | "missing_pr" | "failed";
	changedFiles: string[] | null;
	config: PostRunDecisionConfig;
};

export type PostRunDecisionStatusConfig = {
	autoMergeSuccessStatus: string;
	humanReviewStatus: string;
};

export type MatchedPathsSummary = {
	excluded: string[];
	matched: string[];
	unmatched: string[];
};

export type PostRunDecision = {
	action: "auto_merge_candidate" | "human_review";
	reason: string;
	ruleIndex: number | null;
	rulePatterns: string[] | null;
	ruleExcludes: string[] | null;
	matchedPatterns: string[];
	changedPathsSummary: MatchedPathsSummary;
	policyConfigured: boolean;
};

export class PostRunPolicyError extends Error {
	constructor(readonly issues: string[]) {
		super(
			`Invalid post-run decision policy:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
		);
		this.name = "PostRunPolicyError";
	}
}

const DEFAULT_POST_RUN_DECISION_STATUS = {
	auto_merge_success_status: "Done",
	human_review_status: "Human Review",
} satisfies Pick<
	PostRunDecisionPolicy,
	"auto_merge_success_status" | "human_review_status"
>;

const DEFAULT_HUMAN_REVIEW_MONITORING_POLICY: PostRunHumanReviewMonitoringPolicy =
	{
		enabled: true,
		auto_integrate_base_before_human_activity: true,
		auto_integrate_base_after_human_activity: false,
		comment_on_conflict: true,
	};

export async function loadPostRunDecisionConfig(
	projectRoot = process.cwd(),
): Promise<PostRunPolicyLoadResult> {
	const configPath = path.join(projectRoot, RHAPSODY_POST_RUN_CONFIG_PATH);
	const errors: string[] = [];

	try {
		const rawConfig = await readFile(configPath, "utf8");
		const config = parsePostRunDecisionConfig(rawConfig);
		validatePostRunDecisionConfig(config);
		return { config, loadedFromPath: configPath, errors };
	} catch (error) {
		if (error instanceof PostRunPolicyError) {
			throw error;
		}

		if (
			error instanceof Error &&
			(error as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return {
				config: {
					post_run: {
						auto_merge_eligible: [],
						...DEFAULT_POST_RUN_DECISION_STATUS,
						human_review_monitoring: {
							...DEFAULT_HUMAN_REVIEW_MONITORING_POLICY,
						},
					},
				},
				loadedFromPath: configPath,
				errors: [
					"Post-run decision config file is missing; defaulting to conservative review-required policy.",
				],
			};
		}

		throw error;
	}
}

export function parsePostRunDecisionConfig(
	content: string,
): PostRunDecisionConfig {
	const lines = content.split(/\r?\n/);
	const config: PostRunDecisionConfig = {
		post_run: {
			auto_merge_eligible: [],
			...DEFAULT_POST_RUN_DECISION_STATUS,
			human_review_monitoring: {
				...DEFAULT_HUMAN_REVIEW_MONITORING_POLICY,
			},
		},
	};

	let inPostRunSection = false;
	let inAutoMergeRuleSection = false;
	let inHumanReviewMonitoringSection = false;

	for (const rawLine of lines) {
		const trimmed = stripComment(rawLine).trim();

		if (!trimmed) {
			continue;
		}

		if (trimmed === "[post_run]") {
			inPostRunSection = true;
			inAutoMergeRuleSection = false;
			inHumanReviewMonitoringSection = false;
			continue;
		}

		if (trimmed === "[post_run.human_review_monitoring]") {
			inPostRunSection = true;
			inAutoMergeRuleSection = false;
			inHumanReviewMonitoringSection = true;
			continue;
		}

		if (trimmed === "[[post_run.auto_merge_eligible]]") {
			inPostMergeAutoMergeEligibleSection(inPostRunSection);
			inAutoMergeRuleSection = true;
			inHumanReviewMonitoringSection = false;
			config.post_run.auto_merge_eligible.push({
				paths: [],
			});
			continue;
		}

		if (trimmed.startsWith("[[") || trimmed.startsWith("[")) {
			inAutoMergeRuleSection = false;
			inHumanReviewMonitoringSection = false;
			continue;
		}

		if (!inPostRunSection) {
			continue;
		}

		const assignResult = parseKeyValue(trimmed);

		if (!assignResult.ok) {
			throw new PostRunPolicyError([assignResult.error]);
		}

		if (inHumanReviewMonitoringSection) {
			switch (assignResult.key) {
				case "enabled":
					config.post_run.human_review_monitoring.enabled = parseTomlBoolean(
						assignResult.value,
					);
					continue;
				case "auto_integrate_base_before_human_activity":
					config.post_run.human_review_monitoring.auto_integrate_base_before_human_activity =
						parseTomlBoolean(assignResult.value);
					continue;
				case "auto_integrate_base_after_human_activity":
					config.post_run.human_review_monitoring.auto_integrate_base_after_human_activity =
						parseTomlBoolean(assignResult.value);
					continue;
				case "comment_on_conflict":
					config.post_run.human_review_monitoring.comment_on_conflict =
						parseTomlBoolean(assignResult.value);
					continue;
				default:
					throw new PostRunPolicyError([
						`Unknown field '${assignResult.key}' in [post_run.human_review_monitoring].`,
					]);
			}
		}

		if (!inAutoMergeRuleSection) {
			switch (assignResult.key) {
				case "auto_merge_success_status":
					config.post_run.auto_merge_success_status = parseTomlString(
						assignResult.value,
					);
					continue;
				case "human_review_status":
					config.post_run.human_review_status = parseTomlString(
						assignResult.value,
					);
					continue;
				default:
					throw new PostRunPolicyError([
						`Unknown field '${assignResult.key}' in [post_run].`,
					]);
			}
		}

		const rule =
			config.post_run.auto_merge_eligible[
				config.post_run.auto_merge_eligible.length - 1
			];

		switch (assignResult.key) {
			case "paths":
				rule.paths = parseStringArray(assignResult.value);
				break;
			case "description":
				rule.description = parseTomlString(assignResult.value);
				break;
			default:
				throw new PostRunPolicyError([
					`Unknown field '${assignResult.key}' in auto merge rule.`,
				]);
		}
	}

	return config;
}

function inPostMergeAutoMergeEligibleSection(inPostRunSection: boolean) {
	if (!inPostRunSection) {
		throw new PostRunPolicyError([
			"[[post_run.auto_merge_eligible]] must appear inside a [post_run] section.",
		]);
	}
}

function stripComment(input: string): string {
	let inQuotes = false;
	let escaped = false;
	let output = "";

	for (const char of input) {
		if (!inQuotes && char === "#") {
			break;
		}

		if (char === "\\") {
			escaped = !escaped;
			output += char;
			continue;
		}

		if (!escaped && char === '"') {
			inQuotes = !inQuotes;
		}

		output += char;
		escaped = false;
	}

	return output;
}

function parseKeyValue(
	line: string,
): { ok: true; key: string; value: string } | { ok: false; error: string } {
	const keyValue = line.split("=", 2);

	if (keyValue.length !== 2) {
		return { ok: false, error: `Malformed TOML key/value pair: ${line}` };
	}

	const key = keyValue[0]?.trim();
	const value = keyValue[1]?.trim();

	if (!key || !value) {
		return { ok: false, error: `Malformed TOML key/value pair: ${line}` };
	}

	return { ok: true, key, value };
}

function parseTomlString(value: string): string {
	try {
		return JSON.parse(value);
	} catch {
		throw new PostRunPolicyError([`Expected a quoted string, got ${value}.`]);
	}
}

function parseTomlBoolean(value: string): boolean {
	if (value === "true") {
		return true;
	}
	if (value === "false") {
		return false;
	}
	throw new PostRunPolicyError([`Expected a boolean, got ${value}.`]);
}

function parseStringArray(input: string): string[] {
	const match = /^\[(.*)\]$/.exec(input);

	if (!match || !match[1]) {
		throw new PostRunPolicyError([`Expected a string array, got '${input}'.`]);
	}

	const items = splitCsvTopLevel(match[1]);
	const values = items.map((rawItem) => {
		const value = rawItem.trim();

		if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) {
			throw new PostRunPolicyError([
				`Expected quoted string in array, got '${value}'.`,
			]);
		}

		return decodeTomlString(value);
	});

	return values;
}

function decodeTomlString(value: string): string {
	return JSON.parse(value);
}

function splitCsvTopLevel(input: string): string[] {
	const items: string[] = [];
	let inQuotes = false;
	let current = "";
	let escaped = false;

	for (const char of input) {
		if (char === "," && !inQuotes) {
			if (current.trim()) {
				items.push(current.trim());
			}
			current = "";
			continue;
		}

		if (char === '"') {
			if (!escaped) {
				inQuotes = !inQuotes;
			}
			escaped = false;
			current += char;
			continue;
		}

		if (char === "\\") {
			escaped = !escaped;
			current += char;
			continue;
		}

		current += char;
		escaped = false;
	}

	if (current.trim()) {
		items.push(current.trim());
	}

	return items.filter((item) => item.length > 0);
}

function validatePostRunDecisionConfig(config: PostRunDecisionConfig) {
	const issues: string[] = [];

	if (!Array.isArray(config.post_run.auto_merge_eligible)) {
		issues.push("post_run.auto_merge_eligible must be an array.");
	}

	if (
		typeof config.post_run.auto_merge_success_status !== "string" ||
		!config.post_run.auto_merge_success_status.trim()
	) {
		issues.push(
			"post_run.auto_merge_success_status must be a non-empty string.",
		);
	}

	if (
		typeof config.post_run.human_review_status !== "string" ||
		!config.post_run.human_review_status.trim()
	) {
		issues.push("post_run.human_review_status must be a non-empty string.");
	}

	const monitoring = config.post_run.human_review_monitoring;
	if (!monitoring || typeof monitoring !== "object") {
		issues.push("post_run.human_review_monitoring must be an object.");
	} else {
		requireBoolean(
			issues,
			"post_run.human_review_monitoring.enabled",
			monitoring.enabled,
		);
		requireBoolean(
			issues,
			"post_run.human_review_monitoring.auto_integrate_base_before_human_activity",
			monitoring.auto_integrate_base_before_human_activity,
		);
		requireBoolean(
			issues,
			"post_run.human_review_monitoring.auto_integrate_base_after_human_activity",
			monitoring.auto_integrate_base_after_human_activity,
		);
		requireBoolean(
			issues,
			"post_run.human_review_monitoring.comment_on_conflict",
			monitoring.comment_on_conflict,
		);
	}

	for (const [index, rule] of config.post_run.auto_merge_eligible.entries()) {
		if (!Array.isArray(rule.paths) || rule.paths.length === 0) {
			issues.push(
				`post_run.auto_merge_eligible[${index}].paths must be a non-empty array.`,
			);
			continue;
		}

		if (
			!rule.paths.every(
				(pathPattern) => typeof pathPattern === "string" && pathPattern.trim(),
			)
		) {
			issues.push(
				`post_run.auto_merge_eligible[${index}].paths must contain only non-empty strings.`,
			);
		}
	}

	if (issues.length > 0) {
		throw new PostRunPolicyError(issues);
	}
}

export function getPostRunStatusConfig(
	config: PostRunDecisionConfig,
): PostRunDecisionStatusConfig {
	return {
		autoMergeSuccessStatus: config.post_run.auto_merge_success_status,
		humanReviewStatus: config.post_run.human_review_status,
	};
}

function requireBoolean(issues: string[], field: string, value: boolean) {
	if (typeof value !== "boolean") {
		issues.push(`${field} must be a boolean.`);
	}
}

export function evaluatePostRunDecision(
	input: PostRunDecisionInput,
): PostRunDecision {
	const { runStatus, attemptStatus, handoffStatus, changedFiles, config } =
		input;
	const policyConfigured = config.post_run.auto_merge_eligible.length > 0;

	if (runStatus !== "completed" || attemptStatus !== "completed") {
		return {
			action: "human_review",
			reason: `Conservative default retained: terminal status was ${runStatus}/${attemptStatus}, not eligible for auto-merge.`,
			ruleIndex: null,
			rulePatterns: null,
			ruleExcludes: null,
			matchedPatterns: [],
			changedPathsSummary: {
				excluded: [],
				matched: [],
				unmatched: changedFiles ?? [],
			},
			policyConfigured,
		};
	}

	if (handoffStatus !== "ok") {
		return {
			action: "human_review",
			reason:
				handoffStatus === "missing_pr"
					? "No pull request was produced by handoff, so review is required."
					: `Post-run handoff was not completed successfully: ${handoffStatus}.`,
			ruleIndex: null,
			rulePatterns: null,
			ruleExcludes: null,
			matchedPatterns: [],
			changedPathsSummary: {
				excluded: [],
				matched: [],
				unmatched: changedFiles ?? [],
			},
			policyConfigured,
		};
	}

	if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
		return {
			action: "human_review",
			reason:
				"No changed file list was available from runner postflight; auto-merge is intentionally disabled.",
			ruleIndex: null,
			rulePatterns: null,
			ruleExcludes: null,
			matchedPatterns: [],
			changedPathsSummary: { excluded: [], matched: [], unmatched: [] },
			policyConfigured,
		};
	}

	for (
		let ruleIndex = 0;
		ruleIndex < config.post_run.auto_merge_eligible.length;
		ruleIndex += 1
	) {
		const rule = config.post_run.auto_merge_eligible[ruleIndex];
		const summary = evaluateRule(rule, changedFiles);
		const ruleNegatives = collectRuleNegativePatterns(rule.paths);
		const matchedRulePatterns = rule.paths.filter(
			(pathPattern) => !pathPattern.trim().startsWith("!"),
		);

		if (summary.isMatch) {
			return {
				action: "auto_merge_candidate",
				reason: `Auto-merge policy matched rule ${ruleIndex}; all changed paths were eligible.`,
				ruleIndex,
				rulePatterns: matchedRulePatterns,
				ruleExcludes: ruleNegatives,
				matchedPatterns: matchedRulePatterns,
				changedPathsSummary: summary,
				policyConfigured,
			};
		}

		// Any unmatched path means the rule does not provide an eligible auto-merge candidate.
	}

	return {
		action: "human_review",
		reason: "No auto-merge policy rule matched all changed paths.",
		ruleIndex: null,
		rulePatterns: null,
		ruleExcludes: null,
		matchedPatterns: [],
		changedPathsSummary: evaluateRule(
			config.post_run.auto_merge_eligible.at(-1) ?? { paths: [] },
			changedFiles,
		),
		policyConfigured,
	};
}

type RuleMatchSummary = {
	isMatch: boolean;
	matched: string[];
	unmatched: string[];
	excluded: string[];
};

function evaluateRule(
	rule: PostRunAutoMergeRule,
	changedPaths: string[],
): RuleMatchSummary {
	const includes = splitRulePatterns(rule.paths);
	const summary: RuleMatchSummary = {
		excluded: [],
		matched: [],
		unmatched: [],
		isMatch: false,
	};

	for (const changedPath of changedPaths) {
		const normalizedPath = changedPath.replace(/^\.\/+/, "");
		let matchesPositive = false;
		let isExplicitlyExcluded = false;

		for (const pattern of includes.include) {
			if (matchGlob(normalizedPath, pattern)) {
				matchesPositive = true;
			}
		}

		for (const pattern of includes.exclude) {
			if (matchGlob(normalizedPath, pattern)) {
				isExplicitlyExcluded = true;
			}
		}

		if (isExplicitlyExcluded) {
			summary.excluded.push(normalizedPath);
			continue;
		}

		if (matchesPositive) {
			summary.matched.push(normalizedPath);
			continue;
		}

		summary.unmatched.push(normalizedPath);
	}

	summary.isMatch =
		summary.unmatched.length === 0 &&
		summary.excluded.length === 0 &&
		summary.matched.length > 0;

	return summary;
}

function collectRuleNegativePatterns(includes: string[]): string[] {
	const includeNegatives = includes
		.filter((pattern) => pattern.trim().startsWith("!"))
		.map((pattern) => pattern.trim().slice(1).trim())
		.filter((pattern) => pattern.length > 0);

	return includeNegatives;
}

function matchGlob(filePath: string, pattern: string): boolean {
	const regexSource = "^" + globToRegex(pattern) + "$";
	return new RegExp(regexSource).test(filePath);
}

type RulePatternGroups = {
	include: string[];
	exclude: string[];
};

function splitRulePatterns(includes: string[]): RulePatternGroups {
	const includePatterns = includes.filter((pattern) => pattern.trim());
	const normalizedPatterns = includePatterns.map((pattern) => pattern.trim());
	const inRuleExcludes = normalizedPatterns
		.filter((pattern) => pattern.startsWith("!"))
		.map((pattern) => pattern.slice(1).trim())
		.filter((pattern) => pattern.length > 0);
	const includesOnly = normalizedPatterns.filter(
		(pattern) => !pattern.startsWith("!"),
	);

	return {
		include: includesOnly,
		exclude: inRuleExcludes,
	};
}

function globToRegex(pattern: string): string {
	let i = 0;
	let output = "";

	while (i < pattern.length) {
		const char = pattern[i];
		if (char === "*") {
			if (pattern[i + 1] === "*") {
				output += ".*";
				i += 2;
				continue;
			}
			output += "[^/]*";
			i += 1;
			continue;
		}

		if (char === "?") {
			output += "[^/]";
			i += 1;
			continue;
		}

		if ("+^$.()|{}[]\\".includes(char)) {
			output += `\\${char}`;
			i += 1;
			continue;
		}

		output += char;
		i += 1;
	}

	return output;
}
