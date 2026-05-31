#!/usr/bin/env node
import { waitForEnv, resolveRootPasswordForSmoke, readDotEnv } from "../env.js";
import type {
	ParseResult,
	ParseSetupWaitEnvResult,
	LegacyExitCode,
} from "../types.js";
import { recordSetupState } from "../state.js";
import { collectSetupStatus, printWaitEnvResult } from "./status.js";

export async function runWaitEnvCommand(
	args: string[],
): Promise<LegacyExitCode> {
	const parse = parseWaitEnvArgs(args);
	if (parse.ok === false) {
		console.error(parse.error);
		process.exit(1);
	}
	const result = waitForEnv({
		ok: true,
		json: parse.json,
		timeoutSeconds: parse.timeoutSeconds,
		intervalSeconds: parse.intervalSeconds,
		statusProvider: collectSetupStatus,
	});
	recordWaitEnvSetupState(result);
	printWaitEnvResult({ json: parse.json, result });
	process.exit(result.ok ? 0 : 1);
}

function parseWaitEnvArgs(args: string[]): ParseSetupWaitEnvResult {
	const timeoutResult = parseTimeoutFlag(args);
	if (isParseFailure(timeoutResult)) {
		return { ok: false, error: timeoutResult.error };
	}
	const intervalResult = parseIntervalFlag(args);
	if (isParseFailure(intervalResult)) {
		return { ok: false, error: intervalResult.error };
	}
	if (args.includes("--help") || args.includes("-h")) {
		return {
			ok: false,
			error:
				"Usage: rhapsody wait-env [--json] [--timeout <seconds>] [--interval <seconds>]",
		};
	}
	return {
		ok: true,
		json: args.includes("--json"),
		timeoutSeconds: timeoutResult.value,
		intervalSeconds: intervalResult.value,
	};
}

function parseTimeoutFlag(args: string[]): ParseResult<{ value: number }> {
	return parseIntegerSecondsFlag({
		args,
		name: "--timeout",
		defaultValue: 30,
	});
}

function parseIntervalFlag(args: string[]): ParseResult<{ value: number }> {
	return parseIntegerSecondsFlag({
		args,
		name: "--interval",
		defaultValue: 3,
		minValue: 1,
	});
}

function parseIntegerSecondsFlag({
	args,
	name,
	defaultValue,
	minValue = 0,
}: {
	args: string[];
	name: string;
	defaultValue: number;
	minValue?: number;
}): ParseResult<{ value: number }> {
	let valueRaw: string | null = null;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === name) {
			const value = args[i + 1];
			if (!value || value.startsWith("--")) {
				return {
					ok: false,
					error: `${name} requires a value in seconds.`,
				};
			}
			valueRaw = value;
			continue;
		}
		if (arg.startsWith(`${name}=`)) {
			valueRaw = arg.slice(name.length + 1);
			continue;
		}
	}
	if (valueRaw === null) {
		return { ok: true, value: defaultValue };
	}
	if (!/^\d+$/.test(valueRaw)) {
		return {
			ok: false,
			error: `${name} must be a non-negative integer (seconds).`,
		};
	}
	const value = Number.parseInt(valueRaw, 10);
	if (!Number.isFinite(value) || value < minValue) {
		return {
			ok: false,
			error:
				minValue === 0
					? `${name} must be a non-negative integer (seconds).`
					: `${name} must be an integer greater than or equal to ${minValue} (seconds).`,
		};
	}
	return {
		ok: true,
		value,
	};
}

function isParseFailure<TData>(
	value: ParseResult<TData>,
): value is { ok: false; error: string } {
	return value.ok === false;
}

function recordWaitEnvSetupState(result: ReturnType<typeof waitForEnv>) {
	recordSetupState({
		command: "wait-env",
		nextAction: result.ok ? "complete" : "waiting-for-env",
		requiredEnvKeys: result.requiredEnvKeys,
		presentEnvKeys: result.presentEnvKeys,
		missingEnvKeys: result.missingEnvKeys,
		timeoutSeconds: result.timeoutSeconds,
		intervalSeconds: result.intervalSeconds,
		ok: result.ok,
	});
}
