import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { confirm, isCancel, select, text } from "@clack/prompts";

import { readDotEnv, readVercelTokenFromDisk } from "./env.js";
import { findWorkspaceRoot } from "./env.js";

const VERCEL_API = "https://api.vercel.com";

type HttpResponse = {
	status: number;
	ok: boolean;
	body: string;
};

type VercelUser = {
	id: string;
	defaultTeamId?: string | null;
	username?: string | null;
};

type VercelTeam = {
	id: string;
	slug: string;
	name: string | null;
};

type VercelProjectLink = {
	type?: string | null;
	org?: string | null;
	repo?: string | null;
};

type VercelProject = {
	id: string;
	name: string;
	link?: VercelProjectLink | null;
};

export type VercelProjectContext = {
	projectId: string;
	orgId: string;
	projectName: string;
};

export type ResolveVercelProjectResult = {
	ok: boolean;
	blockers: string[];
	nextActions: string[];
	plannedAction?: string;
	project?: VercelProjectContext;
};

type ProjectLookupResult =
	| { ok: true; project: VercelProject }
	| { ok: false; error: string }
	| { ok: "not_found" };

export async function resolveVercelProjectForSetup(options: {
	json: boolean;
	yes: boolean;
	workspaceRoot?: string;
	projectName?: string;
}): Promise<ResolveVercelProjectResult> {
	const workspaceRoot =
		options.workspaceRoot ?? findWorkspaceRoot(process.cwd());
	const token = await resolveVercelToken({
		workspaceRoot,
		interactive: !options.json,
	});
	if (!token) {
		return {
			ok: false,
			blockers: [
				"Vercel authentication token was not found. Set VERCEL_TOKEN or apps/app/.env.local VERCEL_TOKEN, then rerun.",
				options.json
					? "Cannot prompt for login in --json mode."
					: "Run `npx -y vercel@53 login` to authenticate.",
			],
			nextActions: ["Provide a valid VERCEL_TOKEN and rerun `rhapsody setup`."],
		};
	}

	const validation = await validateVercelToken({
		token,
		interactive: !options.json,
	});
	if (!validation.ok) {
		return {
			ok: false,
			blockers: [validation.error],
			nextActions: ["Provide a valid VERCEL_TOKEN and rerun `rhapsody setup`."],
		};
	}

	const teamsResult = await getTeams({ token });
	if (!teamsResult.ok) {
		return {
			ok: false,
			blockers: [
				`Cannot list Vercel teams. ${teamsResult.error}`,
				"Retry after fixing auth/network access.",
			],
			nextActions: [
				"Run `rhapsody setup` in interactive mode for troubleshooting.",
			],
		};
	}

	const teamSelection = await pickTeam({
		teams: teamsResult.teams,
		defaultTeamId: validation.user.defaultTeamId ?? null,
		interactive: !options.json,
	});
	if (!teamSelection.ok) {
		return {
			ok: false,
			blockers: [teamSelection.error],
			nextActions: [
				"Run setup in interactive mode to pick a team, or add --team support in a future release.",
			],
			plannedAction: "team-selection",
		};
	}

	const githubRepo = getGithubRepoFromRemote(workspaceRoot) ?? null;
	const repositoryLabel = githubRepo ?? "unknown/repo";
	const defaultProjectName = githubRepo?.split("/").pop() ?? "rhapsody";
	const shouldUseDefaultProjectName = options.json || options.yes;
	const projectName =
		options.projectName ??
		(shouldUseDefaultProjectName
			? defaultProjectName
			: await promptProjectName(defaultProjectName));

	const projectResult = await ensureProject({
		token,
		projectName,
		repo: repositoryLabel,
		teamId: teamSelection.teamId,
		interactive: !options.json,
		yes: options.yes,
	});
	if (!projectResult.ok) {
		return projectResult;
	}

	const orgId = teamSelection.teamId ?? validation.user.id;
	if (!options.json) {
		const projectJsonPath = path.join(
			workspaceRoot,
			"apps",
			"app",
			".vercel",
			"project.json",
		);
		writeProjectJson(projectJsonPath, {
			projectId: projectResult.project.id,
			orgId,
			projectName: projectResult.project.name,
		});
	}

	return {
		ok: true,
		blockers: [],
		nextActions: [
			`Vercel project ${projectResult.mode}: ${projectResult.project.name} (${projectResult.project.id})`,
		],
		plannedAction: projectResult.mode,
		project: {
			projectId: projectResult.project.id,
			orgId,
			projectName: projectResult.project.name,
		},
	};
}

export function writeProjectJson(
	filePath: string,
	payload: {
		projectId: string;
		orgId: string;
		projectName: string;
	},
): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function resolveVercelToken(options: {
	workspaceRoot: string;
	interactive: boolean;
}): Promise<string | null> {
	const envToken = process.env.VERCEL_TOKEN?.trim();
	if (envToken) {
		return envToken;
	}

	const envLocalPath = path.join(
		options.workspaceRoot,
		"apps",
		"app",
		".env.local",
	);
	const appEnv = readDotEnv(envLocalPath);
	if (typeof appEnv.VERCEL_TOKEN === "string" && appEnv.VERCEL_TOKEN.trim()) {
		return appEnv.VERCEL_TOKEN.trim();
	}

	const diskToken = readVercelTokenFromDisk();
	if (!diskToken) {
		if (!options.interactive) {
			return null;
		}
		const shouldLogin = await confirm({
			message: "No Vercel token found. Run `npx -y vercel@53 login` now?",
			initialValue: true,
		});
		if (isCancel(shouldLogin) || !shouldLogin) {
			return null;
		}

		const login = spawnSync("npx", ["-y", "vercel@53", "login"], {
			stdio: "inherit",
			encoding: "utf8",
		});
		if (login.status !== 0) {
			return null;
		}
		return readVercelTokenFromDisk();
	}

	return diskToken;
}

async function validateVercelToken({
	token,
	interactive,
}: {
	token: string;
	interactive: boolean;
}): Promise<{ ok: true; user: VercelUser } | { ok: false; error: string }> {
	const response = await request({ url: "/v2/user", token });

	if (!response.ok && interactive) {
		if (response.status === 401 || response.status === 403) {
			const shouldLogin = await confirm({
				message: `Vercel token is rejected (${response.status}). Run login now?`,
				initialValue: true,
			});
			if (!isCancel(shouldLogin) && shouldLogin) {
				const login = spawnSync("npx", ["-y", "vercel@53", "login"], {
					stdio: "inherit",
					encoding: "utf8",
				});
				if (login.status === 0) {
					const refreshed = readVercelTokenFromDisk();
					if (refreshed) {
						return validateVercelToken({
							token: refreshed,
							interactive: false,
						});
					}
				}
			}
		}
	}

	if (!response.ok) {
		return {
			ok: false,
			error: `Vercel auth check failed (${response.status}): ${response.body}`,
		};
	}

	try {
		const parsed = JSON.parse(response.body) as {
			user?: { id?: unknown; defaultTeamId?: unknown; username?: unknown };
		};
		const user = parsed.user;
		if (!user || typeof user.id !== "string" || user.id.length === 0) {
			return {
				ok: false,
				error: `Invalid /v2/user response: ${response.body}`,
			};
		}
		return {
			ok: true,
			user: {
				id: user.id,
				defaultTeamId:
					typeof user.defaultTeamId === "string" ? user.defaultTeamId : null,
				username: typeof user.username === "string" ? user.username : null,
			},
		};
	} catch {
		return {
			ok: false,
			error: `Failed to parse /v2/user response: ${response.body}`,
		};
	}
}

async function getTeams(options: {
	token: string;
}): Promise<{ ok: true; teams: VercelTeam[] } | { ok: false; error: string }> {
	const response = await request({ url: "/v2/teams", token: options.token });
	if (!response.ok) {
		return {
			ok: false,
			error: `${response.status} ${response.body}`,
		};
	}
	try {
		const parsed = JSON.parse(response.body) as {
			teams?: Array<{ id?: unknown; slug?: unknown; name?: unknown }>;
		};
		const teams =
			parsed.teams
				?.map((team) => ({
					id: typeof team.id === "string" ? team.id : "",
					slug: typeof team.slug === "string" ? team.slug : "",
					name: typeof team.name === "string" ? team.name : null,
				}))
				.filter(
					(team): team is VercelTeam => Boolean(team.id) && Boolean(team.slug),
				) ?? [];
		return { ok: true, teams };
	} catch {
		return {
			ok: false,
			error: `Invalid /v2/teams response: ${response.body}`,
		};
	}
}

async function pickTeam(args: {
	teams: VercelTeam[];
	defaultTeamId: string | null;
	interactive: boolean;
}): Promise<
	{ ok: true; teamId: string | null } | { ok: false; error: string }
> {
	if (args.teams.length === 0) {
		return { ok: true, teamId: null };
	}
	if (args.teams.length === 1) {
		return { ok: true, teamId: args.teams[0]!.id };
	}
	if (!args.interactive) {
		return {
			ok: false,
			error:
				"Multiple teams found; --json mode cannot prompt. Re-run in interactive mode to select a team.",
		};
	}

	const selected = await select({
		message: "Which Vercel team should own this project?",
		options: args.teams.map((team) => ({
			value: team.id,
			label: team.name ? `${team.name} (${team.slug})` : team.slug,
			hint: team.id === args.defaultTeamId ? "default" : undefined,
		})),
		initialValue: args.defaultTeamId ?? args.teams[0]!.id,
	});
	if (isCancel(selected) || typeof selected !== "string") {
		return {
			ok: false,
			error: "Team selection cancelled.",
		};
	}
	return { ok: true, teamId: selected };
}

async function promptProjectName(defaultName: string): Promise<string> {
	const value = await text({
		message: "Vercel project name",
		placeholder: defaultName,
		defaultValue: defaultName,
	});
	if (isCancel(value) || typeof value !== "string") {
		return defaultName;
	}
	return value.trim() || defaultName;
}

async function ensureProject(args: {
	token: string;
	projectName: string;
	repo: string;
	teamId: string | null;
	interactive: boolean;
	yes: boolean;
}): Promise<
	| {
			ok: false;
			blockers: string[];
			nextActions: string[];
			plannedAction: string;
	  }
	| {
			ok: true;
			mode: "reused" | "relinked" | "created";
			project: VercelProject;
	  }
> {
	const existing = await getProjectByName(
		args.token,
		args.teamId,
		args.projectName,
	);
	if (existing.ok === false) {
		return {
			ok: false,
			blockers: [existing.error],
			nextActions: ["Fix blocker and rerun setup."],
			plannedAction: "lookup",
		};
	}

	if (existing.ok === "not_found" && !args.interactive) {
		return {
			ok: false,
			blockers: [
				`No existing project "${args.projectName}" found on Vercel for this workspace.`,
				"--json mode blocks auto-create; remove --json to allow setup to create it.",
			],
			nextActions: [
				`Use rhapsody setup (without --json) to create ${args.projectName}.`,
			],
			plannedAction: "create",
		};
	}

	if (existing.ok === "not_found") {
		const shouldCreate = args.yes
			? true
			: await confirm({
					message: `Create Vercel project ${args.projectName}?`,
					initialValue: false,
				});
		if (isCancel(shouldCreate) || !shouldCreate) {
			return {
				ok: false,
				blockers: [
					`User declined creating project ${args.projectName}.`,
					`Run with --yes in interactive mode to auto-create ${args.projectName}.`,
				],
				nextActions: ["Choose a different project name and rerun setup."],
				plannedAction: "create",
			};
		}
	}

	if (existing.ok === true) {
		const linked =
			existing.project.link?.org && existing.project.link?.repo
				? `${existing.project.link.org}/${existing.project.link.repo}`
				: null;
		if (linked === args.repo) {
			return { ok: true, mode: "reused", project: existing.project };
		}

		if (!args.interactive) {
			return {
				ok: false,
				blockers: [
					`Project ${args.projectName} already exists on Vercel and is linked to ${linked ?? "another repository"}.`,
					"In --json mode, this is a blocker. Re-run interactive setup to relink, or choose a different project name.",
				],
				nextActions: ["Choose another project name in interactive mode."],
				plannedAction: "relink",
			};
		}

		const doRelink = args.yes
			? true
			: await confirm({
					message: `Project ${args.projectName} is linked to ${linked ?? "another repository"}. Relink it to ${args.repo}?`,
					initialValue: false,
				});
		if (isCancel(doRelink) || !doRelink) {
			return {
				ok: false,
				blockers: [
					`Project ${args.projectName} is linked to ${linked ?? "another repository"} and was not relinked.`,
				],
				nextActions: ["Choose another project name."],
				plannedAction: "relink",
			};
		}

		const relink = await relinkProject({
			token: args.token,
			projectId: existing.project.id,
			teamId: args.teamId,
			repo: args.repo,
		});
		if (!relink.ok) {
			return {
				ok: false,
				blockers: [relink.error],
				nextActions: ["Fix blocker and rerun setup."],
				plannedAction: "relink",
			};
		}
		return { ok: true, mode: "relinked", project: existing.project };
	}

	const created = await createProject({
		token: args.token,
		teamId: args.teamId,
		projectName: args.projectName,
		repo: args.repo,
	});
	if (!created.ok) {
		return {
			ok: false,
			blockers: [created.error],
			nextActions: ["Fix blocker and rerun setup."],
			plannedAction: "create",
		};
	}
	return {
		ok: true,
		mode: "created",
		project: created.project,
	};
}

async function getProjectByName(
	token: string,
	teamId: string | null,
	projectName: string,
): Promise<ProjectLookupResult> {
	const query = teamId ? `?teamId=${teamId}` : "";
	const response = await request({
		url: `/v9/projects/${encodeURIComponent(projectName)}${query}`,
		token,
	});
	if (response.status === 404) {
		return { ok: "not_found" };
	}
	if (!response.ok) {
		return {
			ok: false,
			error: `Failed to read Vercel project ${projectName}: ${response.status} ${response.body}`,
		};
	}

	let parsed: { id?: unknown; name?: unknown; link?: unknown };
	try {
		parsed = JSON.parse(response.body) as {
			id?: unknown;
			name?: unknown;
			link?: unknown;
		};
	} catch {
		return {
			ok: false,
			error: `Invalid Vercel project payload: ${response.body}`,
		};
	}
	if (typeof parsed.id !== "string" || typeof parsed.name !== "string") {
		return {
			ok: false,
			error: `Invalid Vercel project payload: ${response.body}`,
		};
	}

	return {
		ok: true,
		project: {
			id: parsed.id,
			name: parsed.name,
			link:
				typeof parsed.link === "object" && parsed.link !== null
					? {
							type:
								typeof (parsed.link as VercelProjectLink).type === "string"
									? ((parsed.link as VercelProjectLink).type as string)
									: null,
							org:
								typeof (parsed.link as VercelProjectLink).org === "string"
									? ((parsed.link as VercelProjectLink).org as string)
									: null,
							repo:
								typeof (parsed.link as VercelProjectLink).repo === "string"
									? ((parsed.link as VercelProjectLink).repo as string)
									: null,
						}
					: null,
		},
	};
}

async function createProject(args: {
	token: string;
	teamId: string | null;
	projectName: string;
	repo: string;
}): Promise<
	{ ok: true; project: VercelProject } | { ok: false; error: string }
> {
	const query = args.teamId ? `?teamId=${args.teamId}` : "";
	const response = await request({
		url: `/v9/projects${query}`,
		token: args.token,
		method: "POST",
		body: JSON.stringify({
			name: args.projectName,
			framework: "nextjs",
			gitRepository: {
				type: "github",
				repo: args.repo,
			},
		}),
	});
	if (!response.ok) {
		return {
			ok: false,
			error: `Failed to create project ${args.projectName}: ${response.status} ${response.body}`,
		};
	}

	let parsed: { id?: unknown; name?: unknown };
	try {
		parsed = JSON.parse(response.body) as { id?: unknown; name?: unknown };
	} catch {
		return {
			ok: false,
			error: `Invalid create-project payload: ${response.body}`,
		};
	}
	if (typeof parsed.id !== "string" || typeof parsed.name !== "string") {
		return {
			ok: false,
			error: `Invalid create-project payload: ${response.body}`,
		};
	}
	return {
		ok: true,
		project: {
			id: parsed.id,
			name: parsed.name,
		},
	};
}

async function relinkProject(args: {
	token: string;
	projectId: string;
	teamId: string | null;
	repo: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
	const query = args.teamId ? `?teamId=${args.teamId}` : "";
	const response = await request({
		url: `/v9/projects/${encodeURIComponent(args.projectId)}/link${query}`,
		token: args.token,
		method: "POST",
		body: JSON.stringify({
			type: "github",
			repo: args.repo,
		}),
	});
	if (!response.ok) {
		return {
			ok: false,
			error: `Failed to relink project ${args.projectId}: ${response.status} ${response.body}`,
		};
	}
	return { ok: true };
}

function getGithubRepoFromRemote(workspaceRoot: string): string | null {
	const result = spawnSync("git", ["config", "--get", "remote.origin.url"], {
		cwd: workspaceRoot,
		encoding: "utf8",
	});
	if (result.status !== 0 || !result.stdout) {
		return null;
	}
	const raw = result.stdout.trim();
	if (!raw) {
		return null;
	}
	const normalized = raw
		.replace(/^git@github\.com:/, "https://github.com/")
		.replace(/\.git$/, "");
	if (raw.includes("github.com")) {
		try {
			const parsed = new URL(normalized);
			const segments = parsed.pathname.replace(/^\/+/, "").split("/");
			if (segments.length >= 2) {
				return `${segments[0]}/${segments[1]}`;
			}
		} catch {
			// ignore
		}
	}
	const fallback = normalized.match(/github\.com[\/:]([^/]+\/[^/]+)$/);
	return fallback?.[1] ?? null;
}

async function request(args: {
	url: string;
	method?: "GET" | "POST";
	token: string;
	body?: string;
}): Promise<HttpResponse> {
	try {
		const response = await fetch(`${VERCEL_API}${args.url}`, {
			method: args.method ?? "GET",
			headers: {
				Authorization: `Bearer ${args.token}`,
				"Content-Type": "application/json",
			},
			body: args.body,
		});
		return {
			status: response.status,
			ok: response.ok,
			body: await response.text(),
		};
	} catch (error) {
		return {
			status: 0,
			ok: false,
			body:
				error instanceof Error
					? `Network error while calling Vercel API: ${error.message}`
					: `Network error while calling Vercel API`,
		};
	}
}

export function projectJsonExists(): boolean {
	const workspaceRoot = findWorkspaceRoot(process.cwd());
	const filePath = path.join(
		workspaceRoot,
		"apps",
		"app",
		".vercel",
		"project.json",
	);
	return existsSync(filePath);
}
