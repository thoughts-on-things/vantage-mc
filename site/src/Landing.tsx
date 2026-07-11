import { useEffect, useRef, useState } from 'react';
import heroShot from './assets/render-hero.jpg';
import worldShot from './assets/render-world.jpg';
import biomesShot from './assets/render-biomes.jpg';
import { DEMO_MANIFEST } from './App.js';
import { RaceReplay } from './RaceReplay.js';

const GITHUB = 'https://github.com/thoughts-on-things/vantage-mc';
const RELEASES = `${GITHUB}/releases`;
const BEACON = 'https://beacon-mc.io';
const STUDIO = 'https://thoughtsonthingsllc.com';

/** Scroll-reveal: adds .in once an element enters the viewport. */
function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && e.target.classList.add('in')),
      { threshold: 0.12 },
    );
    el.querySelectorAll('.reveal').forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, []);
  return ref;
}

const FEATURES = [
  {
    icon: '⚡',
    title: 'Minutes become seconds',
    body: 'A native renderer with no JVM and no warm-up maps a whole survival world in the time other tools take to boot. Re-render after every session without thinking about it.',
    wide: true,
  },
  {
    icon: '🌍',
    title: 'The whole world, always',
    body: 'Zoom from one flower to a satellite view of everything ever explored. A lightweight overview layer (~1% of the map’s bytes) means you never hit a fog wall.',
    wide: true,
  },
  {
    icon: '🎯',
    title: '120+ FPS panning',
    body: 'Tiles decode on the GPU, so the page never stutters — even with 16 million triangles on screen.',
    wide: false,
  },
  {
    icon: '📦',
    title: 'Just static files',
    body: 'A map is a folder of tiles. Host it on any web server, S3 bucket, or Pages site — no backend, no database.',
    wide: false,
  },
  {
    icon: '🔗',
    title: 'Every view is a link',
    body: 'The camera lives in the URL. Any angle on any build is a deep link you can paste to a friend.',
    wide: false,
  },
  {
    icon: '🧭',
    title: 'Layers & flight',
    body: 'A clickable biome legend, day/night lighting, quality presets, and a free-flight camera. Press B, fly around.',
    wide: false,
  },
];

export function Landing({ onDemo }: { onDemo: () => void }) {
  const root = useReveal<HTMLDivElement>();
  const [demoReady, setDemoReady] = useState<boolean | null>(null);
  const [scrolled, setScrolled] = useState(false);

  // The demo render is deployed next to the site (and rendered locally with
  // `just site-demo`) — probe for it so a source checkout without one degrades
  // gracefully instead of 404ing.
  useEffect(() => {
    fetch(DEMO_MANIFEST, { method: 'HEAD' }).then(
      (r) => setDemoReady(r.ok),
      () => setDemoReady(false),
    );
  }, []);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="landing" ref={root}>
      <div className="glow" aria-hidden="true" />

      <nav className={scrolled ? 'nav nav-scrolled' : 'nav'}>
        <a className="wordmark" href="./">
          <span className="wordmark-tile" aria-hidden="true" />
          vantage
        </a>
        <div className="nav-links">
          <a href="#numbers">numbers</a>
          <a href="#how">how it works</a>
          <a href={BEACON} rel="noreferrer" title="Beacon — the home for self-hosted Minecraft">
            beacon ↗
          </a>
        </div>
        <a className="nav-cta" href={GITHUB} rel="noreferrer">
          <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
          </svg>
          GitHub
        </a>
      </nav>

      <header className="hero">
        <p className="badge reveal">
          <span className="badge-dot" aria-hidden="true" />
          free &amp; open source · vanilla worlds · no mods, no plugins
        </p>
        <h1 className="hero-title reveal">
          Your Minecraft world,
          <br />
          as a <em>living map</em>.
        </h1>
        <p className="hero-sub reveal">
          Vantage turns a Java-Edition save into a fast, beautiful 3D map that runs in any browser. Map a whole
          survival world in seconds — then orbit your builds, skim the oceans, and zoom out to see everything you
          ever dug.
        </p>

        <div className="hero-ctas reveal">
          <button className="cta cta-primary" onClick={onDemo} disabled={demoReady === false}>
            Explore the demo world
            <span className="cta-arrow" aria-hidden="true">
              →
            </span>
          </button>
          <a className="cta cta-ghost" href={RELEASES} rel="noreferrer">
            Get vantage
          </a>
        </div>
        {demoReady === false && (
          <p className="hero-note">
            (demo tiles aren&apos;t rendered in this checkout — run <code>just site-demo</code>)
          </p>
        )}

        <dl className="hero-stats reveal">
          <div>
            <dd>~5 s</dd>
            <dt>to map a whole world</dt>
          </div>
          <div>
            <dd>120+ FPS</dd>
            <dt>in your browser</dt>
          </div>
          <div>
            <dd>8× smaller</dd>
            <dt>than raw geometry</dt>
          </div>
          <div>
            <dd>0 setup</dd>
            <dt>servers or plugins</dt>
          </div>
        </dl>
      </header>

      <figure className="viewport reveal">
        <div className="viewport-frame">
          <div className="viewport-chrome">
            <span className="dot" />
            <span className="dot" />
            <span className="dot" />
            <span className="viewport-url">vantage.beacon-mc.io/?world=demo</span>
          </div>
          <button
            className="viewport-shot"
            onClick={onDemo}
            disabled={demoReady === false}
            title="Launch the live demo"
          >
            <img src={heroShot} alt="Textured 3D Minecraft terrain streaming in the Vantage viewer" />
            <span className="viewport-play">
              <span>▶</span> launch the live viewer
            </span>
          </button>
        </div>
        <figcaption>Not a video — the real viewer streaming real tiles. Click through and fly around.</figcaption>
      </figure>

      <section className="numbers" id="numbers">
        <p className="kicker reveal">the numbers</p>
        <h2 className="reveal">Measured, not promised</h2>
        <p className="lede reveal">
          The same 7,225-chunk survival world, rendered start-to-finish by each tool on the same 16-thread desktop.
          Watch the actual runs:
        </p>
        <RaceReplay />
        <div className="compare reveal">
          <table>
            <thead>
              <tr>
                <th />
                <th className="compare-vantage">Vantage</th>
                <th>BlueMap CLI</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th>Full render, start to finish</th>
                <td className="compare-vantage compare-win">
                  4.7 s <span className="compare-chip">6× faster</span>
                </td>
                <td>28.3 s</td>
              </tr>
              <tr>
                <th>Map size on disk</th>
                <td className="compare-vantage">132 MB</td>
                <td className="compare-win">
                  74 MB <span className="compare-chip">1.8× smaller</span>
                </td>
              </tr>
              <tr>
                <th>Runtime</th>
                <td className="compare-vantage compare-win">
                  one native binary <span className="compare-chip">no Java</span>
                </td>
                <td>Java 25 JVM</td>
              </tr>
              <tr>
                <th>Hosting</th>
                <td className="compare-vantage">static files</td>
                <td>static files or bundled server</td>
              </tr>
            </tbody>
          </table>
          <p className="compare-note">
            Both tools rendering the overworld with default settings on 16 threads, assets cached, output wiped
            between runs (BlueMap v5.22). BlueMap is excellent software and the benchmark to beat — the difference
            is what native code buys you. Commands to reproduce are in the{' '}
            <a href={GITHUB} rel="noreferrer">
              repo
            </a>
            .
          </p>
        </div>
      </section>

      <section className="features" id="features">
        <p className="kicker reveal">why vantage</p>
        <h2 className="reveal">Built for how maps actually get used</h2>
        <div className="feature-grid">
          {FEATURES.map((f) => (
            <article className={f.wide ? 'feature feature-wide reveal' : 'feature reveal'} key={f.title}>
              <span className="feature-icon" aria-hidden="true">
                {f.icon}
              </span>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="how" id="how">
        <p className="kicker reveal">how it works</p>
        <h2 className="reveal">From save to shared map in minutes</h2>
        <ol className="steps">
          <li className="reveal">
            <h3>Get vantage</h3>
            <pre>
              <code>
                <span className="c"># one small static binary — Linux, macOS, Windows</span>
                {'\n'}
                <span className="p">$</span> curl -sL{' '}
                {`${GITHUB.replace('https://', '')}/releases/latest/download/vantage-x86_64-linux.tar.gz`} | tar xz
              </code>
            </pre>
            <p>
              Download a binary from{' '}
              <a href={RELEASES} rel="noreferrer">
                GitHub Releases
              </a>
              . No Java, no installer, no dependencies.
            </p>
          </li>
          <li className="reveal">
            <h3>Render your world</h3>
            <pre>
              <code>
                <span className="p">$</span> vantage render ~/.minecraft/saves/MyWorld --out map/
              </code>
            </pre>
            <p>
              That&apos;s the whole setup: textures and models are pulled from your Minecraft install automatically
              the first time. Every populated chunk renders in parallel, in seconds.
            </p>
          </li>
          <li className="reveal">
            <h3>Share it</h3>
            <pre>
              <code>
                <span className="p">$</span> npx serve map/ <span className="c"># any static host works</span>
              </code>
            </pre>
            <p>
              A map is just files — put it behind nginx, on S3, or on GitHub Pages, or embed the{' '}
              <code>&lt;VantageViewer&gt;</code> React component in your own site.
            </p>
          </li>
        </ol>
      </section>

      <section className="gallery">
        <figure className="reveal">
          <img src={worldShot} alt="Whole-world satellite view from the LOD pyramid" loading="lazy" />
          <figcaption>Zoomed all the way out — the entire world stays visible, never a fog wall.</figcaption>
        </figure>
        <figure className="reveal">
          <img src={biomesShot} alt="The biome layer with its clickable legend" loading="lazy" />
          <figcaption>The biome layer — click the legend to highlight, hover to identify.</figcaption>
        </figure>
      </section>

      <section className="yours" id="yours">
        <div className="yours-card reveal">
          <div>
            <p className="kicker">next step</p>
            <h2>
              Now map <em>your</em> world
            </h2>
            <p>
              Everything you just explored was made by one command. Point vantage at your own save — a years-old
              survival world, a creative server, a realm backup — and get the same map for it.
            </p>
            <p className="yours-privacy">
              Local and private by default: your world never leaves your machine unless you choose to host the
              output. MIT licensed, <a href={GITHUB} rel="noreferrer">source on GitHub</a>.
            </p>
            <a className="cta cta-primary" href={`${GITHUB}#quick-start`} rel="noreferrer">
              Read the quick start
              <span className="cta-arrow" aria-hidden="true">
                →
              </span>
            </a>
          </div>
          <pre className="yours-tree" aria-label="Render output layout">
            <code>
              <span className="p">$</span> vantage render {'…'} --out map/{'\n'}
              map/{'\n'}
              ├─ manifest.json{'\n'}
              ├─ terrain.vtexarr{'\n'}
              ├─ tiles/{'\n'}
              │{'  '}└─ t.&lt;x&gt;.&lt;z&gt;.vtile{'\n'}
              └─ lowres/
            </code>
          </pre>
        </div>
      </section>

      <footer className="footer">
        <div className="footer-main">
          <div className="footer-brand">
            <span className="wordmark-tile" aria-hidden="true" /> <strong>vantage</strong>
            <span className="footer-license">MIT licensed</span>
          </div>
          <div className="footer-links">
            <a href={GITHUB} rel="noreferrer">GitHub</a>
            <a href={`${GITHUB}#quick-start`} rel="noreferrer">Quick start</a>
            <a href={`${GITHUB}/issues`} rel="noreferrer">Issues &amp; support</a>
            <a href={BEACON} rel="noreferrer">Beacon</a>
          </div>
        </div>
        <div className="footer-studio">
          Part of{' '}
          <a href={BEACON} rel="noreferrer">
            Beacon
          </a>{' '}
          — the home for self-hosted Minecraft — by{' '}
          <a href={STUDIO} rel="noreferrer">
            Thoughts on Things
          </a>
          , an independent software studio. GitHub{' '}
          <a href={`${GITHUB}/issues`} rel="noreferrer">
            issues
          </a>{' '}
          and{' '}
          <a href={`${GITHUB}/discussions`} rel="noreferrer">
            discussions
          </a>{' '}
          are the fastest way to reach us.
        </div>
        <div className="footer-fine">
          Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.
        </div>
      </footer>
    </div>
  );
}
