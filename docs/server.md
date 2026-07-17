# Multiplayer world serving

`vantage server` is the multiplayer data plane for Vantage. It runs beside a
Minecraft Java server, reads that server's world files, renders tiles lazily,
and exposes the versioned Vantage world protocol to an authenticating host — a
launcher backend, server web portal, or reverse proxy. Players can explore a
server map without downloading the save and without granting Vantage their
Minecraft, Microsoft, or launcher credentials.

The machine-readable protocol contract is
[server-openapi.json](./server-openapi.json).

The design deliberately separates two responsibilities:

- **The launcher or server host owns identity and authorization.** It already
  knows which player a session belongs to, and it keeps making the access
  decision.
- **Vantage owns rendering and artifact streaming.** It has read-only world
  access, a bounded bake scheduler, and no account database or public control
  plane.

```mermaid
flowchart LR
  P["Player in a launcher"] -->|"existing launcher session"| B["host API / map proxy"]
  B -->|"private bearer credential"| V["vantage server"]
  M["Minecraft Java server"] -->|"autosave or controlled save-all flush"| W["world region files"]
  W -->|"read only"| V
  V --> C["bounded tile cache"]
  V -->|"manifest, atlas, requested tiles"| B
```

## Why a sidecar

A multiplayer client does not have the authoritative Anvil region files. It
only receives a moving window of chunks and cannot reconstruct unexplored or
unloaded terrain. A server plugin could stream blocks, but that puts expensive
render extraction on the tick thread, couples support to server implementations,
and expands the protocol surface considerably.

The sidecar reads the same persisted region format as desktop Vantage, works
with vanilla and modded servers without injecting code, and fails independently
of the game server. Its only required capabilities are:

- read access to the selected save and `level.dat`;
- read access to an extracted Minecraft client asset set;
- write access to a dedicated Vantage cache;
- a private network path to the authenticating host.

Minecraft 1.21.9 introduced an optional JSON-RPC management server over
WebSocket. It is useful for future save coordination and lifecycle
notifications, but it does not provide world block data, so it complements
rather than replaces the region-file sidecar. Mojang and Paper both default it
to localhost with bearer authentication and TLS controls; Vantage follows the
same private-control-plane shape. See the
[Minecraft 1.21.9 release notes](https://www.minecraft.net/en-us/article/minecraft-java-edition-1-21-9)
and [Paper server-properties reference](https://docs.papermc.io/paper/reference/server-properties/).

## Run it

### Local development walkthrough

The repository includes a supervised, end-to-end development stack. From the
repository root:

```sh
just server-dev
```

It performs the complete launcher-facing flow:

1. validates the world and local ports, installs the viewer dependencies when
   they are missing, and builds an optimized sidecar;
2. creates a new cryptographically random bearer without putting it in the
   command line, URL, or logs;
3. starts `vantage server` on loopback with CORS restricted to the local
   viewer, then waits for its health endpoint;
4. starts the viewer with `worldFromVantageServer`, waits until it is ready,
   and opens it in the default browser; and
5. prefixes both services' logs in one terminal and stops both on `Ctrl+C`.

The bundled `site/demo-world` makes the first run reproducible. Point the same
flow at a Java server's actual world directory to test persisted multiplayer
changes:

```sh
just server-dev "C:\minecraft-server\world"
just server-dev /srv/minecraft/world
```

The default on-demand cache is `.vantage-dev/server-cache`, so restarts are
fast while new region revisions still invalidate affected tiles. Run
`just server-dev-help` to inspect port, cache, scan interval, and
browser behavior. `--skip-build` shortens repeated native iterations.

For an automated proof of the same stack, use:

```sh
just server-smoke
```

It checks public discovery, a rejected unauthenticated request, an authorized
continuous manifest, exact-origin CORS, tile revisions, and one actual lazy
bake. It exits only after both child processes have stopped, making it suitable
for local preflight and CI. The injected bearer is intentionally visible to
the local browser process; because it is fresh per run and the sidecar binds to
loopback, it is a development convenience—not a production authentication
pattern.

### Production sidecar

When the authenticating host runs on the same machine, keep the listener on
its default loopback address. No bearer is required because only the
authenticating local proxy can reach it:

```sh
vantage server /srv/minecraft/world \
  --assets /srv/vantage/assets/minecraft \
  --out /var/cache/vantage/world \
  --memory 1024 \
  --threads 8
```

When the host and Vantage run in separate containers, put them on a private
network and use an internal secret. `vantage server` refuses a non-loopback
bind unless the environment variable contains at least 32 bytes:

```sh
export VANTAGE_SERVER_TOKEN="$(openssl rand -base64 32)"
vantage server /data/world \
  --assets /data/assets/minecraft \
  --out /cache/world \
  --host 0.0.0.0 \
  --token-env VANTAGE_SERVER_TOKEN
```

The secret is read from the environment, hashed immediately, never accepted on
the command line, and never printed. Send it as an HTTP header:

```http
Authorization: Bearer <secret>
```

Terminate HTTPS at a trusted reverse proxy, the platform load balancer, or the
authenticating host itself.
Do not expose the native HTTP listener or send a bearer token over cleartext
outside a trusted loopback/private network. This follows the bearer-token
requirements in [RFC 6750](https://www.rfc-editor.org/rfc/rfc6750).

Useful server-specific flags are:

| Flag | Default | Purpose |
| --- | --- | --- |
| `--scan-interval <seconds>` | `5` | Minimum interval between world change checks. |
| `--max-connections <n>` | `64` | Hard cap on concurrent HTTP connection workers. |
| `--allow-origin <origin>` | none | Exact browser origin allowed by CORS; repeatable. |
| `--token-env <name>` | `VANTAGE_SERVER_TOKEN` | Environment variable holding the internal bearer. |

All `vantage live` render controls also apply, including `--radius`,
`--tile-chunks`, `--caves`, `--light`, `--biome-blend`, `--gz`, `--memory`, and
`--threads`.

## Protocol v1

The initial protocol serves one world called `default`. One sidecar process per
Minecraft server keeps ownership, caches, and failure domains explicit; the
world-list shape leaves room for a future multi-world supervisor.

| Request | Authentication | Result |
| --- | --- | --- |
| `GET /.well-known/vantage` | public | Protocol and authentication discovery. |
| `GET /v1/health` | public | Process liveness, not world readiness or access. |
| `GET /v1/openapi.json` | public | The exact OpenAPI 3.1 protocol contract. |
| `GET /v1/worlds` | required | Authorized world descriptors. |
| `GET /v1/worlds/default/manifest.json` | required | Current world manifest. |
| `GET /v1/worlds/default/terrain.vtexarr` | required | Current texture array. |
| `GET /v1/worlds/default/tiles/t.X.Z.vtile` | required | Cached or on-demand geometry tile. |

`HEAD` may inspect an existing static cache entry but never starts a bake or
builds an atlas. `OPTIONS` supports a strict CORS preflight. Other methods are
rejected because the component has no remote mutation or administration API.

All protected responses use `private, no-store`. Bearer credentials belong in
`Authorization`, never query strings. Browser access is opt-in per exact
scheme/host/port with `--allow-origin`; wildcard or suffix matching is not
supported. Responses include `Vary: Origin`, as required for origin-specific
caching by the [Fetch Standard](https://fetch.spec.whatwg.org/).

Manifest tiles from a continuous server carry an opaque `revision` string. A
client that polls the dynamic manifest keeps unchanged GPU tiles resident,
unloads only removed or changed revisions, and fetches replacements on demand.

## Host integration

A server host that already authenticates its players has the right trust
boundary: its launcher or web routes establish and enforce the session, and
its admin tier owns the Minecraft process and save path. Vantage should plug
into that boundary rather than introduce another player identity system.

The recommended integration for a host that currently ships periodic full-map
renders is:

1. Start one long-running `vantage server` for the save. Keep its cache on
   persistent storage and its listener reachable only from the host's service
   tier.
2. Keep the host's existing map session middleware. Add a streaming proxy
   below a stable same-origin prefix such as `/map-app/world/`.
3. On every request, validate the player's existing session. Remove any
   client-supplied `Authorization` header, then attach the Vantage internal
   bearer before forwarding to `/v1/worlds/default/`.
4. Apply player/session rate limits at the host or the edge. Never expose an
   endpoint that lets a player choose a filesystem path, cache directory,
   command, or arbitrary tile coordinate.
5. Return the session-gated manifest URL to the launcher. A browser can use the
   same-origin proxy directly; a native launcher can provide its existing
   session header through `worldFromHttp`.

```ts
import { worldFromHttp } from '@thoughts-on-things/vantage-mc/core';

const world = await worldFromHttp(
  `${hostOrigin}/map-app/world/manifest.json`,
  {
    accessToken: hostSession,
    fetch: nativeHttpFetch, // e.g. the launcher's native HTTP transport
    label: hostLabel,
  },
);

const viewer = await VantageViewer.mount(container, { world });
```

The Vantage client confines every manifest-owned artifact path to the
manifest's HTTP origin and directory before attaching credentials. An absolute
URL, encoded traversal, backslash, empty path segment, or `..` is rejected, so
a compromised manifest cannot redirect the player's session token elsewhere.

A generic launcher that connects directly to a TLS-terminated Vantage endpoint
can use the protocol helper instead:

```ts
import { worldFromVantageServer } from '@thoughts-on-things/vantage-mc/core';

const world = await worldFromVantageServer('https://map.example.net/', {
  accessToken: serverMapToken,
});
```

## Continuous consistency and performance

The sidecar never writes to the Minecraft save. Minecraft remains responsible
for persisting live chunks; Vantage observes them on the next scan. If the
host needs a stronger freshness point, its privileged supervisor may issue
`save-all flush` before a planned snapshot. That operation must not be exposed
to map clients, and should be debounced because it can pause a busy server.

Each refresh is an immutable, reference-counted epoch:

1. The frequent gate scans only region filename, size, and modification time.
2. After a change, Vantage reads each affected catalog's 4 KiB location table
   with file metadata checked before and after the read. An unstable read is
   discarded and retried on a later scan.
3. Populated chunks and render tiles are enumerated from the location tables.
   A region-coordinate index computes each tile's revision from only the region
   files intersecting that tile and its one-chunk seam apron.
4. The new epoch is swapped under a short mutex. In-flight requests retain the
   old epoch until their bake finishes, avoiding both torn catalogs and
   use-after-free.
5. Tile files are written atomically. Duplicate concurrent fetches for one
   tile coalesce into a single bake, while a semaphore bounds simultaneous
   per-tile arenas from `--threads` and `--memory`.

The resulting costs are:

| Operation | Cost |
| --- | --- |
| Unchanged refresh | O(region files) metadata; no chunk payload reads. |
| Changed catalog | 4 KiB per region plus O(populated chunks) enumeration. |
| Tile revision | O(overlapping regions), normally one to four. |
| Tile bake | One tile plus seam apron; bounded concurrent working sets. |
| Repeated tile fetch | Disk cache read; no rebake. |
| Duplicate in-flight fetch | Waits for and shares the leader's result. |

Chunk payloads are positional reads into a per-tile arena; they are not kept in
the long-lived world catalog. World size therefore affects compact indexes and
cache size, not the expensive resident bake working set.

## Threat model and operating rules

| Risk | Mitigation |
| --- | --- |
| World disclosure | Host/session authorization remains outside Vantage; every artifact route is protected. |
| Secret leakage | Environment-only secret, in-memory SHA-256, constant-time comparison, no URL credentials, `no-referrer`. |
| Cross-origin token use | Exact CORS allowlist, preflight, `Vary: Origin`, duplicate security headers rejected. |
| Path traversal or credential exfiltration | Protocol-artifact allowlist, conservative path grammar, and client-side same-origin/directory confinement. |
| Bake amplification | Only manifest-advertised tile coordinates can bake; duplicate work coalesces. |
| Memory/connection exhaustion | Byte-derived bake semaphore, connection cap, and finite requests per keep-alive connection. |
| Partial cache files | Atomic replacement after a successful bake. |
| Save races | Stable location-table reads and reference-counted epochs; failed scans retain the last good snapshot. |

The map can disclose player builds, explored terrain, and—in full-cave mode—
underground structures. Treat it as private server data. Run the process as a
dedicated unprivileged account, mount the world read-only where possible, keep
the cache separate, rotate internal bearer secrets, and enforce request-rate,
body-size, header-size, idle-timeout, TLS, and audit policy at the edge proxy.

## Current boundaries

- Java Edition Anvil saves and the overworld are supported. Other dimensions
  should become explicit world IDs rather than filesystem parameters supplied
  by a client.
- Vantage renders persisted terrain, not players, entities, inventories, chat,
  or live chunk packets.
- The sidecar is an HTTP data plane, not a Minecraft remote administration
  service. It cannot start, stop, save, or execute commands on the server.
- Low-resolution whole-world pyramid generation remains a batch-render
  feature. Continuous serving currently streams high-resolution tiles.
- Native TLS is intentionally out of scope; public deployments require a
  trusted TLS reverse proxy.

These boundaries keep protocol v1 small and auditable. Future additions—more
dimensions, host-pushed invalidations from Minecraft's management protocol,
entity overlays, or shared object storage—can extend the world descriptor and
artifact streams without moving identity or server control into Vantage.
