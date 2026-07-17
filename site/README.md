# vantage.beacon-mc.io

The marketing + demo site for Vantage. Fully static: a landing page, a
dedicated `/server/` product and integration reference, and the real viewer
(`vantage-mc`, linked from [`../web`](../web)) streaming a demo world. Deployed to GitHub Pages by
[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) on every push
to `main`.

## Local development

```sh
just site-install   # once: npm deps + build the linked vantage-mc package
just site-demo      # once: render the demo world into site/public/demo (~3 s)
just site-serve     # → http://127.0.0.1:8754/
```

## The demo world

`demo-world/` is a trimmed copy of a vanilla survival save (`level.dat` + the
four central region files, ~30 MB — user-generated world data, no Mojang
assets). The Pages workflow renders it with a freshly built generator, using
textures extracted at build time from the official client jar on Mojang's CDN,
so nothing Mojang-owned is committed to the repo.

## The benchmark ("Measured, not promised")

Numbers and the terminal-replay data in `src/assets/race.json` come from real
runs on one machine — a 16-thread Windows desktop rendering the same
7,225-chunk world start-to-finish, output wiped between runs, asset caches
warm:

- `vantage render <save> --out map/` (ReleaseFast build)
- BlueMap CLI v5.22 (`java -Xmx4g -jar bluemap-5.22-cli.jar -r`,
  `render-thread-count: 16`, overworld only, Java 25)

To refresh: capture each command's output with a line-timestamping wrapper
(any `spawn`-and-timestamp script; events as `{t, line}` JSON), then bake with
`node scripts/build-race.mjs <vantage.json> <bluemap.json>` and update the
table in `src/Landing.tsx`.

## Deploy / custom domain

One-time repo setup:

1. **Settings → Pages** → Source: **GitHub Actions**; Custom domain:
   `vantage.beacon-mc.io` (then "Enforce HTTPS" once the cert is issued).
2. **DNS** (beacon-mc.io zone): `CNAME vantage → thoughts-on-things.github.io`.

The site builds with a relative base path, so the `*.github.io/vantage-mc/`
URL also works before the domain is wired up.
