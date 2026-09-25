# 009. Commit each reviewed unit, and never push

- Status: Accepted
- Date: 2026-08-29
- Deciders: capric98
- Amended by: ADR 033

## Context

An agent can produce a large diff in one turn. If that diff lands as one commit, the
history records "add the editor" and nothing more. Nobody can then read the history to
learn why a choice was made, and nobody can revert one part of it.

The user asked for a trackable history. Commit each finished unit as the work goes. Do not
batch many changes into one commit.

## Decision

**Commit when all four conditions hold.** Do not wait for the end of the task.

1. The unit is complete. It compiles, it does what it claims, and nothing else in the
   repository points at a file that does not exist yet.
2. The review passed. An independent agent read the diff and raised no blocking finding.
3. The gate passed. Section 5 of the `dev-workflow` skill states it, and it is the only
   normative copy. `cargo test` is part of it when the unit changed any file under
   `src-tauri/`. ADR 033 records why the main agent may skip it otherwise. This condition
   once read "at the strictest level available at that moment", which was written before
   the scaffold existed and gave no way to tell whether a commit had met it.
4. `git status --porcelain` lists only the files of this unit. If it lists more, stage by
   name instead of staging everything.

**One unit is one of these.**

| Unit                      | Example                                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| One decision record       | One ADR file, one commit. Reverting one decision must not disturb another.                                           |
| One module or component   | `TimelineRuler.tsx` with its types and its test.                                                                     |
| One configuration concern | All the lint and format configuration. Not lint plus a feature.                                                      |
| One dependency change     | A version change and its lockfile, alone.                                                                            |
| One generated output      | The `tauri icon` output, or a batch of `shadcn add` components. Generated code never travels with hand-written code. |

Never join a refactor to a behaviour change. Never join a rename to an edit. When a unit
contains two units, commit twice.

**Message format.**

```
<type>(<scope>): <subject>

<why the change exists, wrapped at 72 columns>

Refs: ADR-003
```

- Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`,
  `revert`.
- Scopes: `timeline`, `preview`, `export`, `ffmpeg`, `project`, `settings`, `time`, `ui`,
  `theme`, `icons`, `tauri`, `agents`, `adr`, `deps`.
- Subject: imperative, lower case, no full stop, 72 characters or fewer. Write "add
  rational time type", not "added" and not "adds".
- Body: state why. The diff already states what. Omit the body only when the subject is
  complete on its own.
- `Refs: ADR-00N` whenever the commit implements, changes, or supersedes a decision.
- `BREAKING CHANGE:` in the footer for a change to the project file schema (ADR 010) or to
  the Tauri command surface.

**Attribution trailers.** Record who wrote the code and who reviewed it. `Assisted-By`
names a subagent or another agent tool that wrote the diff. Omit it when the main agent
wrote the diff.

```
Assisted-By: <tool>/<model-id>
Reviewed-By: subagent/<model-id>
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

Do not invent an email address for a tool that has no identity. The bare `tool/model`
string is the point.

**Hard limits.**

- Never push. `git push` needs a direct instruction from the user, every time.
- Never create, switch, rebase, or delete a branch. Commit to the current branch. The user
  owns branching.
- Never amend and never force anything that is already committed.
- Never run `git add -A` and never run `git commit -a`. Stage the paths by name.
- Never commit a file under `.agents/private/`. Check `git status --porcelain` first.

This ADR documents the rules. The reviewing agent checks them. The repository installs no
`commitlint` and no git hook, because a hook would also police the commits the user writes
by hand.

## Consequences

- `git log --oneline` reads as a narrative of the work.
- `git revert` removes one decision.
- Each commit needs its own review pass, so a task produces more agent runs than one large
  commit would.
- The history stays local until the user pushes it. An agent never publishes anything.
