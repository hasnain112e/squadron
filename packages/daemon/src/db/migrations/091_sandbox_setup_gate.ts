import type { Migration } from "../migrate.js";

// The commands a member declares (`setup`, `gate`), whether its setup has run in the current worktree, and a
// record of every gate run. Like node_sandboxes there is no foreign key to nodes: the record of what was tested
// at which commit must outlive the rig, because landing can happen after the rig is torn down.
//
// setup_state: 'none' when no setup is configured, 'pending' until it has passed in this worktree, then
// 'passed' or 'failed'. A gate run is bound to the commit it tested (commit_sha). lane is 'seat' for a run in
// the seat's own worktree and 'integration' for a run on the integration branch.
export const sandboxSetupGateSchema: Migration = {
  name: "091_sandbox_setup_gate.sql",
  sql: `
    ALTER TABLE node_sandboxes ADD COLUMN setup_json TEXT;
    ALTER TABLE node_sandboxes ADD COLUMN gate_json TEXT;
    ALTER TABLE node_sandboxes ADD COLUMN setup_state TEXT NOT NULL DEFAULT 'none'
      CHECK (setup_state IN ('none', 'pending', 'passed', 'failed'));
    ALTER TABLE node_sandboxes ADD COLUMN setup_output TEXT;

    CREATE TABLE sandbox_gate_runs (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      rig_name TEXT NOT NULL,
      seat TEXT NOT NULL,
      lane TEXT NOT NULL CHECK (lane IN ('seat', 'integration')),
      commit_sha TEXT NOT NULL,
      argv_json TEXT NOT NULL,
      subdir TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'timed_out', 'error')),
      exit_code INTEGER,
      duration_ms INTEGER NOT NULL,
      output_tail TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_sandbox_gate_runs_node ON sandbox_gate_runs (node_id, commit_sha, lane);
    CREATE INDEX idx_sandbox_gate_runs_rig ON sandbox_gate_runs (rig_name, lane, commit_sha);
  `,
};
