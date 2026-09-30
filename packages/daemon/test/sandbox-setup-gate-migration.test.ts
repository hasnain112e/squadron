import { describe, it, expect } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { SeatSandboxService } from "../src/domain/seat-sandbox-service.js";

// Migration 091 adds columns with a NOT NULL default and a CHECK to a table that may already hold rows from
// 090. SQLite checks a CHECK against existing rows and refuses a NOT NULL column without a default, so the
// upgrade has to be tried on a database that already has data, not only on an empty one.
describe("migration 091 on a database that already has sandboxes", () => {
  const before = ALL_MIGRATIONS.filter((migration) => migration.name < "091_sandbox_setup_gate.sql");

  it("keeps the existing rows and gives them the defaults", () => {
    const db = createDb();
    migrate(db, before);
    db.prepare(
      "INSERT INTO node_sandboxes (node_id, rig_name, seat, mode, repo_path, state, worktree_path, branch) VALUES ('n1', 'demo', 'dev.impl', 'worktree', '/repo', 'provisioned', '/w/demo/dev.impl', 'squad/demo/dev.impl')",
    ).run();

    migrate(db, ALL_MIGRATIONS);

    expect(new SeatSandboxService(db).get("n1")).toMatchObject({
      nodeId: "n1",
      state: "provisioned",
      branch: "squad/demo/dev.impl",
      setup: null,
      gate: null,
      setupState: "none",
      setupOutput: null,
    });
    db.close();
  });

  it("creates the gate-run table and keeps the setup state within its allowed values", () => {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);

    expect(db.prepare("SELECT COUNT(*) AS n FROM sandbox_gate_runs").get()).toEqual({ n: 0 });
    expect(() =>
      db.prepare("INSERT INTO node_sandboxes (node_id, rig_name, seat, mode, repo_path, setup_state) VALUES ('n', 'r', 's', 'worktree', '/p', 'bogus')").run(),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db
        .prepare(
          "INSERT INTO sandbox_gate_runs (id, node_id, rig_name, seat, lane, commit_sha, argv_json, status, duration_ms) VALUES ('g', 'n', 'r', 's', 'elsewhere', 'abc', '[]', 'passed', 1)",
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("is applied once: running the migrations again changes nothing", () => {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const applied = db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE name = '091_sandbox_setup_gate.sql'").get();

    expect(() => migrate(db, ALL_MIGRATIONS)).not.toThrow();

    expect(applied).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE name = '091_sandbox_setup_gate.sql'").get()).toEqual({ n: 1 });
    db.close();
  });
});
