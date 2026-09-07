# QuipClip — agent rules

QuipClip is a video editor for Windows and macOS. The user opens a video, marks several
In and Out pairs on one timeline, and exports those segments joined in order. A
command-line `ffmpeg` does the export. The application never bundles `ffmpeg`.

Version 1 edits one source. Several sources come later. Multi-track is out of scope and
stays out of scope.

## Stack

| Part            | Choice                                      |
| --------------- | ------------------------------------------- |
| Shell           | Tauri v2, Rust backend                      |
| Frontend        | React 19, TypeScript, Vite 8                |
| Styles          | Tailwind CSS 4, shadcn/ui on the radix base |
| State           | Zustand                                     |
| Package manager | pnpm                                        |

Hold TypeScript at 5.9. `typescript-eslint` caps its peer range below 6.1.

## Layout

```
src/            React frontend
  components/ui/    shadcn output. Generated code.
  components/       export, layout, preview, settings, timeline, transport
  features/         export, ffmpeg, media, playback, settings, timeline
  i18n/             the catalogs and the language resolver
  lib/              rational math, timecode, Tauri bindings
  styles/           globals.css holds the palette
  types/            the project document types
  assets/brand/     the icon master
src-tauri/      Rust backend
  src/ffmpeg/       locate, probe, capabilities, export
  src/settings/     the settings file
  src/fsutil.rs     atomic file replacement
  src/project/      the project file
  src/time.rs       the Rational type
docs/           architecture.md
.agents/        decisions, skills, private
```

## Commands

```bash
pnpm install
pnpm tauri dev            # run the application
pnpm lint                 # eslint
pnpm typecheck            # tsc --noEmit
pnpm build                # tsc and vite build
pnpm test                 # vitest
pnpm format:check         # verify Prettier formatting
pnpm format               # apply Prettier formatting
pnpm icons                # regenerate src-tauri/icons from the brand SVG

cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test                # required when the unit changed anything under src-tauri/
```

This is a reference list, not the gate. The `dev-workflow` skill states the gate in
section 5, and it is the only normative copy.

## Rules

### Language

- Write every code comment in English.
- Write every document in English.
- Run an English document through the `asd-ste100` skill before you finish it.

### Architecture decisions

- Record a decision in `.agents/decisions/NNN-title.md`. Use the next free number.
- State context, decision, and consequences.
- Name the new file in `docs/architecture.md`.
- Only the main agent writes an ADR.

Read the ADRs before you change the time model, the preview, the export pipeline, or the
ffmpeg lifecycle. Those four parts carry the accuracy requirement of the product.

### The private directory

`.agents/private/` holds files the user and the agents exchange, such as screenshots.

- Never commit anything under that path.
- Never name that path in a shipped file.
- Delete the intermediate files you created there.

### Writing code

Read the `dev-workflow` skill. It gives the routing rules, the review loop, the gate, and
the commit rules.

Short form: the main agent orchestrates, runs the gate, and commits. `agy` writes the
frontend. A subagent with the newest Claude Opus at medium reasoning writes the Rust. A
separate agent, never the writing agent, reviews at high reasoning.

Every delegated command runs the newest model its vendor offers. Never pin a model version
in a document. ADR 008 states the rule.

### Commits

- One reviewed unit, one commit, with a Conventional Commits message.
- Commit to the branch that is checked out. Never create, switch, or delete a branch.
- Never push.
- Stage the paths by name. Never run `git add -A`.

`.agents/decisions/009-incremental-commit-policy.md` holds the full rules.

### Code style

- TypeScript is strict. `any` is a lint error.
- Rust must pass `cargo clippy -- -D warnings`.
- Run `pnpm format:check` before each commit.
- If the check fails, run `pnpm format`. Then run the check again.
- Prettier sorts the Tailwind classes. Do not sort them by hand.
- Prettier does not read `.agents/`. Two skills there are git submodules.
