---
name: dev-workflow
description: "Use when you write, change, or review code in the QuipClip repository. It gives the routing rules that decide which agent writes the code, the review loop, the verification gate, and the commit rules. Triggers: implement a feature, fix a bug, refactor, add a component, add a Tauri command, review a diff, commit finished work."
---

# QuipClip development workflow

The main agent orchestrates. Other agents write the code. A third agent reviews it. This
skill states who does what, and in which order.

The decision behind this workflow is in `.agents/decisions/008-multi-agent-development-workflow.md`.
The commit rules are in `.agents/decisions/009-incremental-commit-policy.md`.

## 1. Route the work

| Work | First choice | Fallback |
|---|---|---|
| Frontend: `.ts`, `.tsx`, `.css` | `agy` with the newest Gemini Flash at high reasoning | a subagent at medium reasoning |
| Rust and backend: `.rs`, `Cargo.toml`, `tauri.conf.json` | a subagent at medium reasoning | — |
| A command the user named | that command | a subagent at medium reasoning |

The user can name a command-line agent for a task. Obey that instruction. If the named
command fails, fall back to a subagent and tell the user which fallback ran.

The main agent never writes feature code. The main agent writes only these:

- `.agents/decisions/*.md`
- `docs/architecture.md`
- `AGENTS.md` and `CLAUDE.md`
- this skill

## 2. Start the writing agent

Every command runs the newest model its vendor offers: `agy` runs the newest Gemini,
`claude` runs the newest Claude, `codex` runs the newest OpenAI model. Resolve the version
at run time. Never pin one in this file.

```bash
agy models          # lists every model the tool offers
```

Take the highest version of the named family at the named reasoning level. Then run:

```bash
agy -p "<brief>" --model <resolved-model-id> --mode accept-edits
codex exec "<brief>"
claude -p "<brief>" --permission-mode acceptEdits
```

ADR 008 states the rule. A document names a family and a level. A run resolves the
version.

A run **failed** when any of these is true:

1. The command does not exist.
2. The command exits non-zero.
3. `git status --porcelain` shows no change.

Check condition 3 every time. A command-line agent can exit zero and write nothing.

## 3. Write the brief

Give the writing agent all of this:

- The exact file paths to create or change.
- The ADR numbers that constrain the work, and what those ADRs require.
- The acceptance criteria.
- These standing rules:
  - Write every code comment in English.
  - Do not touch `.agents/private/`. Do not name that path in any shipped file.
  - Do not write an ADR.
  - Do not run `git commit`.
  - Do not add a dependency without saying why.

## 4. Review

The reviewing agent is **never** the writing agent, and runs at a higher reasoning level
than the writer.

Give the reviewer the diff, the ADR numbers, and the acceptance criteria. Ask it to find
faults, not to approve. Ask it to mark each finding BLOCKING or NON-BLOCKING.

Apply the blocking findings. Review again only when the fix is large enough to carry new
risk.

## 5. Verify

Run the gate from the repository root:

```bash
pnpm format:check
pnpm lint && pnpm typecheck && pnpm build && pnpm test
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings
```

Run the strictest part of the gate that the current tree supports. A gate step that does
not exist yet is not a failure.

## 6. Commit

Commit when all four conditions hold:

1. The unit is complete.
2. The review raised no blocking finding.
3. The gate passed.
4. `git status --porcelain` lists only the files of this unit.

Message format:

```
<type>(<scope>): <subject>

<why the change exists, wrapped at 72 columns>

Refs: ADR-003
Assisted-By: agy/<model-id>
Reviewed-By: subagent/<model-id>
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
Scopes: `timeline`, `preview`, `export`, `ffmpeg`, `project`, `time`, `ui`, `theme`,
`icons`, `tauri`, `agents`, `adr`, `deps`.

Add `Assisted-By` when another agent wrote the diff. Add `Reviewed-By` for the reviewer.
Write the model you actually ran, with its version. The trailer is a record of one run,
so it is the one place that names a version.

**Hard limits.**

- Never push.
- Never create, switch, rebase, or delete a branch.
- Never amend a commit that exists.
- Never run `git add -A`. Never run `git commit -a`. Stage the paths by name.
- Never commit a file under `.agents/private/`.

Read ADR 009 for the full rules, including what counts as one unit.

## 7. Clean up

Delete the intermediate files you created in `.agents/private/`. That directory is a
workspace for exchange with the user, not a store.
