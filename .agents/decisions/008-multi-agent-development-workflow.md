# 008. Delegate code writing, and review it with a different agent

- Status: Accepted
- Date: 2026-09-03
- Deciders: capric98

## Context

The user set the working method for this repository. The main agent orchestrates and
reviews. Other agents write the code. Frontend code goes to `agy` when that command works.
The user can name a different command-line agent for a task.

An agent that reviews its own work finds fewer faults than a second agent. The first
agent already accepted every choice it made.

A model name holds a version. A vendor publishes a new version of the same family every
few months. A document that names one version therefore goes stale, and the repository
keeps the old model until somebody edits that document. Nobody remembers to make that
edit.

## Decision

**Model selection.** Every delegated command runs the newest model that its vendor offers,
at the reasoning level the work needs.

| Command    | Vendor    | Model to run                                       |
| ---------- | --------- | -------------------------------------------------- |
| `agy`      | Google    | the newest Gemini model                            |
| `claude`   | Anthropic | the newest Claude model                            |
| `codex`    | OpenAI    | the newest OpenAI model                            |
| a subagent | Anthropic | the newest Claude Opus model, at medium reasoning  |

Name the family and the reasoning level in a document. Do not name a version.

The subagent row names one tier. The user compared the two candidates. The newest Claude
Opus model at medium reasoning gives better results than the newest Claude Sonnet model at
maximum reasoning. It also costs less. The table therefore states the tier. The
orchestrator does not choose the tier.

Before an agent run, ask the tool which models it offers. `agy models` prints the list.
Take the newest version, then run the agent with it. When a vendor offers more than one
family, take the family that the routing table names, and then the newest version of that
family.

The commit trailer is the one exception. A trailer records what actually ran, so it names
the exact model, including its version. See ADR 009.

**Routing.**

| Work                                                | First choice                                        | Fallback                       |
| --------------------------------------------------- | --------------------------------------------------- | ------------------------------ |
| Frontend (`.ts`, `.tsx`, `.css`)                    | `agy` with the newest Gemini Flash at high reasoning | a subagent at medium reasoning |
| Rust and backend                                    | a subagent at medium reasoning                       | —                              |
| A command the user named (`codex`, `claude`, `agy`) | that command                                         | a subagent at medium reasoning |

A run has failed when the command is missing, when it exits non-zero, **or when
`git status --porcelain` shows no change**. The third case matters. A command-line agent
can exit zero and write nothing. On any failure, use the fallback. Say which fallback ran.

**The loop.** brief, write, review, apply, verify, commit.

- The writing agent receives the file paths, the ADR numbers that constrain the work, and
  the English-comment rule. It must not touch `.agents/private/`. It must not write an ADR.
- The reviewing agent is never the writing agent. It runs at a higher reasoning level than
  the writer. It reads the diff against the ADRs and against the acceptance criteria.
- The main agent owns orchestration, the ADRs, `docs/architecture.md`, the verification
  gate, and every commit. A writing subagent never runs `git commit`.

**Gate.** The `dev-workflow` skill states the gate, in section 5. It is the only
normative copy. This record deliberately does not restate the commands: four documents
each carried their own copy once, they disagreed about `cargo test`, and ADR 009 condition
3 gave no way to tell which one a commit had met.

One rule from that gate belongs in a record rather than in a skill, because it is a
decision and not an operating detail. `cargo test` is required when the unit changed any
file under `src-tauri/`, and the main agent may skip it otherwise. Continuous integration
runs `cargo test` and `pnpm test` on every push and every pull request, on both shipping
platforms, so a skipped local run delays the signal and does not lose it.

The operating detail lives in the `dev-workflow` skill at
`.agents/skills/dev-workflow/SKILL.md`, not in `AGENTS.md`. `AGENTS.md` loads on every
turn. The routing detail only matters when an agent writes code, so it belongs in a skill
that loads on demand.

## Consequences

- The review is independent, so it catches faults the writer accepted.
- Each unit costs at least two agent runs. That is the price of the independent review.
- A new model version reaches the repository without a document change. The routing rule
  names a family, and the run resolves the version.
- An agent must list the available models before it starts a writing run. That list costs
  one command.
- A model family that a vendor retires does need a document change. The rule removes the
  version from the document. It does not remove the family.
- The skill file must stay in step with this ADR. The ADR states the decision. The skill
  states the commands.
- Claude Code reads skills from `.claude/skills/`. The repository keeps its skills in
  `.agents/skills/`, so that other agent tools can read them too. Symlinks in
  `.claude/skills/` connect the two.
