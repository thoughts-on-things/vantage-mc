# Contributing to Vantage

Thanks for your interest! Vantage is young and moving fast — issues, bug
reports, and PRs are all welcome.

## Repo layout

| Path | What it is |
| --- | --- |
| `src/` | The native generator (Zig): region/NBT parsing, model resolver, mesher, tile encoder |
| `web/` | The `vantage-mc` npm package (tile decoder, three.js renderer, React components) and its demo app |
| `vendor/` | Vendored C libraries (libdeflate, stb_image) — don't edit, update wholesale |

## Dev setup

You need [Zig](https://ziglang.org) **0.16.0** (the version is pinned —
pre-1.0 Zig breaks between releases) and **Node 18+**. The
[`Justfile`](./Justfile) ([`just`](https://just.systems)) wraps the loop:

```sh
just build         # zig build → zig-out/bin/vantage
just test          # zig build test
just fmt           # zig fmt .
just ci            # everything CI runs: fmt-check + test + build
just web-install   # npm install for web/
```

There are no system library dependencies — the C decompressors are vendored —
so `zig build` works out of the box on macOS, Linux, and Windows.

To render something you need assets extracted from a Minecraft client jar
(`just extract <client.jar>`, any 1.18+ version) and a world save. See the
[README](./README.md#quick-start).

### Web package

```sh
cd web
npm run dev        # Vite dev server at http://127.0.0.1:8753 (serves public/)
npm run typecheck  # tsc --noEmit
npm test           # vitest
npm run build      # tsup → dist/
```

`just render "<save>"` bakes tiles into `web/public/`, then `npm run dev`
serves the demo viewer over them.

## Before you open a PR

- `just ci` passes (CI runs the same: `zig fmt --check`, tests, build).
- For web changes: `npm run typecheck && npm test` in `web/`.
- New behavior comes with a test where practical — decoder/format changes in
  particular (there are inline `test` blocks in the Zig sources and vitest
  suites in `web/test/`).
- Changes to the tile format must stay versioned: bump the magic (`VTL*`,
  `VLR*`) or manifest `format` rather than silently changing the layout, and
  keep the decoder able to read every version the generator ever emitted.
- Keep PRs focused; separate refactors from behavior changes.

## Performance matters here

Performance is the project's #1 goal. For changes on the hot paths (parsing,
meshing, encoding, the viewer's frame loop): include before/after numbers in
the PR (the generator prints per-stage timings; the viewer has an FPS/frame
panel), avoid per-block allocations in inner loops (arena-per-region is the
pattern), and prefer data-oriented layouts.

## Reporting bugs

A great world-rendering bug report includes: the Minecraft version, the
generator command and its output, and — if you can — a small region file or
coordinates that reproduce it. Screenshots of wrong-vs-expected rendering help
a lot.
