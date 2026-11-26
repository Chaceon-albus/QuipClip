# 032. Keep the frontend in one chunk, and warn above a size limit

- Status: Accepted
- Date: 2026-09-24
- Deciders: capric98
- Amended by: ADR 038

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
about 40 percent above the entry chunk. On 2026-09-24 that rule gave a limit of 1200 kB. The
dated notes below give each later limit.

The limit is an alarm for an unexpected size increase, such as an import that pulls in a
full icon set. When the warning shows, find the part that grew before you raise the limit.

(Changed on 2026-10-02.) The Settings window loads the same chunk and renders its own root, chosen by the label of the window (ADR 038).

(Changed on 2026-11-26.) The limit is now 1700 kB. The entry chunk was 1,199 kB, and the Export
Order dialog of ADR 066 takes it to 1,216 kB, so the warning showed again. A measurement from
the source map of that build gave these parts:

- About 720 kB is application code. On 2026-09-24 it was about 413 kB. The largest parts are the
  timeline components (103 kB), the Settings components (85 kB), the two message catalogs
  (80 kB) and the layout components (78 kB).
- About 494 kB is dependencies. `react-dom` is still the largest, at about 207 kB, and then
  `i18next` at about 50 kB. No dependency is larger than expected.

In two months the application code grew by about 307 kB, and the dependencies by about 71 kB.
No part is an unexpected import. The frontend stays in one chunk, because Tauri loads it from
the application. The new limit is about 40 percent above the chunk of 1,216 kB, by the rule of
this record.

## Consequences

- `pnpm build` shows no chunk size warning.
- The frontend has no lazy loading and no `Suspense` states for the dialogs.
- Usual growth of the application will make the warning show again. At that time, measure
  the bundle again. Then choose between a higher limit and a dynamic import of a large part
  that opens on request.
