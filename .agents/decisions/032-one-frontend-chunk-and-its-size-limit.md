# 032. Keep the frontend in one chunk, and warn above 1200 kB

- Status: Accepted
- Date: 2026-09-24
- Deciders: capric98

## Context

`pnpm build` makes one JavaScript entry chunk. On 2026-09-24 that chunk was 866 kB after
minification. About 413 kB of it is application code and about 423 kB is dependencies. The
largest dependency is `react-dom`, at about 174 kB. No dependency is larger than expected.

Vite warns when a chunk is larger than 500 kB. That default is a web heuristic. A browser
downloads each chunk over a network, so a large chunk delays the first paint.

QuipClip does not download its frontend. Tauri serves `dist/` to the system web view from
the application bundle, through its own protocol (ADR 001). Each release replaces all of
`dist/`, so a browser cache of a vendor chunk never helps.

Vite gives three ways to remove the warning:

- **Dynamic `import()`** of the parts that open on request, such as the export and settings
  dialogs. This defers the parse of that code. On a chunk of this size, the saving is
  probably tens of milliseconds. Each deferred part needs a `Suspense` state, and it opens
  after a short delay the first time.
- **Rolldown `codeSplitting` groups**, for example one chunk for the dependencies. This puts
  the same code in more files. It helps only a browser cache.
- **`build.chunkSizeWarningLimit`**, which moves the threshold of the warning.

## Decision

Keep the frontend in one entry chunk. Set `build.chunkSizeWarningLimit` in `vite.config.ts`
to 1200 kB. That is about 40 percent above the entry chunk of 2026-09-24.

The limit is an alarm for an unexpected size increase, such as an import that pulls in a
full icon set. When the warning shows, find the part that grew before you raise the limit.

## Consequences

- `pnpm build` shows no chunk size warning.
- The frontend has no lazy loading and no `Suspense` states for the dialogs.
- Usual growth of the application will make the warning show again. At that time, measure
  the bundle again. Then choose between a higher limit and a dynamic import of a large part
  that opens on request.
