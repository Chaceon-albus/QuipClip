---
name: dev-workflow
description: "Use when you write, change, or review code in the QuipClip repository. It gives the review loop, the verification gate, and the commit rules, and it says when another agent tool may run. Triggers: implement a feature, fix a bug, refactor, add a component, add a Tauri command, review a diff, commit finished work."
---

# QuipClip development workflow

The main agent writes the code. A second agent reviews it. The main agent runs the gate
and commits. This skill states who does what, and in which order.

The decision behind this workflow is in `.agents/decisions/033-main-agent-writes-the-code.md`.
The commit rules are in `.agents/decisions/009-incremental-commit-policy.md`.

## 1. Write the code

The main agent is the agent that the user talks to. It writes the frontend and the Rust
backend in the same way.

The main agent can give a unit to a subagent of its own tool. One example is two units
that touch different files: two subagents can write them at the same time, each in its own
worktree. Give each subagent the brief in section 3. A Claude subagent that writes code
runs the newest Claude Opus at medium reasoning.

Do not run a different agent tool, such as `agy` or `codex`, unless the user asks for it.
Section 2 applies only then.

A document names a model family and a reasoning level. It never names a version. The
commit trailer is the one exception, because it records what ran.

## 2. Run another agent tool when the user asks

Use this section only when the user names an agent tool for a task. The request has the
scope that the user gives it. When the user gives no scope, the request covers one task.

Run the model that the user names. When the user names no model, run the newest model that
the tool offers. When the tool offers more than one model family, ask the user which
family to run. `agy models` lists the models of `agy`.

```bash
agy -p "<brief>" --model <model-id> --mode accept-edits
codex exec "<brief>"
claude -p "<brief>" --permission-mode acceptEdits
```

Give the tool the brief in section 3.

A run **failed** when any of these is true:

1. The command does not exist.
2. The command exits non-zero.
3. `git status --porcelain` shows no change.

Check condition 3 every time. A command-line agent can exit zero and write nothing.

When a run fails, tell the user. Then the main agent writes the unit.

## 3. Write the brief

Give a subagent or another agent tool all of this:

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

The reviewing agent is **never** the writing agent. A subagent that did not write the diff
reviews it. This applies when the main agent, a subagent, or another agent tool wrote the
diff. A Claude reviewer runs the newest Claude Opus. Start the reviewer at high reasoning.
A reviewing agent at medium reasoning does not satisfy this rule.

The main agent can raise the reviewer to `xhigh` reasoning. Raise it when the change
carries more risk than a usual change. The time model, the export pipeline, the preview,
the ffmpeg lifecycle, and a wire contract are examples. Raise the level only when the work
needs it, because a higher level costs more.

Give the reviewer the diff, the ADR numbers, and the acceptance criteria. Ask it to find
faults, not to approve. Ask it to mark each finding BLOCKING or NON-BLOCKING. For a
catalog change, also give it the text that ADR 011 lists for the language check.

Apply the blocking findings. Review again only when the fix is large enough to carry new
risk.

## 5. Verify

This section is the gate. `AGENTS.md`, `docs/architecture.md` and ADR 033 point here
rather than restating it, because four copies drifted into four different gates once
already.

Run this from the repository root, every time:

```bash
pnpm format:check
pnpm lint && pnpm typecheck && pnpm build && pnpm test
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings
```

Then run `cargo test` inside `src-tauri/` **when the unit changed any file under
`src-tauri/`**. When the unit changed no Rust, the main agent may skip it.

The reason the skip is safe, and the reason it is only a skip: `.github/workflows/ci.yml`
runs `cargo test` and `pnpm test` on every push to `main`, on every pull request, and on
demand, on `windows-latest` and on `macos-latest`. A local run that is skipped therefore
delays the signal. It does not lose it. Nothing else in this list may be skipped, because
nothing else is cheap enough for the delay to be worth it.

A gate step that does not exist yet is not a failure.

## 6. Commit

Commit when all four conditions hold:

1. The unit is complete.
2. The review raised no blocking finding.
3. The gate in section 5 passed.
4. `git status --porcelain` lists only the files of this unit.

Message format:

```
<type>(<scope>): <subject>

<why the change exists, wrapped at 72 columns>

Refs: ADR-003
Assisted-By: <tool>/<model-id>
Reviewed-By: subagent/<model-id>
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
Scopes: `timeline`, `preview`, `export`, `ffmpeg`, `project`, `settings`, `time`, `ui`,
`theme`, `icons`, `tauri`, `agents`, `adr`, `deps`.

Add `Assisted-By` when a subagent or another agent tool wrote the diff. Omit it when the
main agent wrote the diff. Add `Reviewed-By` for the reviewer. Write the model you
actually ran, with its version. The trailer is a record of one run, so it is the one place
that names a version.

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
