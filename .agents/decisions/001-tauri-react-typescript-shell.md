# 001. Build the application on Tauri v2 with React and TypeScript

- Status: Accepted
- Date: 2026-08-29
- Deciders: capric98

## Context

QuipClip must run on Windows and macOS. It must start a command-line `ffmpeg` process,
read its progress output, and show a video preview with frame-level accuracy. The user
asked for pnpm, TypeScript, and an established component library.

Three shell technologies can do this work:

- **Electron** bundles Chromium. Every platform then decodes video the same way, and the
  installer is near 100 MB. Electron also gives no memory-safe process layer.
- **Tauri v2** uses the operating system web view (WebView2 on Windows, WKWebView on
  macOS) and a Rust backend. The installer is near 10 MB. The two web views support
  different video codecs, which ADR 003 must solve.
- **A native toolkit** (Qt, egui) removes the web view problem but costs much more time
  for the timeline and the preview UI.

## Decision

Use Tauri v2 with a Rust backend and a React 19 + TypeScript frontend.

- Build tool: Vite 8.
- Styles: Tailwind CSS 4 with the `@tailwindcss/vite` plugin.
- Components: shadcn/ui, which copies source into the repository instead of adding a
  dependency.
- State: Zustand, split into slices.
- Package manager: pnpm.

Rust owns every operation that touches the file system, spawns a process, or downloads a
file. The frontend owns presentation and the edit state. The two sides talk through Tauri
commands and events.

## Consequences

- The installer stays small and no Chromium copy ships with the application.
- Process control, checksum checks, and archive extraction run in Rust, not in JavaScript.
- The web view decodes different codec sets on each platform. ADR 003 handles this.
- The team must maintain two languages and keep the shared data model in step. ADR 002
  defines the shared time type on both sides.
- shadcn/ui source lands in `src/components/ui/`. It is generated code, so it commits
  separately from hand-written code. See ADR 009.
