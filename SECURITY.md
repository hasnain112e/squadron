# Security policy

## Supported versions

Squadron has no published package yet. Only the latest commit on `main` is supported. Include the
exact commit or the `squad --version` output when reporting a problem in an older checkout.

## What Squadron touches

Squadron inherits OpenRig's runtime. It runs a local daemon, drives coding agents in tmux sessions
on your machine, and writes configuration for those harnesses (for example under `~/.claude` and
`~/.codex`). The README section
[What OpenRig changes on your machine](README.md#what-openrig-changes-on-your-machine)
describes these effects and the trust/permission choices. Unexpected access, disclosure or
permission changes are useful reports; include what you expected and what you observed.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability.

Open the repository's [Security page](https://github.com/hasnain112e/squadron/security). If
**Report a vulnerability** is available, use it to send a private report to the maintainer.
Availability depends on the repository setting, not on this file being present.

If that option is unavailable, contact the maintainer through the contact details on the GitHub
profile of [@hasnain112e](https://github.com/hasnain112e) and ask for a private channel. Send only
the request: do not include the vulnerability details, reproduction, logs, credentials or affected
private systems in public. Wait for the private channel before sharing the report.

If the problem is in code inherited from OpenRig and also affects the upstream project, you can
report it there too, following the
[OpenRig security policy](https://github.com/mvschwarz/openrig/security/policy).

Include: the Squadron version, the harnesses involved, the steps to reproduce, and what an attacker
could do. A proof of concept is welcome; a working exploit against a third party's machine is not.

## What to expect

- This is a small project. Reports are acknowledged and assessed as time allows; no fixed deadline
  is promised.
- Disclosure and credit are agreed with you. You can ask to remain anonymous.

## Scope notes

- Squadron assumes the machine and the accounts it runs under are trusted by their owner. Reports
  that require a hostile local user with the same account are still welcome but are unlikely to be
  treated as high severity.
- A harness carrying out an intentionally authorized operation is not by itself evidence of a
  Squadron vulnerability. Reports of Squadron bypassing a chosen permission, changing trust
  unexpectedly, or routing data or actions to the wrong destination are in scope.
