import { useEffect, useRef, useState } from 'react';
import mapTop from './assets/render-world.jpg';
import mapPersp from './assets/render-hero.jpg';
import mapBiomes from './assets/render-biomes.jpg';

const GITHUB = 'https://github.com/thoughts-on-things/vantage-mc';
const RELEASES = `${GITHUB}/releases`;
// Fallback target: the latest-release page always resolves, even before the
// desktop job has ever run. On mount we upgrade this to the exact signed NSIS
// installer via the GitHub API (see useLatestInstaller) for a one-click download.
const RELEASES_LATEST = `${RELEASES}/latest`;
const REPO_API = 'https://api.github.com/repos/thoughts-on-things/vantage-mc/releases/latest';

type Installer = { url: string; version: string | null };

/** Resolves the latest signed Windows installer (NSIS setup.exe, else MSI). */
function useLatestInstaller(): Installer {
  const [installer, setInstaller] = useState<Installer>({ url: RELEASES_LATEST, version: '0.4.0' });
  useEffect(() => {
    let live = true;
    fetch(REPO_API, { headers: { Accept: 'application/vnd.github+json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((rel: { tag_name?: string; assets?: { name: string; browser_download_url: string }[] } | null) => {
        if (!live || !rel?.assets) return;
        const assets = rel.assets;
        const win =
          assets.find((a) => /x64[-_]setup\.exe$/i.test(a.name)) ??
          assets.find((a) => /\.exe$/i.test(a.name) && /setup/i.test(a.name)) ??
          assets.find((a) => /x64.*\.msi$/i.test(a.name)) ??
          assets.find((a) => /\.msi$/i.test(a.name));
        const version = rel.tag_name?.replace(/^v/, '') ?? null;
        // Keep the page fallback if this release has no desktop installer yet.
        setInstaller({ url: win?.browser_download_url ?? RELEASES_LATEST, version });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return installer;
}

/* ---------- tiny inline icon set (the launcher uses lucide; we don't ship it) ---------- */

type IconProps = { size?: number; className?: string };
const svg = (path: React.ReactNode) =>
  function Icon({ size = 16, className }: IconProps) {
    return (
      <svg
        className={className}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {path}
      </svg>
    );
  };

const MapIcon = svg(
  <>
    <path d="M14.5 4 9 6.5 3.5 4A1 1 0 0 0 2 5v13a1 1 0 0 0 .6.9L9 21l6-2.5 5.4 2.4A1 1 0 0 0 22 20V7a1 1 0 0 0-.6-.9Z" />
    <path d="M9 6.5v14.5M15 3v15.5" />
  </>,
);
const LayersIcon = svg(
  <>
    <path d="m12.8 2.5 8.2 4.6a.5.5 0 0 1 0 .9L12.8 12.6a1.6 1.6 0 0 1-1.6 0L3 8a.5.5 0 0 1 0-.9l8.2-4.6a1.6 1.6 0 0 1 1.6 0Z" />
    <path d="m21 12-8.2 4.6a1.6 1.6 0 0 1-1.6 0L3 12" />
  </>,
);
const SearchIcon = svg(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </>,
);
const CompassIcon = svg(
  <>
    <circle cx="12" cy="12" r="9.5" />
    <path d="m16 8-2 6-6 2 2-6Z" />
  </>,
);
const SparklesIcon = svg(
  <path d="M12 3v4M12 17v4M5 12H3m18 0h-2M6.3 6.3 4.8 4.8m14.4 14.4-1.5-1.5M17.7 6.3l1.5-1.5M4.8 19.2l1.5-1.5M12 8.5 13 11l2.5 1-2.5 1-1 2.5-1-2.5L8.5 12 11 11Z" />,
);
const PlayIcon = svg(<path d="M7 4.5v15l13-7.5Z" fill="currentColor" stroke="none" />);
const CheckIcon = svg(<path d="m5 12 4.5 4.5L19 6" />);
const ChevronIcon = svg(<path d="m9 5 7 7-7 7" />);
const DownloadIcon = svg(
  <>
    <path d="M12 3v12" />
    <path d="m7 11 5 5 5-5" />
    <path d="M4 20h16" />
  </>,
);
const WindowsIcon = ({ size = 16 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M3 5.4 10.4 4.4V11.4H3ZM10.4 12.3V19.4L3 18.4V12.3ZM11.4 4.2 21 3V11.4H11.4ZM21 12.3V21L11.4 19.7V12.3Z" />
  </svg>
);
const AppleIcon = ({ size = 16 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M16.4 12.9c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.2-2.8.9-3.5.9s-1.8-.8-3-.8c-1.5 0-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7 2-1.1 2.8-2.2c.9-1.3 1.2-2.5 1.3-2.6-.1 0-2.5-1-2.5-3.9ZM14.3 6.1c.6-.8 1.1-1.9 1-3-.9 0-2.1.6-2.7 1.4-.6.7-1.1 1.8-1 2.9 1 .1 2.1-.5 2.7-1.3Z" />
  </svg>
);
const LinuxIcon = ({ size = 16 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2c-2 0-3.2 1.7-3.2 3.8 0 1.3.1 2.4-.6 3.6-.8 1.3-2.2 2.6-2.2 4.6 0 .8.3 1.4.3 1.9-.6.5-1.4 1-1.4 1.8 0 .6.5.9 1.2 1.1.8.2 1.4.4 2.1.9.6.5 1.3.9 2.2.9.7 0 1.3-.3 1.6-.8.3.5.9.8 1.6.8.9 0 1.6-.4 2.2-.9.7-.5 1.3-.7 2.1-.9.7-.2 1.2-.5 1.2-1.1 0-.8-.8-1.3-1.4-1.8 0-.5.3-1.1.3-1.9 0-2-1.4-3.3-2.2-4.6-.7-1.2-.6-2.3-.6-3.6C15.2 3.7 14 2 12 2Zm-1.4 4c.3 0 .6.3.6.8s-.3.8-.6.8-.6-.3-.6-.8.3-.8.6-.8Zm2.8 0c.3 0 .6.3.6.8s-.3.8-.6.8-.6-.3-.6-.8.3-.8.6-.8Zm-1.4 2.4c.8 0 1.7.5 1.7.9 0 .3-.5.5-.9.7-.3.2-.6.4-.8.4s-.5-.2-.8-.4c-.4-.2-.9-.4-.9-.7 0-.4.9-.9 1.7-.9Z" />
  </svg>
);

/* ---------- mock library: every card is a real Vantage render ---------- */

type MockWorld = {
  name: string;
  source: string;
  cached: boolean;
  img: string;
  pos: string;
  size: string;
  hue?: number;
  featured?: boolean;
};

// Every source render carries the viewer's own UI furniture — an info box
// (top-left) and the biome legend (right). Crops stay zoomed and centred so
// only clean map shows, never that chrome.
const WORLDS: MockWorld[] = [
  { name: 'Skyhold', source: 'Minecraft', cached: false, img: mapPersp, pos: '52% 60%', size: '190%', featured: true },
  { name: 'Amethyst Coast', source: 'Modrinth', cached: true, img: mapTop, pos: '38% 46%', size: '265%', hue: 24 },
  { name: 'Redstone Valley', source: 'Prism', cached: true, img: mapBiomes, pos: '44% 52%', size: '235%', hue: -18 },
  { name: 'Hardcore Run #7', source: 'MultiMC', cached: false, img: mapPersp, pos: '52% 56%', size: '220%', hue: 40 },
  { name: 'Terraforge SMP', source: 'CurseForge', cached: true, img: mapTop, pos: '48% 52%', size: '290%', hue: -32 },
  { name: 'Creative Sandbox', source: 'Minecraft', cached: true, img: mapBiomes, pos: '46% 58%', size: '245%', hue: 8 },
];

function artStyle(w: MockWorld): React.CSSProperties {
  return {
    backgroundImage: `url(${w.img})`,
    backgroundSize: w.size,
    backgroundPosition: w.pos,
    filter: w.hue ? `hue-rotate(${w.hue}deg) saturate(1.03)` : undefined,
  };
}

/* The render pipeline the featured tile + detail pane replay together. */
const PHASES = [
  { label: 'Scanning regions', pct: 9, sub: 'Reading region headers' },
  { label: 'Building terrain', pct: 41, sub: '624 of 1,504 terrain tiles' },
  { label: 'Building terrain', pct: 78, sub: '1,173 of 1,504 terrain tiles' },
  { label: 'Creating world overview', pct: 92, sub: 'Baking the LOD pyramid' },
  { label: 'Packing textures', pct: 98, sub: 'Almost there' },
  { label: 'Ready', pct: 100, sub: 'Opening the GPU viewer' },
];

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/** Advances the mock render only while the window is on-screen. */
function useRenderLoop(reduced: boolean, live: boolean) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (reduced || !live) {
      setStep(PHASES.length - 1);
      return;
    }
    const id = window.setInterval(() => {
      setStep((s) => (s >= PHASES.length - 1 ? 0 : s + 1));
    }, 1500);
    return () => window.clearInterval(id);
  }, [reduced, live]);
  return step;
}

export function DesktopShowcase() {
  const reduced = usePrefersReducedMotion();
  const [live, setLive] = useState(false);
  const [os, setOs] = useState<'win' | 'mac' | 'linux' | 'other'>('other');
  const windowRef = useRef<HTMLDivElement>(null);

  // Only run the animation loop when the mock is actually visible.
  useEffect(() => {
    const el = windowRef.current;
    if (!el || !('IntersectionObserver' in window)) {
      setLive(true);
      return;
    }
    const io = new IntersectionObserver((e) => setLive(Boolean(e[0]?.isIntersecting)), { threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const ua = navigator.userAgent;
    const p = (navigator.platform || '').toLowerCase();
    if (/win/i.test(ua) || p.includes('win')) setOs('win');
    else if (/mac/i.test(ua) || p.includes('mac')) setOs('mac');
    else if (/linux|x11/i.test(ua) || p.includes('linux')) setOs('linux');
  }, []);

  const installer = useLatestInstaller();
  const step = useRenderLoop(reduced, live);
  const phase = PHASES[step] ?? PHASES[PHASES.length - 1]!;
  const rendering = phase.label !== 'Ready';
  const detected =
    os === 'mac' ? 'macOS' : os === 'linux' ? 'Linux' : os === 'win' ? 'Windows' : null;

  return (
    <section className="desktop-section" id="desktop">
      <p className="kicker reveal">
        <span className="ping" aria-hidden="true" /> new · desktop app
      </p>
      <h2 className="reveal">
        No command line. Just <em>your worlds</em>.
      </h2>
      <p className="lede reveal">
        Vantage Desktop finds every Java world on your PC — across Minecraft, Prism, MultiMC,
        CurseForge and more — renders it locally, and drops you straight into the 3D viewer.
      </p>

      <div className="studio-stage reveal">
        <div
          className="studio-window"
          ref={windowRef}
          aria-label="The Vantage desktop app: a library of local Minecraft worlds, each shown as a rendered map"
        >
          <div className="studio-titlebar">
            <span className="tl">
              <i /><i /><i />
            </span>
            <span className="studio-title">Vantage</span>
            <span className="studio-badge">world studio</span>
          </div>

          <div className="studio-body">
            <aside className="studio-sidebar">
              <div className="studio-brand">
                <span className="studio-mark" aria-hidden="true">
                  <i /><i /><i />
                </span>
                <span>
                  <strong>vantage</strong>
                  <small>world studio</small>
                </span>
              </div>
              <nav className="studio-nav">
                <button className="active" type="button" tabIndex={-1}>
                  <MapIcon size={16} /> Worlds <span>{WORLDS.length}</span>
                </button>
                <button type="button" tabIndex={-1} disabled>
                  <LayersIcon size={16} /> Renders <em>soon</em>
                </button>
              </nav>
              <div className="studio-sidebar-foot">
                <span className="studio-engine">
                  <i /> <b>Zig core</b>
                  <small>connected</small>
                </span>
              </div>
            </aside>

            <main className="studio-main">
              <header className="studio-head">
                <div>
                  <p className="studio-eyebrow">Local library</p>
                  <h3>Your worlds</h3>
                </div>
                <label className="studio-search">
                  <SearchIcon size={15} />
                  <span>Search worlds</span>
                  <kbd>Ctrl K</kbd>
                </label>
              </header>

              <div className="studio-content">
                <div className="studio-grid">
                  {WORLDS.map((w) => {
                    const active = Boolean(w.featured);
                    return (
                      <article key={w.name} className={`studio-card${w.featured ? ' featured' : ''}${active ? ' active' : ''}`}>
                        <div className="studio-art" style={artStyle(w)} />
                        <div className="studio-art-shade" />
                        {active && rendering && !reduced && <span className="scanline" aria-hidden="true" />}
                        {w.cached ? (
                          <span className="studio-badge-chip">
                            <CheckIcon size={11} /> rendered
                          </span>
                        ) : rendering ? (
                          <span className="studio-badge-chip live">
                            <span className="dot" /> rendering {phase.pct}%
                          </span>
                        ) : null}
                        <div className="studio-art-label">
                          <b>{w.name}</b>
                          <span className="studio-chip">{w.source}</span>
                        </div>
                        <span className="studio-play">
                          <PlayIcon size={w.featured ? 16 : 12} />
                        </span>
                        {active && rendering && (
                          <span className="studio-card-bar" aria-hidden="true">
                            <span style={{ width: `${phase.pct}%` }} />
                          </span>
                        )}
                      </article>
                    );
                  })}
                </div>

                <aside className="studio-detail">
                  <div className="studio-preview">
                    <div className="studio-preview-map" style={{ backgroundImage: `url(${mapTop})` }} />
                    <span className="studio-preview-tag">
                      <MapIcon size={11} /> top-down · press 2
                    </span>
                  </div>
                  <p className="studio-eyebrow">Selected world</p>
                  <h4>Skyhold</h4>
                  <div className="studio-stats">
                    <div>
                      <small>Edition</small>
                      <b>Java</b>
                    </div>
                    <div>
                      <small>Data version</small>
                      <b>4325</b>
                    </div>
                    <div>
                      <small>Found via</small>
                      <b>Minecraft</b>
                    </div>
                  </div>

                  {rendering ? (
                    <div className="studio-progress">
                      <div className="studio-progress-head">
                        <span>
                          <SparklesIcon className="spin-slow" size={14} /> {phase.label}
                        </span>
                        <b>{phase.pct}%</b>
                      </div>
                      <div className="studio-track">
                        <span style={{ width: `${phase.pct}%` }} />
                      </div>
                      <p>{phase.sub}</p>
                    </div>
                  ) : (
                    <button className="studio-cta" type="button" tabIndex={-1}>
                      <CompassIcon size={16} /> Explore world <ChevronIcon size={16} />
                    </button>
                  )}
                </aside>
              </div>
            </main>
          </div>
        </div>
        <div className="studio-glow" aria-hidden="true" />
      </div>

      {/* ---------- download panel ---------- */}
      <div className="download reveal">
        <div className="dl-lead">
          <a className="cta cta-primary dl-btn" href={installer.url} rel="noreferrer">
            <WindowsIcon size={19} />
            Download for Windows
            <DownloadIcon size={17} className="dl-btn-arrow" />
          </a>
          <p className="dl-meta">
            {installer.version ? `v${installer.version} · ` : ''}signed <code>.exe</code> installer · Windows 10 &amp;
            11 · 64-bit
          </p>
          <p className="dl-detected">
            {detected && detected !== 'Windows' ? (
              <>We spotted {detected} — the {detected} build is on the way. </>
            ) : null}
            <a href={RELEASES} rel="noreferrer">
              All downloads &amp; release notes ↗
            </a>
          </p>
        </div>

        <ul className="dl-platforms" aria-label="Platform availability">
          <li className="dl-plat dl-plat-live">
            <WindowsIcon size={22} />
            <span>
              <b>Windows</b>
              <small>Available now</small>
            </span>
            <a className="dl-plat-btn" href={installer.url} rel="noreferrer" aria-label="Download for Windows">
              <DownloadIcon size={16} />
            </a>
          </li>
          <li className="dl-plat">
            <AppleIcon size={22} />
            <span>
              <b>macOS</b>
              <small>Coming soon</small>
            </span>
            <em>soon</em>
          </li>
          <li className="dl-plat">
            <LinuxIcon size={22} />
            <span>
              <b>Linux</b>
              <small>Coming soon</small>
            </span>
            <em>soon</em>
          </li>
        </ul>
      </div>

      <div className="dl-feats">
        <div className="dl-feat reveal">
          <span className="dl-feat-ic"><SearchIcon size={18} /></span>
          <h4>Finds your worlds for you</h4>
          <p>Scans every launcher on the machine — vanilla, Prism, MultiMC, CurseForge, Modrinth, GDLauncher.</p>
        </div>
        <div className="dl-feat reveal">
          <span className="dl-feat-ic"><SparklesIcon size={18} /></span>
          <h4>Never touches your save</h4>
          <p>Reads the world read-only and renders into its own cache folder. Nothing is uploaded, ever.</p>
        </div>
        <div className="dl-feat reveal">
          <span className="dl-feat-ic"><CompassIcon size={18} /></span>
          <h4>Straight into the viewer</h4>
          <p>The same GPU viewer as the web, at 120+ FPS — one double-click from a rendered world.</p>
        </div>
      </div>
    </section>
  );
}
