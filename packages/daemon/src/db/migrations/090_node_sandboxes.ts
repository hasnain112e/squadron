import type { Migration } from "../migrate.js";

// One row per node that asked for `isolation: worktree`. It is requested when the node is created
// and filled in when the seat first launches. There is deliberately no foreign key to nodes: deleting
// a rig must not erase the record of a worktree that still exists on disk, so rig_name and seat are
// kept on the row. repo_path is the authored cwd (possibly a subdirectory of the repository),
// worktree_path the worktree root, and subdir the authored cwd relative to the repository root.
export const nodeSandboxesSchema: Migration = {
  name: "090_node_sandboxes.sql",
  sql: `
    CREATE TABLE node_sandboxes (
      node_id TEXT PRIMARY KEY,
      rig_name TEXT NOT NULL,
      seat TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('worktree')),
      repo_path TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'requested' CHECK (state IN ('requested', 'provisioned', 'removed')),
      worktree_path TEXT,
      subdir TEXT NOT NULL DEFAULT '',
      branch TEXT,
      base_sha TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `,
};
