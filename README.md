# QuipClip

<img src="src/assets/brand/app-icon.svg" alt="" width="96" align="right">

Mark in and out points on a video, then export the marked segments joined in order.

QuipClip is a small video editor for Windows and macOS. It does one job. You open a video,
you mark the parts you want, and you export them as one file. There is one track and there
are no effects.

## Status

Early. Import, playback, PTS-based marking, the source timeline, and export are
implemented. QuipClip also finds `ffmpeg` and reports which encoders work on your machine.
It does not yet download `ffmpeg`, and it does not yet save a project file.

## How it works

- The preview plays the file in the operating system web view. A planned fallback will
  build an ffmpeg proxy when the web view cannot decode the source.
- Every edit boundary is a presentation timestamp from the source video stream. This model
  preserves variable-frame-rate timing and keeps each source in its own timestamp domain.
- The preview infers source PTS from browser-presented frames through a calibrated linear
  mapping. When precise mapping is unavailable, playback remains available and edit actions
  are disabled.
- Segments use half-open `[inPts, outPts)` boundaries. The renderer seeks each input, cuts
  on the raw source PTS with `trim`, then normalizes and joins the segments in project
  order.

## ffmpeg

QuipClip does not bundle `ffmpeg`. It looks in this order:

1. A path you set in the application settings.
2. Your `PATH`.
3. Its own application data directory.
4. It asks you, and then downloads a copy. This step is planned; it is not implemented.

After it finds the programs, it tests which encoders work on your machine, and marks the
ones that do not work.

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
