// The live-players showcase: a looping capture of people walking a real map,
// and a still of the roster with one of them being followed. Both are recorded
// from the viewer against the same demo world the live map streams.

import { useEffect, useRef } from 'react';
import playersVideo from './assets/players-live.webm';
import playersPoster from './assets/players-poster.jpg';
import playersPanel from './assets/players-panel.jpg';

const GITHUB = 'https://github.com/thoughts-on-things/vantage-mc';

export function PlayerShowcase() {
  // The capture is ~7 MB — don't fetch it with the page. The poster holds the
  // frame until the section scrolls into view, then the loop starts (and
  // pauses again off-screen).
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        if (entry.isIntersecting) void el.play().catch(() => {});
        else el.pause();
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <section className="players" id="players">
      <p className="kicker reveal">new · live players</p>
      <h2 className="reveal">
        See <em>who&apos;s online</em>, and where
      </h2>
      <p className="lede reveal">
        Not a dot on a minimap — the actual player model, walking where they walk.
      </p>

      <figure className="players-video reveal">
        <div className="viewport-frame">
          <video ref={videoRef} src={playersVideo} poster={playersPoster} preload="none" muted loop playsInline />
        </div>
        <figcaption>captured in the viewer · same world the live demo streams</figcaption>
      </figure>

      <div className="players-row reveal">
        <figure className="players-shot">
          <img
            src={playersPanel}
            alt="The Vantage map with five players on it: a roster panel on the left, and one player followed by the camera with a highlighted name tag"
            loading="lazy"
            width={1280}
            height={720}
          />
          <figcaption>click a name to fly there · pin one and the camera goes with them</figcaption>
        </figure>
        <div className="players-notes">
          <h3>One file, no plugin required</h3>
          <pre>
            <code>
              <span className="p">$</span> vantage server {'<world>'} --players-file /run/players.json
            </code>
          </pre>
          <ul>
            <li>
              Your server writes a small JSON roster; Vantage serves and draws it. Already running BlueMap?{' '}
              <b>Point it at the file that plugin already writes.</b>
            </li>
            <li>
              No server integration at all? Vantage reads last-known positions straight out of the save, and says so —
              faint models, &ldquo;seen 20m ago&rdquo;.
            </li>
            <li>
              Positions steer the background bake too, so the map is already warm where your players are standing.
            </li>
            <li>
              Skins are generated from each player&apos;s id by default. No third-party skin service ever learns who is
              on your server, or who is watching.
            </li>
          </ul>
          <a href={`${GITHUB}/blob/main/docs/players.md`} rel="noreferrer">
            how live players work ↗
          </a>
        </div>
      </div>
    </section>
  );
}
