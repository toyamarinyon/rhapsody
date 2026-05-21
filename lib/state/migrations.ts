import type { Client } from "@libsql/client";

export type StateStoreMigration = {
	id: string;
	sql: string;
};

export type AppliedMigration = {
	id: string;
	appliedAt: number;
};

export const stateStoreMigrations = [
	{
		id: "0001_mvp_state_model",
		sql: `
			CREATE TABLE claims (
				work_item_id TEXT PRIMARY KEY,
				claim_token TEXT NOT NULL,
				claimed_by TEXT NOT NULL,
				run_id TEXT,
				work_item_status TEXT,
				claim_expires_at INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);

			CREATE INDEX claims_claim_expires_at_idx
				ON claims (claim_expires_at);

			CREATE INDEX claims_run_id_idx
				ON claims (run_id);

			CREATE TABLE runs (
				id TEXT PRIMARY KEY,
				work_item_id TEXT NOT NULL,
				claim_token TEXT NOT NULL,
				status TEXT NOT NULL CHECK (
					status IN ('pending', 'running', 'completed', 'failed', 'canceled', 'timed_out', 'stale')
				),
				work_item_title TEXT NOT NULL,
				work_item_url TEXT,
				work_item_status TEXT,
				work_item_snapshot_json TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				started_at INTEGER,
				finished_at INTEGER
			);

			CREATE INDEX runs_work_item_id_idx
				ON runs (work_item_id);

			CREATE INDEX runs_status_updated_at_idx
				ON runs (status, updated_at);

			CREATE TABLE attempts (
				id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
				attempt_number INTEGER NOT NULL,
				status TEXT NOT NULL CHECK (
					status IN ('pending', 'running', 'completed', 'failed', 'canceled', 'timed_out', 'stale')
				),
				sandbox_id TEXT,
				command TEXT,
				exit_code INTEGER,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				started_at INTEGER,
				finished_at INTEGER,
				UNIQUE (run_id, attempt_number)
			);

			CREATE INDEX attempts_run_id_idx
				ON attempts (run_id);

			CREATE INDEX attempts_status_updated_at_idx
				ON attempts (status, updated_at);

			CREATE TABLE events (
				id TEXT PRIMARY KEY,
				run_id TEXT REFERENCES runs (id) ON DELETE CASCADE,
				attempt_id TEXT REFERENCES attempts (id) ON DELETE SET NULL,
				level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
				type TEXT NOT NULL,
				message TEXT,
				data_json TEXT,
				created_at INTEGER NOT NULL
			);

			CREATE INDEX events_run_id_created_at_idx
				ON events (run_id, created_at);

			CREATE INDEX events_attempt_id_created_at_idx
				ON events (attempt_id, created_at);
		`,
	},
	{
		id: "0002_codex_chatgpt_credentials",
		sql: `
			CREATE TABLE codex_chatgpt_credentials (
				id TEXT PRIMARY KEY,
				encrypted_access_token TEXT NOT NULL,
				access_token_iv TEXT NOT NULL,
				access_token_tag TEXT NOT NULL,
				encrypted_refresh_token TEXT NOT NULL,
				refresh_token_iv TEXT NOT NULL,
				refresh_token_tag TEXT NOT NULL,
				account_id TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			);
		`,
	},
	{
		id: "0003_runs_runner",
		sql: `
			ALTER TABLE runs
				ADD COLUMN runner TEXT;

			UPDATE runs
				SET runner = 'sandbox-codex'
				WHERE runner IS NULL;

			CREATE TABLE runs_new (
				id TEXT PRIMARY KEY,
				work_item_id TEXT NOT NULL,
				claim_token TEXT NOT NULL,
				runner TEXT NOT NULL CHECK (
					runner IN ('fake', 'sandbox-fake', 'codex-local', 'sandbox-codex')
				),
				status TEXT NOT NULL CHECK (
					status IN ('pending', 'running', 'completed', 'failed', 'canceled', 'timed_out', 'stale')
				),
				work_item_title TEXT NOT NULL,
				work_item_url TEXT,
				work_item_status TEXT,
				work_item_snapshot_json TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				started_at INTEGER,
				finished_at INTEGER
			);

			INSERT INTO runs_new (
				id,
				work_item_id,
				claim_token,
				runner,
				status,
				work_item_title,
				work_item_url,
				work_item_status,
				work_item_snapshot_json,
				created_at,
				updated_at,
				started_at,
				finished_at
			)
			SELECT
				id,
				work_item_id,
				claim_token,
				runner,
				status,
				work_item_title,
				work_item_url,
				work_item_status,
				work_item_snapshot_json,
				created_at,
				updated_at,
				started_at,
				finished_at
			FROM runs;

			DROP TABLE runs;
			ALTER TABLE runs_new RENAME TO runs;

			CREATE INDEX runs_work_item_id_idx
				ON runs (work_item_id);

			CREATE INDEX runs_status_updated_at_idx
				ON runs (status, updated_at);
		`,
	},
	{
		id: "0004_attempts_git_branch_name",
		sql: `
			ALTER TABLE attempts
				ADD COLUMN git_branch_name TEXT;
		`,
	},
	{
		id: "0005_runs_runner_workflow_run_id",
		sql: `
			ALTER TABLE runs
				ADD COLUMN runner_workflow_run_id TEXT;
		`,
	},
	{
		id: "0006_worker_graph_foundation",
		sql: `
			CREATE TABLE worker_runs (
				id TEXT PRIMARY KEY,
				work_item_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				status TEXT NOT NULL CHECK (
					status IN ('pending', 'running', 'completed', 'failed', 'canceled', 'timed_out', 'stale')
				),
				claim_token TEXT,
				metadata_json TEXT NOT NULL DEFAULT '{}',
				work_item_snapshot_json TEXT NOT NULL DEFAULT '{}',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				started_at INTEGER,
				finished_at INTEGER
			);

			CREATE INDEX worker_runs_work_item_status_kind_idx
				ON worker_runs (work_item_id, status, kind);

			CREATE INDEX worker_runs_kind_status_idx
				ON worker_runs (kind, status);

			CREATE TABLE decisions (
				id TEXT PRIMARY KEY,
				work_item_id TEXT NOT NULL,
				worker_run_id TEXT NOT NULL REFERENCES worker_runs (id) ON DELETE CASCADE,
				phase TEXT NOT NULL,
				outcome TEXT NOT NULL,
				deterministic INTEGER NOT NULL CHECK (deterministic IN (0, 1)),
				policy_version TEXT,
				policy_rule_id TEXT,
				evidence_json TEXT,
				next_worker_kind TEXT,
				next_action TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);

			CREATE INDEX decisions_work_item_phase_idx
				ON decisions (work_item_id, phase);

			CREATE INDEX decisions_worker_run_id_idx
				ON decisions (worker_run_id);

			CREATE INDEX decisions_work_item_outcome_idx
				ON decisions (work_item_id, outcome);

			CREATE TABLE artifacts (
				id TEXT PRIMARY KEY,
				work_item_id TEXT NOT NULL,
				worker_run_id TEXT REFERENCES worker_runs (id) ON DELETE SET NULL,
				kind TEXT NOT NULL,
				external_id TEXT,
				external_url TEXT,
				snapshot_json TEXT,
				metadata_json TEXT NOT NULL DEFAULT '{}',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);

			CREATE INDEX artifacts_work_item_kind_idx
				ON artifacts (work_item_id, kind);

			CREATE INDEX artifacts_worker_run_id_idx
				ON artifacts (worker_run_id);

			CREATE INDEX artifacts_external_id_idx
				ON artifacts (external_id);

			CREATE TABLE links (
				id TEXT PRIMARY KEY,
				work_item_id TEXT NOT NULL,
				from_node_type TEXT NOT NULL,
				from_node_id TEXT NOT NULL,
				to_node_type TEXT NOT NULL,
				to_node_id TEXT NOT NULL,
				relation TEXT NOT NULL,
				metadata_json TEXT NOT NULL DEFAULT '{}',
				created_at INTEGER NOT NULL
			);

			CREATE INDEX links_work_item_idx
				ON links (work_item_id);

			CREATE INDEX links_from_node_idx
				ON links (from_node_type, from_node_id);

			CREATE INDEX links_to_node_idx
				ON links (to_node_type, to_node_id);

			CREATE INDEX links_relation_idx
				ON links (relation);
		`,
	},
] as const satisfies readonly StateStoreMigration[];

export async function migrateStateStore(
	client: Client,
	migrations: readonly StateStoreMigration[] = stateStoreMigrations,
	now = Date.now,
): Promise<AppliedMigration[]> {
	await client.execute(`
		CREATE TABLE IF NOT EXISTS state_store_migrations (
			id TEXT PRIMARY KEY,
			applied_at INTEGER NOT NULL
		)
	`);

	const applied: AppliedMigration[] = [];

	for (const migration of migrations) {
		const tx = await client.transaction("write");

		try {
			const existing = await tx.execute({
				sql: "SELECT id FROM state_store_migrations WHERE id = ?",
				args: [migration.id],
			});

			if (existing.rows.length === 0) {
				await tx.executeMultiple(migration.sql);

				const appliedAt = now();
				await tx.execute({
					sql: "INSERT INTO state_store_migrations (id, applied_at) VALUES (?, ?)",
					args: [migration.id, appliedAt],
				});
				applied.push({ id: migration.id, appliedAt });
			}

			await tx.commit();
		} catch (error) {
			await tx.rollback();
			throw error;
		} finally {
			tx.close();
		}
	}

	return applied;
}
