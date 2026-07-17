# Vantage Desktop

Vantage Desktop is the Windows-first Tauri 2 shell for the Vantage Zig renderer.
It finds local Java Edition saves, renders them without modifying the source
world, and opens the generated tile tree in the existing GPU-accelerated
Vantage viewer.

Discovery includes Beacon Launcher instance saves on Windows, macOS, and Linux.
Beacon multiplayer worlds are authoritative on the server and are not cached as
Anvil saves by the Minecraft client; when Vantage runs on the Beacon host it
also discovers complete worlds under `~/.beacon/data`, or under
`$BEACON_PROJECT_DIR/data` for a custom project location.

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
- `vantage desktop-render <save> <out> [render flags]` emits `VANTAGE_PROGRESS <json>` records.

Normal CLI diagnostics may still appear around those records. The host ignores
unprefixed output, so human CLI output and the desktop contract can evolve
independently.

Frontend layout:

- `src/hooks/useLibrary.ts` — all library state and world actions. One world
  action runs at a time; the lock lives in a ref so same-tick double clicks
  cannot claim it twice.
- `src/components/` — presentational pieces (library screen, world cards,
  detail panel, settings sheet).
- `src/lib/` — pure helpers: formatting and the performance-mode profiles
  shared by the Zig bake and the GPU viewer.
- `src/styles.css` — the design tokens (color ramp, type scale, radii) and all
  component styles; rules never hardcode grays.

Rust host layout: `lib.rs` holds the Tauri commands and state, `assets.rs` the
loopback tile endpoint (responses stream from disk), `sidecar.rs` the
line-delimited protocol parsing.

## Desktop rendering

New desktop renders keep full cave geometry by default, so the GPU viewer can
open its depth-slice renderer with `C` and scrub from the surface to bedrock.
The settings sheet also controls smooth lighting and biome blending. A compact
render signature lives next to each cached map; changing a geometry setting
automatically refreshes that cache instead of opening incompatible tiles.

Performance profiles are applied to both halves of the native app:

- **Efficient** caps the Zig bake at roughly half the host's logical CPU threads
  and uses a smaller GPU streaming budget.
- **Balanced** lets the Zig memory planner choose the fastest safe worker count
  from the real host CPU and available memory.
- **Maximum** requests every logical CPU thread (while keeping the native RAM
  safety cap) and uses the viewer's largest tile, memory, and resolution budgets.

Rendering can be cancelled from the world detail panel. Closing the window also
terminates the sidecar, and source worlds are always opened read-only.

The first time a rendered world opens, the viewer waits for the initial terrain
stream to settle, captures a UI-free 480×320 map image, and stores a versioned
thumbnail beside the cached render. The library prefers that real preview over
Minecraft's often-stale `icon.png`; re-rendering invalidates it so the next
viewer load captures the new terrain.

Rendered worlds expose two maintenance actions in the detail panel.
**Regenerate preview** removes only the cached thumbnail and opens the existing
map to capture a fresh one. **Reset render** removes the complete generated map,
signature, and thumbnail after confirmation. Both operations are restricted to
Vantage's hashed cache directory and never modify the source Minecraft save.

## Development

Requirements: Zig 0.16, Rust stable, Node 18+, and the Windows WebView2 runtime.
All development commands run from the repository root:

```powershell
just desktop     # full native app; installs changed dependencies automatically
just desktop-ui  # Vite browser loop with mock worlds; no Rust/Zig required
just site        # marketing site + linked viewer
just doctor      # actionable prerequisite diagnostics
```

The server-starting recipes free their expected local port before launch, so a
stale Vite process from an interrupted session does not require manual cleanup.

Vite hot-reloads React/CSS changes. Cargo's build script builds the Zig core in
`ReleaseFast` and copies the target-suffixed executable into Tauri's sidecar
bundle. It only rewrites the bundled file when its contents change.

Useful checks:

```powershell
just verify
```

Production packaging is `just package`. Generated renders live under
the operating system's local data directory at `Vantage/renders/<world-id>`.
The embedded file endpoint binds to `127.0.0.1` on an ephemeral port, rejects
path traversal, and only serves the currently selected render tree.

Pull requests compile the production app and sidecar on Windows without
creating installers. Release Please builds both the NSIS `.exe` and MSI on a
version tag, signs them with the shared ThoughtsOnThings Microsoft Artifact
Signing profile, verifies their Authenticode signatures, and attaches them to
the GitHub release. Actions → Release → Run workflow can exercise the signed
build before a release by enabling `build_desktop`.
