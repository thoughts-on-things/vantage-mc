import { useEffect, useRef, useState } from 'react';
import heroShot from './assets/render-hero-v2.png';

const GITHUB = 'https://github.com/thoughts-on-things/vantage-mc';
const SERVER_DOCS = `${GITHUB}/blob/main/docs/server.md`;
const OPENAPI = `${GITHUB}/blob/main/docs/server-openapi.json`;
const BEACON = 'https://beacon-mc.io';

function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver(
      (entries) => entries.forEach((entry) => entry.isIntersecting && entry.target.classList.add('in')),
      { threshold: 0.1 },
    );
    el.querySelectorAll('.reveal').forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, []);
  return ref;
}

function CodeBlock({ children, label }: { children: string; label: string }) {
  return (
    <div className="server-code">
      <div className="server-code-head">
        <span>{label}</span>
        <span aria-hidden="true">read only</span>
      </div>
      <pre><code>{children}</code></pre>
    </div>
  );
}

const ENDPOINTS = [
  ['GET', '/.well-known/vantage', 'public', 'Discover protocol, API root, OpenAPI document, and auth mode.'],
  ['GET', '/v1/health', 'public', 'Fast process-liveness probe.'],
  ['GET', '/v1/openapi.json', 'public', 'Machine-readable OpenAPI 3.1 contract.'],
  ['GET', '/v1/worlds', 'protected', 'List worlds this sidecar is authorized to expose.'],
  ['GET', '/v1/worlds/default/manifest.json', 'protected', 'Current tile catalog, progress, and per-tile revisions.'],
  ['GET', '/v1/worlds/default/terrain.vtexarr', 'protected', 'Append-only texture array used by streamed tiles.'],
  ['GET', '/v1/worlds/default/tiles/t.X.Z.vtile', 'protected', 'Cached or on-demand geometry for one advertised tile.'],
] as const;

export function ServerPage() {
  const root = useReveal<HTMLDivElement>();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="server-page" ref={root}>
      <div className="server-glow" aria-hidden="true" />

      <nav className={scrolled ? 'nav nav-scrolled' : 'nav'} aria-label="Server documentation">
        <a className="wordmark" href="../">
          <span className="wordmark-tile" aria-hidden="true" />
          vantage
        </a>
        <div className="nav-links">
          <a href="#architecture">architecture</a>
          <a href="#beacon">beacon</a>
          <a href="#protocol">protocol</a>
          <a href="#security">security</a>
          <a href="#deploy">deploy</a>
        </div>
        <a className="nav-cta" href={SERVER_DOCS} rel="noreferrer">
          technical docs ↗
        </a>
      </nav>

      <main>
        <header className="server-hero">
          <div className="server-hero-copy">
            <p className="badge reveal">
              <span className="badge-dot" aria-hidden="true" />
              server protocol v1 · available now
            </p>
            <h1 className="server-title reveal">
              Your multiplayer world,
              <br />
              <em>rendered live.</em>
            </h1>
            <p className="server-sub reveal">
              Run Vantage beside a Minecraft Java server and give authorized players a fast, continuously
              updating 3D world map—without downloading the save or installing a gameplay plugin.
            </p>
            <div className="server-actions reveal">
              <a className="cta cta-primary" href="#deploy">
                Run the sidecar <span className="cta-arrow" aria-hidden="true">→</span>
              </a>
              <a className="cta cta-ghost" href="#beacon">Integrate a launcher</a>
            </div>
            <ul className="server-proof reveal" aria-label="Server properties">
              <li><span /> read-only world access</li>
              <li><span /> bounded CPU and memory</li>
              <li><span /> host-owned player auth</li>
            </ul>
          </div>

          <figure className="server-live-card reveal">
            <div className="server-live-head">
              <span><i /> world/default</span>
              <b>continuous</b>
            </div>
            <div className="server-live-map">
              <img src={heroShot} alt="A Minecraft server world rendered as a Vantage 3D map" />
              <div className="server-map-grid" aria-hidden="true" />
              <div className="server-live-status">
                <small>WORLD SNAPSHOT</small>
                <strong>revision f95a…663bd</strong>
                <span>64 tiles · cache warm</span>
              </div>
            </div>
            <div className="server-request-flow" aria-label="Request flow">
              <span>Minecraft save</span><b>→</b><span>Vantage</span><b>→</b><span>Beacon</span><b>→</b><span>player</span>
            </div>
          </figure>
        </header>

        <section className="server-intro" id="architecture">
          <p className="kicker reveal">the missing half</p>
          <h2 className="reveal">The authoritative world lives on the server</h2>
          <p className="lede reveal">
            Multiplayer clients only receive a moving window of chunks. Vantage therefore runs beside the
            server, where it can safely observe persisted Anvil region files and render the full explored world.
          </p>
          <div className="server-principles">
            <article className="reveal">
              <span className="server-card-number">01</span>
              <h3>Sidecar, not plugin</h3>
              <p>No code on the game tick thread. Vanilla, Paper, and other Java hosts can opt in without changing gameplay.</p>
            </article>
            <article className="reveal">
              <span className="server-card-number">02</span>
              <h3>Render only what is viewed</h3>
              <p>The manifest lists explored terrain; expensive geometry bakes only when a player looks at a tile.</p>
            </article>
            <article className="reveal">
              <span className="server-card-number">03</span>
              <h3>Identity stays upstream</h3>
              <p>Beacon or another host decides who may view a world. Vantage never needs a Microsoft or Minecraft token.</p>
            </article>
          </div>
        </section>

        <section className="beacon-section" id="beacon">
          <div className="beacon-heading reveal">
            <div>
              <p className="kicker">built around beacon</p>
              <h2>One session, one private data plane</h2>
            </div>
            <a href={BEACON} rel="noreferrer">Explore Beacon ↗</a>
          </div>
          <div className="trust-diagram reveal" aria-label="Beacon integration trust boundary">
            <div className="trust-node trust-player"><small>PLAYER</small><strong>Beacon launcher</strong><span>existing Beacon session</span></div>
            <b aria-hidden="true">→</b>
            <div className="trust-node trust-beacon"><small>AUTH BOUNDARY</small><strong>Beacon map proxy</strong><span>session + rate policy</span></div>
            <b aria-hidden="true">→</b>
            <div className="trust-node trust-vantage"><small>PRIVATE NETWORK</small><strong>Vantage sidecar</strong><span>internal bearer only</span></div>
            <b aria-hidden="true">→</b>
            <div className="trust-node trust-world"><small>READ ONLY</small><strong>World + cache</strong><span>no remote control</span></div>
          </div>
          <div className="beacon-details">
            <ol className="integration-steps reveal">
              <li><span>1</span><p><strong>Beacon starts Vantage</strong> beside the selected save with a persistent cache and a private listener.</p></li>
              <li><span>2</span><p><strong>The launcher opens its existing session-gated route.</strong> No second login or account link is introduced.</p></li>
              <li><span>3</span><p><strong>Beacon validates the player</strong>, removes client authorization headers, and attaches its internal Vantage credential.</p></li>
              <li><span>4</span><p><strong>The viewer streams the map.</strong> Unchanged terrain stays on the GPU while revised tiles replace themselves.</p></li>
            </ol>
            <CodeBlock label="beacon launcher">
{`const world = await worldFromHttp(
  \`${'${beaconOrigin}'}/map-app/world/manifest.json\`,
  {
    accessToken: beaconSession,
    fetch: nativeHttpFetch,
    label: beaconName,
  },
);

await VantageViewer.mount(container, { world });`}
            </CodeBlock>
          </div>
        </section>

        <section className="protocol-section" id="protocol">
          <div className="protocol-heading reveal">
            <div>
              <p className="kicker">protocol v1</p>
              <h2>Small enough to audit. Stable enough to adopt.</h2>
              <p className="lede">Native launchers, browser apps, and reverse proxies all use the same GET-only artifact contract.</p>
            </div>
            <a className="protocol-spec-link" href={OPENAPI} rel="noreferrer">OpenAPI 3.1 ↗</a>
          </div>
          <div className="endpoint-table reveal" role="region" aria-label="Vantage server endpoints" tabIndex={0}>
            <table>
              <thead><tr><th>Method</th><th>Path</th><th>Access</th><th>Purpose</th></tr></thead>
              <tbody>
                {ENDPOINTS.map(([method, path, access, purpose]) => (
                  <tr key={path}>
                    <td><code>{method}</code></td>
                    <td><code>{path}</code></td>
                    <td><span className={`access-chip access-${access}`}>{access}</span></td>
                    <td>{purpose}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="protocol-notes reveal">
            <p><strong><code>HEAD</code> never starts a render.</strong> It answers from file metadata when a cache entry exists.</p>
            <p><strong>Tile revisions are opaque.</strong> Clients compare strings and replace only coordinates whose revision changed.</p>
            <p><strong>One process exposes one world today.</strong> The world-list response leaves room for a future multi-world supervisor.</p>
          </div>
        </section>

        <section className="server-engine" id="security">
          <p className="kicker reveal">under load</p>
          <h2 className="reveal">Fast by construction, defensive by default</h2>
          <div className="engine-grid">
            <article className="engine-card engine-wide reveal">
              <div><span className="engine-pulse" />CONTINUOUS SNAPSHOTS</div>
              <h3>World changes do not become full re-renders</h3>
              <p>A cheap metadata fingerprint gates rescans. Changed catalogs publish as immutable epochs, and each tile revision depends only on overlapping region files plus its seam apron.</p>
              <dl><div><dt>unchanged scan</dt><dd>metadata only</dd></div><div><dt>tile revision</dt><dd>usually 1–4 regions</dd></div><div><dt>cache write</dt><dd>atomic replace</dd></div></dl>
            </article>
            <article className="engine-card reveal">
              <div>BOUNDED WORK</div>
              <h3>No request stampede</h3>
              <p>Duplicate tile requests share one bake. Memory and thread admission cap expensive per-tile arenas; HTTP connections have their own hard ceiling.</p>
            </article>
            <article className="engine-card reveal">
              <div>STRICT SURFACE</div>
              <h3>Data plane, not admin panel</h3>
              <p>GET, HEAD, and CORS preflight only. No command execution, save control, filesystem parameters, player data, or arbitrary cache files.</p>
            </article>
            <article className="engine-card reveal">
              <div>SECRET HYGIENE</div>
              <h3>Credentials stay out of URLs</h3>
              <p>Environment-sourced bearer secrets, retained as a SHA-256 digest, are compared in constant time. Responses are private and non-storable.</p>
            </article>
            <article className="engine-card reveal">
              <div>BROWSER SAFETY</div>
              <h3>Exact origins, confined artifacts</h3>
              <p>CORS is explicit per scheme, host, and port. The client refuses absolute, encoded, or traversing manifest paths before attaching a credential.</p>
            </article>
          </div>
        </section>

        <section className="deploy-section" id="deploy">
          <div className="deploy-copy deploy-dev reveal">
            <div>
              <p className="kicker">local walkthrough</p>
              <h2>Server to viewer. One command.</h2>
              <p>Use the bundled world or point at a real Java save. Vantage builds, creates a fresh local credential, starts both services, opens the map, and owns cleanup.</p>
            </div>
            <CodeBlock label="from the repository root">
{`just server-dev

# real multiplayer save
just server-dev \\
  /srv/minecraft/world

# headless integration proof
just server-smoke`}
            </CodeBlock>
          </div>
          <div className="deploy-copy reveal">
            <p className="kicker">quick start</p>
            <h2>Private by default</h2>
            <p>On the same machine as Beacon, leave Vantage on loopback and let Beacon own the public HTTPS route.</p>
            <CodeBlock label="same-host sidecar">
{`vantage server /srv/minecraft/world \\
  --assets /srv/vantage/assets/minecraft \\
  --out /var/cache/vantage/world \\
  --memory 1024 \\
  --threads 8`}
            </CodeBlock>
          </div>
          <div className="deploy-copy reveal">
            <p className="kicker">separate containers</p>
            <h2>Bearer on the private hop</h2>
            <p>A non-loopback bind is refused unless the named environment variable contains at least 32 bytes. TLS still terminates at the trusted edge.</p>
            <CodeBlock label="private container network">
{`export VANTAGE_SERVER_TOKEN
VANTAGE_SERVER_TOKEN="$(
  openssl rand -base64 32
)"

vantage server /data/world \\
  --assets /data/assets/minecraft \\
  --out /cache/world \\
  --host 0.0.0.0 \\
  --token-env VANTAGE_SERVER_TOKEN`}
            </CodeBlock>
          </div>
        </section>

        <section className="scope-section">
          <div className="scope-card reveal">
            <p className="kicker">clear boundaries</p>
            <h2>What protocol v1 renders</h2>
            <div className="scope-columns">
              <div><h3>Included</h3><ul><li>Persisted Java Edition overworld terrain</li><li>On-demand textured geometry</li><li>Biome, lighting, and cave-ready data</li><li>Continuous tile replacement after saves</li></ul></div>
              <div><h3>Not included—by design</h3><ul><li>Players, inventories, chat, or live packets</li><li>Remote commands, save, start, or stop</li><li>Bedrock Edition worlds</li><li>Public TLS termination inside the sidecar</li></ul></div>
            </div>
          </div>
        </section>

        <section className="server-final">
          <div className="server-final-card reveal">
            <p className="kicker">for beacon and beyond</p>
            <h2>Make every supported server explorable</h2>
            <p>Start with Beacon’s existing session boundary. The same protocol is ready for Modrinth and other launchers when their hosts opt in.</p>
            <div>
              <a className="cta cta-primary" href={SERVER_DOCS} rel="noreferrer">Read the integration guide <span aria-hidden="true">→</span></a>
              <a className="cta cta-ghost" href={GITHUB} rel="noreferrer">View the source</a>
            </div>
          </div>
        </section>
      </main>

      <footer className="footer server-footer">
        <div className="footer-main">
          <div className="footer-brand"><span className="wordmark-tile" aria-hidden="true" /> <strong>vantage</strong><span className="footer-license">MIT licensed</span></div>
          <div className="footer-links"><a href="../">Overview</a><a href={SERVER_DOCS} rel="noreferrer">Server guide</a><a href={OPENAPI} rel="noreferrer">OpenAPI</a><a href={BEACON} rel="noreferrer">Beacon</a><a href={GITHUB} rel="noreferrer">GitHub</a></div>
        </div>
        <div className="footer-fine">Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.</div>
      </footer>
    </div>
  );
}
