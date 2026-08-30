# QuipClip

<img src="src/assets/brand/app-icon.svg" alt="" width="96" align="right">

Mark in and out points on a video, then export the marked segments joined in order.

QuipClip is a small video editor for Windows and macOS. It does one job. You open a video,
you mark the parts you want, and you export them as one file. There is one track and there
are no effects.

## Status

Early. The application shell builds and runs. Import, playback, marking, and export are
not written yet.

## How it works

- The preview plays the file in the operating system web view. When the web view cannot
  decode the format, QuipClip builds a proxy with ffmpeg.
- Every edit point is a frame index on an exact rational timebase, so the export starts and
  ends on the frames the preview showed.
- The export runs `ffmpeg` once. It trims each segment and joins them in one pass.

## ffmpeg

QuipClip does not bundle `ffmpeg`. It looks in this order:

1. A path you set in the application settings.
2. Your `PATH`.
3. Its own application data directory.
4. It asks you, and then downloads a copy.

After it finds the programs, it tests which encoders work on your machine, and offers only
those.

## Build

Requirements: Node 22 or later, pnpm, and a Rust toolchain. See the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for the platform
libraries.

```bash
pnpm install
pnpm tauri dev      # run
pnpm tauri build    # package
```

## Documents

- [`docs/architecture.md`](docs/architecture.md) — the architecture, and the index of
  decision records.
- [`.agents/decisions/`](.agents/decisions) — one record per decision.
- [`AGENTS.md`](AGENTS.md) — the rules an agent follows in this repository.

## License

MIT. See [LICENSE](LICENSE).
