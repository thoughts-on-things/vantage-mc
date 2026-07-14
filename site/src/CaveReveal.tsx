// The cave-view showcase: a looping capture of the depth slice peeling the
// world open, and a draggable before/after wipe of the same camera one
// keypress apart. All media is recorded from the real viewer — same tiles the
// live demo streams.

import { useEffect, useRef, useState } from 'react';
import caveVideo from './assets/cave-slice.webm';
import cavePoster from './assets/cave-poster.jpg';
import caveBefore from './assets/cave-before.jpg';
import caveAfter from './assets/cave-after.jpg';

/** Draggable before/after wipe. Pointer-driven, no dependencies. */
function Wipe() {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(0.5);

  const fromPointer = (clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos(Math.min(Math.max((clientX - r.left) / r.width, 0.02), 0.98));
  };

  return (
    <div
      className="wipe"
      ref={ref}
      role="slider"
      aria-label="Compare surface and cave view"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pos * 100)}
      tabIndex={0}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        fromPointer(e.clientX);
      }}
      onPointerMove={(e) => e.buttons === 1 && fromPointer(e.clientX)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') setPos((p) => Math.max(p - 0.04, 0.02));
        if (e.key === 'ArrowRight') setPos((p) => Math.min(p + 0.04, 0.98));
      }}
    >
      <img src={caveAfter} alt="The same terrain sliced open at deepslate level: cave systems, lava pockets, geodes, and a mineshaft" loading="lazy" />
      <div className="wipe-top" style={{ clipPath: `inset(0 ${100 - pos * 100}% 0 0)` }}>
        <img src={caveBefore} alt="Forested surface terrain" loading="lazy" />
      </div>
      <div className="wipe-handle" style={{ left: `${pos * 100}%` }} aria-hidden="true">
        <span>⇔</span>
      </div>
      <span className="wipe-tag wipe-tag-l" aria-hidden="true">surface</span>
      <span className="wipe-tag wipe-tag-r" aria-hidden="true">y = 14</span>
    </div>
  );
}

export function CaveReveal() {
  // The capture is ~8 MB — don't fetch it with the page. The poster holds the
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
    <section className="cave" id="caves">
      <p className="kicker reveal">new · the cave view</p>
      <h2 className="reveal">
        Slice the world <em>open</em>
      </h2>
      <p className="lede reveal">
        Your world doesn&apos;t stop at the surface. Slice the map at any depth: caves, mineshafts, geodes, lava —
        all in place, all in 3D.
      </p>

      <figure className="cave-video reveal">
        <div className="viewport-frame">
          <video ref={videoRef} src={caveVideo} poster={cavePoster} preload="metadata" muted loop playsInline />
        </div>
        <figcaption>
          captured in the viewer · press <b>C</b> in the live demo to try it
        </figcaption>
      </figure>

      <div className="cave-row reveal">
        <figure className="cave-wipe">
          <Wipe />
          <figcaption>drag to compare · same camera, sliced at y = 14</figcaption>
        </figure>
        <div className="cave-notes">
          <h3>One extra flag</h3>
          <pre>
            <code>
              <span className="p">$</span> vantage render {'<save>'} --caves full
            </code>
          </pre>
          <ul>
            <li>Costs disk, not render time.</li>
            <li>Solid rock draws as a dark grid, so caves stand out.</li>
            <li>The slice depth is part of the URL — a cave find is a link.</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
