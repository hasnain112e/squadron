# Contributing to Squadron

Thanks for being here. Squadron is a pre-release fork of [OpenRig](https://github.com/mvschwarz/openrig).
This page says how to get a change in with the least friction on both sides. Fixes to inherited
OpenRig code are welcome here, and are worth sending to
[OpenRig](https://github.com/mvschwarz/openrig/blob/main/CONTRIBUTING.md) too.

## Before you start

- **Bugs:** open an issue with the bug template. Include your Squadron version (`squad --version`),
  OS, Node version, which harnesses are involved (or none), and the relevant command and output.
  Reports are public: remove credentials, private prompts, personal details and private paths
  before posting. Share a small reproduction rather than a full transcript or instance dump.
- **Features and behaviour changes:** open an issue first. A short "what I am trying to do and what
  stops me" saves both of us a rewrite. Small, obvious fixes do not need an issue.

## Setting up

Node `^22 || ^24` is required. Running agents also needs a working `tmux` on macOS or Linux;
building and testing the CLI works on Windows too. Then:

```bash
git clone https://github.com/hasnain112e/squadron.git
cd squadron
npm ci
npm run build          # all workspaces (on Windows the TUI package still needs a POSIX shell to build)
npm test               # repo checks + daemon, cli, tui test suites
npm run lint           # typecheck every package
```

`npm test` builds the daemon and runs repository checks before the package suites. Read the
specific failure: `npm run mirror-skills` updates skill mirrors, and
`npm run generate-context-packs` updates generated packs. Use them when their source changed and
review the generated diff; neither command fixes every documentation failure. The UI unit-test
suite is advisory and separate: `npm run test:ui`.

For hands-on development, read the [check requirements](docs/reference/developing.md),
[worktree setup](docs/reference/worktree-builds.md), and
[machine changes](README.md#what-openrig-changes-on-your-machine). Use an isolated environment
for changes that start daemons or agents; `OPENRIG_HOME` alone does not isolate provider settings.
Permission configuration is an [explicit choice](docs/reference/getting-started.md#have-your-agent-configure-permissions).
A checked-out tree is not the installed daemon; restarting an installed daemon does not adopt
your working copy.

## Making the change

- One concern per pull request. Keep unrelated refactors separate; explain any refactor needed
  for the fix.
- Keep the diff small enough to review in one sitting. If it is not, say why in the description.
- Add or update a test where the change is testable. Use focused deterministic tests where
  possible. For terminal or provider behaviour, state what was exercised with the actual runtime
  and what was simulated; a stub alone does not prove the native interaction works.
- Do not edit `CHANGELOG.md`. The maintainer writes release notes at the tag.
- Do not bump versions.
- Match the surrounding style. `npm run lint` typechecks; it does not format code.
- Write commit messages in the form the log already uses: `fix(cli): …`, `feat(daemon): …`,
  `docs(reference): …`, `harness: …`.

## The pull request

Fill in the template. The three things a reviewer needs are: what a user gets, how you verified
it, and anything you were unsure about. State the revision and relevant local changes you tested,
what you actually ran, and any checks you could not run. Redact private information from evidence.

Contributions follow the repository's [Apache-2.0 license](LICENSE). Preserve attribution and any
applicable license notices when adapting third-party material.

## What to expect

Squadron is small and early, and makes no response-time commitment yet. Small, well-tested changes
are the easiest to review.

## Where things live

- Repository reference: `docs/reference/`.
- Skills: `packages/daemon/specs/agents/shared/skills/` and plugin skills under
  `packages/daemon/assets/plugins/`; static context-pack sources: `packages/daemon/context-packs-src/`.
  Generated packs live in `packages/daemon/context-packs/` and are not hand-edited or committed.
- Releases: none yet.
