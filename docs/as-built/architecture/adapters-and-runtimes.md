---
kind: as-built
title: Adapters and Runtimes — Claude/Codex/Terminal, tmux/cmux, Resume Honesty
status: active
topics: [agent-runtime, runtime-control]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Need the runtime-adapter contract — how OpenRig launches and resumes a
  Claude Code, Codex, or terminal harness inside tmux, what the five adapter
  methods do, or how the daemon honestly assesses whether a harness actually
  resumed vs fresh-launched (the resume-honesty layer).
siblings: [daemon-core.md, agent-spec-and-startup.md, lifecycle-snapshot-restore.md]
prerequisite-reads: [../README.md, daemon-core.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# Adapters and Runtimes

How OpenRig drives the agent harnesses. The daemon never talks to Claude Code,
Codex, or a shell directly — it talks to a `RuntimeAdapter`. Three adapters
implement one five-method contract; a separate resume-honesty layer answers the
question "did this harness *actually* resume, or did it silently fresh-launch?"
truthfully rather than optimistically.

> Verified against source at HEAD `7eaf524c` (`git describe` →
> `v0.3.1-6-g7eaf524c`). All source in this module is **present at `v0.3.0`**
> (`git cat-file -e v0.3.0:<path>` for all 7 files → present) — the adapter
> layer is core reboot-era machinery, **not** a 0.3.x feature; do not
> back-attribute (§10.8 version-attribution proof technique).

> Drift-fix (scope) — `architecture.md` §5 "Runtime adapters" carries **no
> slice-00 numeric drift** (proposed-structure §4.2: "adapter contract is
> current"). The corrections below are *precision* refinements where the source
> is more specific than the prose, not stale-count fixes. Each is annotated
> inline and re-confirmed at HEAD.

## 1. The five-method RuntimeAdapter contract

`RuntimeAdapter` is `packages/daemon/src/domain/runtime-adapter.ts:127`
(`interface RuntimeAdapter`). Every adapter declares a `readonly runtime`
string and implements exactly five methods (`runtime-adapter.ts:128–153`):

| Method | Signature (`runtime-adapter.ts`) | Responsibility |
|---|---|---|
| `listInstalled` | `(binding)` `:131` | List currently installed/projected resources for a node. |
| `project` | `(plan, binding)` `:134` | Project resources from a `ProjectionPlan` to the runtime's target locations. |
| `deliverStartup` | `(files, binding)` `:137` | Deliver resolved startup files to the runtime. |
| `launchHarness` | `(binding, opts)` `:147` | Launch the harness inside the bound tmux session; return a resume token. |
| `checkReady` | `(binding)` `:153` | Probe whether the harness is responsive and ready. |

Startup *action* execution (`slash_command` / `send_text`) is explicitly **not**
part of this contract — the contract docstring (`runtime-adapter.ts:121–125`)
states actions belong to the `StartupOrchestrator` *after* `checkReady()`. The
orchestrator delivery split is in `agent-spec-and-startup.md`.

### `launchHarness` opts and the fork seam

`launchHarness` opts is `{ name: string; resumeToken?: string; forkSource?:
ForkSource }` (`runtime-adapter.ts:147–150`).

> Drift-fix (precision) — `architecture.md` §4 said `launchHarness(binding,
> opts: { name, resumeToken? })`. Source adds a third, mutually-exclusive
> `forkSource` field. Per the contract docstring (`runtime-adapter.ts:142–146`)
> `resumeToken` and `forkSource` are mutually exclusive — if both are provided
> the adapter **must refuse** with a clear error, not guess; `forkSource`
> triggers a fork and the captured token is the NEW post-fork token, never the
> parent. `ForkSource` is `runtime-adapter.ts:116` (`kind: "native_id" |
> "artifact_path" | "name" | "last"`; v1 MVP accepts `native_id` only — other
> shapes rejected at schema validation, docstring `:106–119`).

### `HarnessLaunchResult` is a discriminated union with an honest failure arm

> Drift-fix (precision) — `architecture.md` §4 said `HarnessLaunchResult` is
> `{ ok, resumeToken?, resumeType?, error? }` (a single optional-field shape).
> Source is a **discriminated union** (`runtime-adapter.ts:81–86`):
> `| { ok: true; resumeToken?; resumeType? }`
> `| { ok: false; error: string; recovery?: HarnessLaunchRecovery; evidence? }`.
> The failure arm carries a typed `recovery` hint
> (`HarnessLaunchRecovery = "retry_fresh" | "attention_required"`,
> `:79`) and optional `evidence` (last-N pane lines, flowed through to
> `RestoreNodeResult.attentionEvidence` for `attention_required` outcomes,
> `:83–86`). This is the honest-failure shape, not a smoothed optional `error`.

## 2. The three adapters

All three live under `packages/daemon/src/adapters/` and implement
`RuntimeAdapter` (Architecture Rule 1: zero Hono in `adapters/`).

### ClaudeCodeAdapter (`claude-code-adapter.ts:41`)

- `readonly runtime = "claude-code"` (`:42`).
- **Projects** to `.claude/` targets: `guidance_merge` → `<cwd>/CLAUDE.md`
  (`:127`); `skill_install` → `<cwd>/.claude/skills/<name>/` (`:71,133`);
  subagents → `.claude/agents`, plugins → `.claude/plugins/<id>`,
  runtime resources → `.claude/extensions/<id>`, settings fragments merged
  into `.claude/settings.local.json` (`:388–400`).
- **Launches** (`:213–215`): fresh = `claude <permissionMode> --session-id
  <generatedId> --name <name>`; resume = `claude <permissionMode> --resume
  <token> --name <name>`; fork = `claude <permissionMode> --resume <parentId>
  --fork-session --name <seat>` (`:188`).
  > Drift-fix (precision) — `architecture.md` §5 said only "launches via
  > `claude --name <name>`, resumes via `claude --resume <token>`". Source
  > shows fresh launch uses an explicit `--session-id` (so a deterministic
  > resume token exists immediately) and the fork branch exists. Re-confirmed
  > `claude-code-adapter.ts:188,213–215` @HEAD.
- **Readiness** (`checkReady`, `:239`): verifies tmux session alive, captures
  40 pane lines + pane command, delegates to `assessNativeResumeProbe` (§3);
  ready only when probe `status === "resumed"`. The resume-launch verification
  loop `verifyResumeLaunch` retries up to **16 attempts** (`:273`), failing
  loudly with `recovery: "retry_fresh"` on `no_conversation_found`
  (`:284–289`) — no silent fresh fallback.

### CodexRuntimeAdapter (`codex-runtime-adapter.ts:37`)

- `readonly runtime = "codex"` (`:38`).
- **Projects** to `.agents/` targets: `guidance_merge` → `<cwd>/AGENTS.md`
  (`:139,330`); `skill_install` → `<cwd>/.agents/skills/<name>/` (`:89,145`);
  skills resolve under `.agents/skills/<id>` (`:377`).
- **Launches/resumes** (`:205,225–226`): fresh launch then capture a fresh
  thread id; resume = `codex<profileArg> resume<queueStateDirArg> <token>`;
  fork = `codex<profileArg> fork<queueStateDirArg> <parentId>` (`:205`). On
  success returns `{ ok: true, resumeToken: threadId, resumeType: "codex_id" }`
  (`:222,245,250`).
  > Drift-fix (precision) — `architecture.md` §5 said "launches via `codex`,
  > resumes via `codex resume <threadId>`". Source confirms the `codex resume
  > <token>` shape (`:226`) and adds the fork branch + the
  > `resumeType: "codex_id"` tag. Re-confirmed @HEAD.
- Refuses `resumeToken` + `forkSource` together with a clear error
  (`:180–181`) — honors the mutual-exclusivity contract.

### TerminalAdapter (`terminal-adapter.ts:19`)

- `readonly runtime = "terminal"` (`:20`).
- **All operations are no-ops** — "the shell IS the harness"
  (`terminal-adapter.ts:15`): no-op `project`/`deliverStartup`/`launchHarness`
  (`:34`), and `checkReady` returns ready immediately as soon as the tmux
  session exists (`:47`). Used for infrastructure nodes — servers, log tails,
  build watchers. (A terminal node cannot fork; the runtime-adapter docstring
  notes fork-unsupported adapters refuse with a runtime-mismatch error,
  `runtime-adapter.ts:113–115`.)

### GeminiRuntimeAdapter (`gemini-runtime-adapter.ts`, added by Squadron)

OpenRig has no Gemini adapter, so this subsection is not part of the
source-verified text above. It describes Squadron's
`packages/daemon/src/adapters/gemini-runtime-adapter.ts`. What an operator
needs, and what a Gemini seat does not do yet, is in
[Gemini seats](../../reference/rig-spec.md#gemini-seats).

- `readonly runtime = "gemini"`.
- **Projects** skills to `<cwd>/.agents/skills/<name>/` and managed-block
  guidance to `<cwd>/GEMINI.md`. The per-seat `rig-role` block, subagents,
  plugins and runtime resources are skipped, and `project` reports them as
  skipped, not failed.
- **Launches** `GEMINI_CLI_TRUST_WORKSPACE=true gemini --approval-mode
  <auto_edit|yolo> [-m <model>]` in the bound tmux session
  (`geminiPostureArg` in `yolo-mode.ts` picks the mode). A `resumeToken` or a
  `forkSource` is refused with `recovery: "retry_fresh"`, because no Gemini
  session id is recorded.
- **Readiness** (`checkReady`) captures the rendered screen and the pane
  command and reads them with `assessGeminiScreen`
  (`domain/gemini-screen.ts`), in the vocabulary of §3: a shell prompt is
  `failed` / `returned_to_shell`, a sign-in screen `attention_required` /
  `login_required`, a folder-trust dialog `inconclusive` / `trust_gate`,
  Gemini's input box `resumed` / `active_runtime`, anything else
  `inconclusive` / `awaiting_runtime`. The adapter is ready only on `resumed`.

These are constructed by `createDaemon` step 4 (`startup.ts`; see
`daemon-core.md` §4 "Startup sequence"). Squadron's fourth, the Gemini
adapter, is registered there beside them.

## 3. Resume honesty

The daemon does not assume a harness resumed just because the launch command
ran. Three domain files (`packages/daemon/src/domain/`, all present @v0.3.0)
make resume assessment honest:

### `native-resume-probe.ts`

`assessNativeResumeProbe(input)` (`native-resume-probe.ts:43`) reads pane
command + pane content and returns one of four honest statuses
(`NativeResumeProbeStatus`, `:6`):

- `resumed` — runtime-specific indicators confirm a resumed session.
- `failed` — terminal failure (e.g. Claude printed "No conversation found" →
  code `no_conversation_found`, `:51–57`).
- `inconclusive` — we don't know yet (e.g. Claude trust gate, code
  `trust_gate`, `:65–70`).
- `attention_required` — alive and recoverable but **needs operator action**
  (e.g. Claude resume-selection prompt, code `claude_resume_selection_prompt`,
  `:58–64`). This is the proxy for "an operator must choose the conversation";
  it is *distinct* from `inconclusive` and `failed` (docstring `:3–5`).

`buildNativeResumeCommand` (`:27`) builds the resume command per runtime:
claude → `claude --resume <token> [--name <name>]` (`:35`); codex → `codex
resume <token>` (`:38`); other runtimes → `null` (`:40`).

This is Architecture Rule 15 in code: a failed resume is FAILED loudly; there
is no automatic fresh fallback (the adapter's `verifyResumeLaunch` returns
`ok:false` with a `retry_fresh` recovery hint, never a silent relaunch).

### `resume-metadata-refresher.ts`

`ResumeMetadataRefresher` (`resume-metadata-refresher.ts:37`). Post-launch
resume-token capture: `refresh(sessions)` (`:62`) skips sessions that already
have a `resumeToken` (`:65`), and for `claude-code` sessions with a token runs
a `probeClaudeResume` returning `"resumable" | "not_resumable" |
"inconclusive"` (`:31,74–75`) — a real launch of the resume command in a
throwaway probe tmux session (`:106–111`), not a metadata guess.

### `codex-thread-id.ts`

Codex thread-id extraction (`codex-thread-id.ts`). Reads the Codex thread id
from the Codex *logs* SQLite databases under `~/.codex/`:
`readCodexThreadIdFromCandidateHomes(...)` (`:22`) →
`readCodexThreadIdFromLogs(...)` (`:49`) → `resolveCodexLogDbPaths(homeDir)`
(`:79`) which globs `<homeDir>/.codex/logs_<N>.sqlite` (`:84–89`,
regex `^logs_(\d+)\.sqlite$`) and falls back to `logs_1.sqlite` (`:97`).
Uses `better-sqlite3` (`:5`). Resolves the home dir by the harness PID
(`defaultResolveHomeDirByPid`, `:9`).

> Precision note — `architecture.md` §5 "Resume honesty" says codex thread IDs
> come from "the Codex SQLite database". Source is more specific: the
> per-version Codex *logs* DBs `~/.codex/logs_N.sqlite`. Stated precisely here;
> re-confirmed `codex-thread-id.ts:79–97` @HEAD.

## 4. Relevant Architecture Rules (source-verified at HEAD)

From `architecture.md` §7 (re-confirmed against the source cited inline):

- **Rule 5** — Runtime is member-authoritative in the pod-aware model.
- **Rule 13** — Readiness checking is a retry loop with exponential backoff and
  a configurable timeout, using adapter-specific probes (Claude TUI indicator,
  Codex ready message, terminal immediate). Re-confirmed: `checkReady`
  delegates to `assessNativeResumeProbe`; the retry loop is
  `claude-code-adapter.ts:273` (16 attempts).
- **Rule 14** — Resume states are locked: `resumed` / `rebuilt` / `fresh`;
  `rebuilt` = new process assembled from artifacts. (The probe layer adds
  `inconclusive` / `attention_required` as honest *transient* states, not
  outcomes — see §3.)
- **Rule 15** — Restore honesty: failed resume is FAILED loudly; no automatic
  fresh fallback; fresh launch is an explicit follow-up only. Enforced in code
  by §2/§3 (`verifyResumeLaunch` returns `ok:false`, never relaunches).

## See also

- `daemon-core.md` — where `createDaemon` constructs the three adapters.
- `agent-spec-and-startup.md` — the `StartupOrchestrator` that calls these
  adapters and owns startup-action execution after `checkReady()`.
- `lifecycle-snapshot-restore.md` — how persisted resume tokens flow into
  snapshot/restore (resume vs rebuild vs fresh).
- Source roots: `packages/daemon/src/domain/runtime-adapter.ts`,
  `packages/daemon/src/adapters/{claude-code-adapter,codex-runtime-adapter,terminal-adapter}.ts`,
  `packages/daemon/src/domain/{native-resume-probe,resume-metadata-refresher,codex-thread-id}.ts`.
