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
- `src/components/` — presentational pieces (app shell, library screen, world
  cards, detail panel, renders manager, settings and shortcut sheets).
- `src/lib/` — pure helpers: formatting, the render-state/sort/filter rules for
  the library, and the performance-mode profiles shared by the Zig bake and the
  GPU viewer.
- `src/styles.css` — the design tokens (color ramp, type scale, radii) and all
  component styles; rules never hardcode grays.

Rust host layout: `lib.rs` holds the Tauri commands and state, `assets.rs` the
loopback tile endpoint (responses stream from disk over keep-alive connections
and carry ETags), `renders.rs` the bookkeeping for generated renders,
`native.rs` the small OS integrations (PNG payloads, image exports, revealing a
folder), `window_state.rs` the remembered window box, and `sidecar.rs` the
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

Rendered worlds expose four maintenance actions in the detail panel.
**Re-render** rebuilds the map from the current save. **Regenerate preview**
removes only the cached thumbnail and opens the existing map to capture a fresh
one. **Show save folder** opens the world in the OS file manager. **Reset
render** removes the complete generated map, record, and thumbnail after
confirmation. Every destructive operation is restricted to Vantage's hashed
cache directory and never modifies the source Minecraft save.

## Keeping renders honest

Each render records the world it came from, its name, and when it was baked.
The library compares that timestamp against the save's `LastPlayed` and the
current detail settings, so a world is labelled before it is opened:

- **rendered** — the map matches the save and the current settings.
- **played since** — the world was played after the render; re-render to pick
  up the new chunks.
- **settings changed** — the render was baked with different geometry settings,
  so opening it rebuilds instead of showing something the settings no longer
  describe.

The library grid can be filtered (all / rendered / not rendered) and sorted by
recently played, name, or most recently rendered. Both choices persist.

## Renders manager

The **Renders** screen lists everything Vantage has generated on this PC with
its size on disk, file count, bake date, and detail settings, plus the total
disk usage. A render whose save has been deleted is flagged as a missing world
and can still be opened — the map is self-contained — or deleted to reclaim the
space. Deletion resolves the hashed render id inside Vantage's own renders
directory; ids are the only handle the frontend can pass back, and any other
shape is refused before it reaches the filesystem.

## Native integration

- The window remembers its size, position, and maximized state between
  launches, and falls back to centering when the stored box no longer lands on
  a connected monitor.
- Renders drive the Windows taskbar progress bar, so a minimized Vantage still
  shows how far along a bake is.
- **Save image** in the viewer toolbar writes the full-resolution canvas to
  `Pictures/Vantage` and offers to reveal it. The library's browser-download
  screenshot button is hidden in the desktop app, where a WebView would turn it
  into a download prompt.
- Folder-revealing commands accept only world saves, Vantage's own renders, and
  its export folder.
- No helper process may flash a terminal over the app. Release builds are
  GUI-subsystem binaries, the Zig sidecar is spawned by the shell plugin with
  `CREATE_NO_WINDOW`, and the file-manager helpers are started the same way
  with their stdio detached.

## Tile endpoint

The loopback endpoint keeps HTTP/1.1 connections alive across the hundreds of
tile fetches a pan produces, and answers every request with an ETag built from
the file's size and modification time. Responses are `no-cache` rather than the
previous `no-store`, so the WebView keeps them and revalidates with
`If-None-Match`: a tile that has not been rebaked comes back as an empty `304`
instead of being re-read from disk and re-sent on every revisit.

It serves two roots. Everything under the render currently open in the viewer
is reachable, because that is what streaming a map means. `/library/<render
id>/<image>` additionally reaches *any* render's preview, so the library grid
and the renders manager can display previews without base64-ing megabytes of
PNG through the IPC bridge on every scan. That second route only serves the
preview file name, only under generated render ids, and only after confirming
the resolved path stays inside the canonical renders directory. Preview URLs
carry the image's own timestamp, so regenerating a preview — which leaves the
render itself untouched — still changes what the WebView loads. World
`icon.png` files live in the save folder rather than anywhere Vantage owns, so
they remain small inline data URLs.

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
