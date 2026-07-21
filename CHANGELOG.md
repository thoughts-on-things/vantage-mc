# Changelog

## [0.9.1](https://github.com/thoughts-on-things/vantage-mc/compare/v0.9.0...v0.9.1) (2026-07-21)


### Bug Fixes

* support Minecraft 26.2 sprite texture bindings ([#57](https://github.com/thoughts-on-things/vantage-mc/issues/57)) ([9a4a0c0](https://github.com/thoughts-on-things/vantage-mc/commit/9a4a0c049522fc42bc5cf30f69916ad6bceb48ae))

## [0.9.0](https://github.com/thoughts-on-things/vantage-mc/compare/v0.8.0...v0.9.0) (2026-07-21)


### Features

* large-world server streaming — prebake, contiguous admission, revisit cache, lossless map memory ([#55](https://github.com/thoughts-on-things/vantage-mc/issues/55)) ([53f8c9e](https://github.com/thoughts-on-things/vantage-mc/commit/53f8c9e14635ed93c89b0a8ab53820aba9389f0b))

## [0.8.0](https://github.com/thoughts-on-things/vantage-mc/compare/v0.7.0...v0.8.0) (2026-07-19)


### Features

* cave-partitioned draw ranges (VTLA) + client-side map memory for streamed worlds ([#51](https://github.com/thoughts-on-things/vantage-mc/issues/51)) ([4052443](https://github.com/thoughts-on-things/vantage-mc/commit/4052443cfc1a7913ac285b8275486317925ecbf9))

## [0.7.0](https://github.com/thoughts-on-things/vantage-mc/compare/v0.6.0...v0.7.0) (2026-07-17)


### Features

* **desktop:** redesign world studio UI and refactor app architecture ([#49](https://github.com/thoughts-on-things/vantage-mc/issues/49)) ([5c62a2c](https://github.com/thoughts-on-things/vantage-mc/commit/5c62a2c62a5dd982104f0a60145b60714f8b4c3f))
* **server:** add multiplayer world streaming ([#48](https://github.com/thoughts-on-things/vantage-mc/issues/48)) ([832f29d](https://github.com/thoughts-on-things/vantage-mc/commit/832f29d56c354317b01052fa334eee9f14f224aa))

## [0.6.0](https://github.com/thoughts-on-things/vantage-mc/compare/v0.5.0...v0.6.0) (2026-07-16)


### Features

* **desktop:** expand native world studio ([#47](https://github.com/thoughts-on-things/vantage-mc/issues/47)) ([9d32e28](https://github.com/thoughts-on-things/vantage-mc/commit/9d32e280ee2d0b29ee0dc77eb205bb461c6f7a81))


### Bug Fixes

* **desktop:** hide Windows console in release builds ([#45](https://github.com/thoughts-on-things/vantage-mc/issues/45)) ([20fa2b2](https://github.com/thoughts-on-things/vantage-mc/commit/20fa2b2d0f84e40698ded25eb1461670563a20f0))

## [0.5.0](https://github.com/thoughts-on-things/vantage-mc/compare/v0.4.0...v0.5.0) (2026-07-15)


### Features

* **desktop:** add native world studio foundation ([#24](https://github.com/thoughts-on-things/vantage-mc/issues/24)) ([baeec1a](https://github.com/thoughts-on-things/vantage-mc/commit/baeec1ac160ba5dff82963ccc2132be4c6d8ea29))
* **site:** showcase the desktop app with a live launcher + downloads ([#43](https://github.com/thoughts-on-things/vantage-mc/issues/43)) ([8bfebf7](https://github.com/thoughts-on-things/vantage-mc/commit/8bfebf76b197190b756e8a0635f62e3aeaaa533b))
* vantage live — explore any world instantly, tiles baked on demand ([#25](https://github.com/thoughts-on-things/vantage-mc/issues/25)) ([b937a8e](https://github.com/thoughts-on-things/vantage-mc/commit/b937a8e35d621eec4749e65b8a06591ed00eda26))


### Bug Fixes

* **ci:** pass --repo to gh calls in release CI dispatch step ([#41](https://github.com/thoughts-on-things/vantage-mc/issues/41)) ([cf361db](https://github.com/thoughts-on-things/vantage-mc/commit/cf361dbaabf54972b8f9a17aa280ab2101508e2d))
* **site:** unblock the lighting panel; tighten cave-view copy ([#21](https://github.com/thoughts-on-things/vantage-mc/issues/21)) ([3fdf5a1](https://github.com/thoughts-on-things/vantage-mc/commit/3fdf5a11c55b4e54fc6aa294400fe47ad4ece3dc))

## [0.4.0](https://github.com/thoughts-on-things/vantage-mc/compare/v0.3.0...v0.4.0) (2026-07-13)


### Features

* depth-slice cave view + stream-in tile fade ([#19](https://github.com/thoughts-on-things/vantage-mc/issues/19)) ([f9aafef](https://github.com/thoughts-on-things/vantage-mc/commit/f9aafef8004fccd32ae675205a2a653536609e0a))
* merged water sheets, render-on-demand, vantage serve, screenshot/fullscreen ([#18](https://github.com/thoughts-on-things/vantage-mc/issues/18)) ([84aa076](https://github.com/thoughts-on-things/vantage-mc/commit/84aa076180b6a38a87f922771ece90dd9f482ba6))

## [0.3.0](https://github.com/thoughts-on-things/vantage-mc/compare/v0.2.0...v0.3.0) (2026-07-12)


### Features

* VTL7+VTL8 — compact quads & lightmap atlases (5× smaller, 23% fewer verts, faster bakes) ([#16](https://github.com/thoughts-on-things/vantage-mc/issues/16)) ([14dcb60](https://github.com/thoughts-on-things/vantage-mc/commit/14dcb608a58a016cbcdca02d8ec5f17aa1b43dc5))

## [0.2.0](https://github.com/thoughts-on-things/vantage-mc/compare/v0.1.1...v0.2.0) (2026-07-12)


### Features

* fluid fidelity — animated water & lava, real lava geometry, flow textures ([#13](https://github.com/thoughts-on-things/vantage-mc/issues/13)) ([9f44c81](https://github.com/thoughts-on-things/vantage-mc/commit/9f44c8101a06b0fdedcfb74fdcb4c0b79dae9576))


### Bug Fixes

* stream world reads, bound grid height, pipe-friendly progress ([#15](https://github.com/thoughts-on-things/vantage-mc/issues/15)) ([8506a10](https://github.com/thoughts-on-things/vantage-mc/commit/8506a102bdbe91ba1b7dfd04a47426d940c0cca7))

## [0.1.1](https://github.com/thoughts-on-things/vantage-mc/compare/v0.1.0...v0.1.1) (2026-07-11)


### Documentation

* biome layer (P2.5) in README + DESIGN roadmap ([749ab5f](https://github.com/thoughts-on-things/vantage-mc/commit/749ab5f53d9327ebde7ae014fc2efe2c4e5664f2))
* biomes are data-driven (extract data pack + lang) ([9c7943a](https://github.com/thoughts-on-things/vantage-mc/commit/9c7943af319ebfe0c04f2d3c6e706c0b9cf7c8d8))
* lead with `just render <save>` as the primary workflow ([d4bedc3](https://github.com/thoughts-on-things/vantage-mc/commit/d4bedc3598d154c5895e24fc0e2ff7778e9c4f0c))
* P2 model resolver accuracy complete in roadmap ([d404282](https://github.com/thoughts-on-things/vantage-mc/commit/d404282cdd1a71e7154efd810636985cb05c571f))
* target Minecraft 26.2+ assets for rendering ([9252571](https://github.com/thoughts-on-things/vantage-mc/commit/9252571fe11f0a5553a2451a59d7c9574a967094))
