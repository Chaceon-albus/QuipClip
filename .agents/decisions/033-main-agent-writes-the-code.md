# 033. The main agent writes the code, and another tool runs only on request

- Status: Accepted
- Date: 2026-09-24
- Deciders: capric98
- Supersedes: ADR 008
- Amends: ADR 009, ADR 011

## Context

ADR 008 split the work across agent tools. The main agent orchestrated and wrote no
feature code. `agy` with Gemini wrote the frontend. A Claude Opus subagent wrote the Rust.
The user could name `codex` or `claude` for a task. ADR 011 added a Gemini language review
through `agy` before each catalog commit.

On 2026-09-24 the user withdrew that working method. A task no longer requires `agy` for
the frontend, and the main agent no longer only orchestrates. Another agent tool, such as
`agy` or `codex`, runs only when the user asks for it.

Some rules of ADR 008 do not depend on the routing: the independent review, the Opus tier,
the location of the gate, and the `cargo test` rule. This record keeps them, so that
ADR 008 can retire as a whole.

An agent that reviews its own work finds fewer faults than a second agent. The first agent
already accepted every choice it made. That reason for the independent review still
holds.

## Decision

**The main agent writes the code.** The main agent is the agent that the user talks to. It
writes the frontend and the Rust backend in the same way. It also owns the ADRs,
`docs/architecture.md`, the verification gate, and every commit.

The main agent can give a unit to a subagent of its own tool. One example is two units
that touch different files: two subagents can write them at the same time, each in its own
worktree. A subagent never writes an ADR, and it never runs `git commit`.

**Another agent tool runs only on request.** Do not run a different agent tool, such as
`agy` or `codex`, unless the user asks for it. The request has the scope that the user
gives it. When the user gives no scope, the request covers one task. When the user asks
for a tool:

- Run the model that the user names. When the user names no model, run the newest model
  that the tool offers. When the tool offers more than one model family, ask the user
  which family to run.
- A run failed when the command is missing, when it exits non-zero, **or when
  `git status --porcelain` shows no change**. A command-line agent can exit zero and write
  nothing.
- On a failure, tell the user. Then the main agent writes the unit.

**The model tier.** A Claude subagent runs the newest Claude Opus model. A writer runs at
medium reasoning. A reviewer starts at high reasoning. The user compared two candidates.
The newest Claude Opus model at medium reasoning gives better results than the newest
Claude Sonnet model at maximum reasoning. It also costs less.

A document names a family and a reasoning level. It never names a version, because a
vendor publishes a new version every few months and a pinned version goes stale. The
commit trailer is the one exception. A trailer records what ran, so it names the exact
model. See ADR 009.

**The review.** The reviewing agent is never the writing agent. A subagent that did not
write the diff reviews it. This rule applies when the main agent wrote the diff, and also
when a subagent or another agent tool wrote it. The reviewer runs at a higher reasoning
level than a writing subagent. It reads the diff against the ADRs and against the
acceptance criteria. For a catalog change, it also checks the English and Simplified
Chinese text. ADR 011 states that check.

**The gate.** The `dev-workflow` skill states the gate, in section 5. It is the only
normative copy. This record does not restate the commands. Four documents each carried a
copy once, and the copies disagreed about `cargo test`.

`cargo test` is required when the unit changed any file under `src-tauri/`. The main agent
may skip it otherwise. Continuous integration runs `cargo test` and `pnpm test` on every
push and every pull request, on both shipping platforms. A skipped local run therefore
delays the signal. It does not lose it.

**The operating detail.** The `dev-workflow` skill at
`.agents/skills/dev-workflow/SKILL.md` holds the steps and the commands. `AGENTS.md` holds
a short form only, because it loads on every turn. Claude Code reads skills from
`.claude/skills/`, and symlinks there point to `.agents/skills/`.

## Consequences

- A unit needs no model list, no brief for a second tool, and no check that the second
  tool wrote anything. That work returns only when the user asks for another tool.
- The frontend and the Rust backend follow the same path.
- The review stays independent. Each unit therefore still costs at least two agent runs.
- A catalog commit needs no `agy`. The independent reviewer checks the catalog text.
- This record supersedes ADR 008. The routing tables of ADR 008 no longer apply. Its
  review rule, its model tier, its gate rule, and its `cargo test` rule continue in this
  record.
- The skill keeps a short section for a run that the user asks for, so that the failure
  check survives.
- The skill must stay in step with this record. This record states the decision. The skill
  states the steps and the commands.
