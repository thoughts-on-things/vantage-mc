// The render race — two real terminal sessions replayed on a shared timeline.
// Both tools rendered the same world on the same machine; the line timestamps
// and progress checkpoints in race.json are captured from those runs verbatim
// (see scripts/build-race.mjs). Nothing here is simulated except the smooth
// interpolation of the progress bars between real checkpoints.

import { useEffect, useRef, useState } from 'react';
import race from './assets/race.json';

interface Lane {
  name: string;
  cmd: string;
  total: number;
  lines: { t: number; text: string }[];
  /** Real progress checkpoints (t ms → fraction 0..1). */
  progress: { t: number; p: number }[];
}

const LANES: Lane[] = [race.vantage, race.bluemap];
const SPEEDS = [1, 4, 8];

function progressAt(lane: Lane, t: number): number {
  if (t >= lane.total) return 1;
  const pts = lane.progress;
  let prev = { t: 0, p: 0 };
  for (const pt of pts) {
    if (t < pt.t) return prev.p + (pt.p - prev.p) * ((t - prev.t) / (pt.t - prev.t || 1));
    prev = pt;
  }
  return prev.p + (1 - prev.p) * ((t - prev.t) / (lane.total - prev.t || 1));
}

function LanePane({ lane, t }: { lane: Lane; t: number }) {
  const done = t >= lane.total;
  const shown = lane.lines.filter((l) => l.t <= t);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length]);
  const secs = (Math.min(t, lane.total) / 1000).toFixed(1);
  return (
    <div className={done ? 'race-lane race-done' : 'race-lane'}>
      <div className="race-head">
        <span className="race-name">{lane.name}</span>
        <span className="race-clock">{secs}s</span>
        <span className="race-status">{done ? '✓ done' : 'rendering…'}</span>
      </div>
      <div className="race-bar">
        <div className="race-fill" style={{ width: `${(progressAt(lane, t) * 100).toFixed(2)}%` }} />
      </div>
      <div className="race-term" ref={scroller}>
        <div className="race-cmd">$ {lane.cmd}</div>
        {shown.map((l, i) => (
          <div key={i}>{l.text}</div>
        ))}
        {!done && <div className="race-cursor">▌</div>}
      </div>
    </div>
  );
}

export function RaceReplay() {
  const [t, setT] = useState(0);
  const [speed, setSpeed] = useState(4);
  const [playing, setPlaying] = useState(false);
  const started = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const finish = Math.max(...LANES.map((l) => l.total));

  // Autoplay the first time the section scrolls into view (never for
  // reduced-motion users — the play button is theirs).
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !('IntersectionObserver' in window)) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !started.current) {
          started.current = true;
          setPlaying(true);
        }
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) * speed;
      last = now;
      setT((prev) => {
        const next = prev + dt;
        if (next >= finish + 400) {
          setPlaying(false);
          return finish;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, finish]);

  const restart = () => {
    setT(0);
    setPlaying(true);
  };

  return (
    <div className="race" ref={rootRef}>
      <div className="race-lanes">
        {LANES.map((lane) => (
          <LanePane key={lane.name} lane={lane} t={t} />
        ))}
      </div>
      <div className="race-controls">
        <button className="race-btn" onClick={playing ? () => setPlaying(false) : restart}>
          {playing ? '❚❚ pause' : t >= finish ? '↻ replay' : '▶ play'}
        </button>
        {SPEEDS.map((s) => (
          <button
            key={s}
            className={s === speed ? 'race-btn race-btn-on' : 'race-btn'}
            onClick={() => setSpeed(s)}
          >
            {s}×
          </button>
        ))}
        <span className="race-caption">
          real terminal output, replayed · {race.world} · same machine, {race.threads} threads
        </span>
      </div>
    </div>
  );
}
