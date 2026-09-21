# VaultChat coding workflow

Use OpenSpec to define meaningful feature changes and Ponytail to keep their
implementation small and correct. Explicit user requirements take precedence.

## OpenSpec

- Read `openspec/config.yaml` before planning or implementing a feature; its
  architecture, security, and delivery conventions apply throughout the work.
- Start with `openspec list --json`. Reuse a relevant active change instead of
  creating a competing proposal. Read its status, specs, design, and tasks.
- Use the `openspec-propose` skill for new feature proposals and the
  `openspec-apply-change` skill to implement an existing change. Load the skill
  for the operation being performed; the project copies are in `.codex/skills/`.
- Keep artifacts consistent with the implementation. A small fix or tooling
  setup does not need a new proposal unless it changes specified behavior.
- Validate changed artifacts with `openspec validate <change> --strict`.
- Distinguish written, deployed, and device-verified work. Sync delta specs and
  archive only when the delivery conditions in `openspec/config.yaml` are met.

## Ponytail

Use the installed Ponytail skill for implementation and its review skill for
the resulting diff. These project rules also apply when plugin hooks are not
available:

- Trace the affected flow and callers before editing. Fix the shared root cause.
- Reuse existing code, the standard library, native platform features, and
  installed dependencies before introducing new code or packages.
- Implement all requested behavior with the smallest clear, correct change.
  Avoid speculative abstractions and unrelated cleanup.
- Preserve trust-boundary validation, data-loss protection, security,
  accessibility, and the project's existing behavioral requirements.
- Document a deliberate shortcut with a `ponytail:` comment only when it has a
  real limitation; name that limitation and the condition for replacing it.
- Before finishing, review the diff for unnecessary complexity and run checks
  appropriate to the change. Use existing focused selftests where possible.

## Checks

- General tests: `npm test`
- Lint: `npm run lint`
- Type checking: `npm run typecheck`
- OpenSpec: `openspec validate --all --strict --no-interactive`

Report what was checked and any existing failures. Never report a deployment or
device verification based only on local tests.

## Terminal output

Use RTK (Rust Token Killer) for supported verbose commands when available, as
requested by the user. Preserve command exit codes and full failure logs; use
unfiltered source/output whenever compression could hide details needed for a
correct review. Fall back to the original command if RTK is unavailable.
