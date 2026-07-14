# Vantage Desktop

Vantage Desktop is the Windows-first Tauri 2 shell for the Vantage Zig renderer.
It finds local Java Edition saves, renders them without modifying the source
world, and opens the generated tile tree in the existing GPU-accelerated
Vantage viewer.

## Architecture

```text
React + Vite UI
    │ Tauri commands / progress events
Rust host
    ├─ bundled `vantage-core` Zig sidecar
    └─ loopback-only static render endpoint
Zig core
    ├─ launcher-aware world discovery
    ├─ NBT metadata
    └─ parallel world render pipeline
```

The sidecar protocol is intentionally line-delimited and versionable:

- `vantage desktop-discover` emits `VANTAGE_WORLD <json>` records.
- `vantage desktop-render <save> <out>` emits `VANTAGE_PROGRESS <json>` records.

Normal CLI diagnostics may still appear around those records. The host ignores
unprefixed output, so human CLI output and the desktop contract can evolve
independently.

## Development

Requirements: Zig 0.16, Rust stable, Node 18+, and the Windows WebView2 runtime.
All development commands run from the repository root:

```powershell
just dev       # full native app; installs changed dependencies automatically
just dev-ui    # Vite browser loop with mock worlds; no Rust/Zig required
just doctor    # actionable prerequisite diagnostics
```

Vite hot-reloads React/CSS changes. Cargo's build script builds the Zig core in
`ReleaseFast` and copies the target-suffixed executable into Tauri's sidecar
bundle. It only rewrites the bundled file when its contents change.

Useful checks:

```powershell
just check
```

Production packaging is `just desktop-build`. Generated renders live under
the operating system's local data directory at `Vantage/renders/<world-id>`.
The embedded file endpoint binds to `127.0.0.1` on an ephemeral port, rejects
path traversal, and only serves the currently selected render tree.
