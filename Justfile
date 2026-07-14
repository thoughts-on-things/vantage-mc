# Local dev for vantage-mc — the Minecraft world → 3D web map renderer.
#
# Install just: https://just.systems  (`brew install just`).
# List recipes:  `just`   ·   run one:  `just test`
#
# Paths are overridable per-invocation or via env vars, e.g.
#   just region=/path/to/r.0.0.mca demo
#   VANTAGE_CACHE=/somewhere just mesh
# A render needs extracted assets + biome data; see `just extract`.

# Extracted client assets+data (resource pack, biome data pack, lang). See README.
home   := if os() == 'windows' { env_var('USERPROFILE') } else { env_var('HOME') }
cache  := env_var_or_default('VANTAGE_CACHE', home / '.cache/vantage/assets/default')
assets := cache / 'assets/minecraft'

# Test world region file (override with VANTAGE_REGION or `just region=...`).
region := env_var_or_default('VANTAGE_REGION', 'path/to/world/region/r.0.0.mca')

# Chunk rectangle for demo renders: cx0 cz0 cx1 cz1 (region-local, 0..31).
range := '0 0 10 15'

bin    := 'zig-out/bin/vantage'
port   := '8753'
# Chrome binary for the headless `shot` recipe (override with VANTAGE_CHROME).
chrome := env_var_or_default('VANTAGE_CHROME', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')

# Print the recipe list (default when running `just`).
_default:
    @just --list --unsorted

# Build the vantage binary into zig-out/bin.
build:
    zig build

# Build the standalone viewer bundle, then a binary that embeds it — this is
# what release binaries ship, so `vantage serve` carries the whole viewer.
build-full:
    cd web && npm run build:viewer
    zig build -Doptimize=ReleaseFast

# Run all unit tests.
test:
    zig build test

# Format every Zig source in place.
fmt:
    zig fmt .

# Check formatting without modifying (what CI enforces).
fmt-check:
    zig fmt --check .

# Everything CI runs, in order: format check, tests, build.
ci: fmt-check test build

# Run the binary with arbitrary args, e.g. `just run resolve {{assets}} minecraft:stone`.
run *args: build
    {{bin}} {{args}}

# Block histogram for one chunk: `just histo [lx] [lz]`.
histo lx='0' lz='0': build
    {{bin}} histo {{region}} {{lx}} {{lz}}

# Biome histogram over the whole region (chunks 0,0..31,31).
biomes: build
    {{bin}} biomes {{region}} 0 0 31 31

# Mesh a textured + biome tile into web/public/ (override the area with `just range='0 0 31 31' mesh`).
mesh: build
    {{bin}} meshtex {{region}} web/public/terrain.vtile {{assets}} {{range}}

# Install the web package's dependencies (first-time setup for the viewer).
web-install:
    cd web && npm install

# Desktop studio — just is the public interface; the root npm runner handles
# prerequisite diagnostics and lockfile-aware workspace bootstrapping.
setup:
    npm run setup

dev:
    npm run dev

dev-ui:
    npm run dev:ui

doctor:
    npm run doctor

check:
    npm test

desktop-build:
    npm run build

# Render a whole world save into the viewer: `just render "~/…/saves/My World"`.
# Auto-finds the region dir + cached assets. Extra args pass through (e.g. --radius 8).
render save *args: build
    {{bin}} render "{{save}}" {{args}}

# Serve the web viewer with the Vite dev server (Ctrl-C to stop). Needs `just web-install` once.
serve:
    @echo "→ http://127.0.0.1:{{port}}/   (press B for the biome layer)"
    cd web && npm run dev

# Full loop: mesh the demo area, then serve the viewer.
demo: mesh serve

# ---- the marketing/demo site (site/ → vantage.beacon-mc.io) ----

# One-time site setup: install deps and build the linked vantage-mc package.
site-install:
    cd web && npm install && npm run build
    cd site && npm install

# Render the committed demo world into the site dev server (once, ~3 s).
site-demo: build
    {{bin}} render site/demo-world --caves full --out site/public/demo

# Serve the site locally (needs `just site-install` and `just site-demo` once).
site-serve:
    @echo "→ http://127.0.0.1:8754/"
    cd site && npm run dev

# Extract the assets + biome data + lang a render needs (built into the binary;
# `just extract` auto-discovers the newest jar in .minecraft/versions).
extract jar='': build
    {{bin}} extract {{jar}}

# Headless viewer screenshot to OUT (PATH e.g. '#biome'): `just shot docs/b.png '#biome'`.
shot out='shot.png' path='/':
    #!/usr/bin/env bash
    set -euo pipefail
    cd web && npm run dev >/dev/null 2>&1 &
    pid=$!
    trap 'kill $pid 2>/dev/null || true' EXIT
    for i in $(seq 1 30); do curl -sf -o /dev/null "http://127.0.0.1:{{port}}/" && break; sleep 0.5; done
    "{{chrome}}" --headless=new --disable-gpu --enable-unsafe-swiftshader --hide-scrollbars \
      --window-size=1280,800 --virtual-time-budget=9000 \
      --screenshot="{{out}}" "http://127.0.0.1:{{port}}{{path}}"
    echo "wrote {{out}}"

# Remove build artifacts.
clean:
    rm -rf zig-out .zig-cache
