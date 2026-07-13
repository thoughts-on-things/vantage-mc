// <DepthSlider> — the cave view's depth gauge: a vertical strip on the left
// edge that appears while the engine's depth slice is open and drags the cut
// plane up and down the world's Y range. The track is painted like a core
// sample (sky → grass → stone → deepslate → bedrock); everything above the
// thumb is struck through, mirroring what the slice cut away. Landmarks mark
// sea level and y=0. `[` / `]` nudge the depth; the toggle key (default `c`,
// shared with <MapNav>'s layers button) opens and closes the view.

import { useEffect, useRef, useState } from 'react';
import { useVantage } from './context.js';

export interface DepthSliderProps {
  /** Key that toggles the cave view. Default `'c'`; pass `null` to disable. */
  toggleKey?: string | null;
  /** World-Y step for the `[` / `]` nudge keys. Default `4`. */
  step?: number;
  className?: string;
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA';
}

export function DepthSlider({ toggleKey = 'c', step = 4, className }: DepthSliderProps) {
  const { viewer, info } = useVantage();
  const trackRef = useRef<HTMLDivElement>(null);
  const [sliceY, setSliceY] = useState<number | null>(null);

  // Mirror the engine's slice state (it may also change via deep links,
  // MapNav, or the keyboard).
  useEffect(() => {
    if (!viewer) return;
    setSliceY(viewer.slice);
    return viewer.on('slice', ({ y }) => setSliceY(y));
  }, [viewer]);

  // Keyboard: toggle the view, nudge the depth while it is open.
  useEffect(() => {
    if (!viewer) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (toggleKey && e.key.toLowerCase() === toggleKey.toLowerCase()) {
        // Open only on worlds baked with full caves (`--caves full`) — on a
        // culled bake the reveal would be full of missing-geometry holes.
        // Closing is always allowed.
        if (viewer.hasCaves || viewer.slice !== null) viewer.toggleSlice();
      } else if (viewer.slice !== null && (e.key === '[' || e.key === ']')) {
        viewer.setSlice(viewer.slice + (e.key === ']' ? step : -step));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewer, toggleKey, step]);

  // `info` re-renders us on world load, when hasCaves becomes meaningful.
  if (!viewer || !info || sliceY === null) return null;

  const { min, max } = viewer.sliceRange;
  const frac = (y: number) => Math.min(Math.max((max - y) / (max - min), 0), 1);
  const thumbTop = frac(sliceY) * 100;

  const setFromPointer = (e: { clientY: number }) => {
    const track = trackRef.current;
    if (!track) return;
    const r = track.getBoundingClientRect();
    const t = Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1);
    viewer.setSlice(Math.round(max - t * (max - min)));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setFromPointer(e);
  };

  // Landmarks only where they fall inside the baked range.
  const marks: { y: number; label: string }[] = [];
  if (63 > min && 63 < max) marks.push({ y: 63, label: 'sea' });
  if (0 > min && 0 < max) marks.push({ y: 0, label: '0' });

  return (
    <div className={className ? `vtg-depth vtg-glass ${className}` : 'vtg-depth vtg-glass'} role="group" aria-label="cave view depth">
      <div className="vtg-depth-val" title="Slice depth (world Y)">
        <b>Y</b>
        {Math.round(sliceY)}
      </div>
      <div
        ref={trackRef}
        className="vtg-depth-rail"
        role="slider"
        aria-label="Slice depth"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Math.round(sliceY)}
        aria-orientation="vertical"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={(e) => e.buttons === 1 && setFromPointer(e)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') viewer.setSlice(sliceY + 1);
          else if (e.key === 'ArrowDown') viewer.setSlice(sliceY - 1);
        }}
      >
        <div className="vtg-depth-track">
          <div className="vtg-depth-cut" style={{ height: `${thumbTop}%` }} />
        </div>
        {marks.map((m) => (
          <div key={m.label} className="vtg-depth-mark" style={{ top: `${frac(m.y) * 100}%` }}>
            <i />
            <span>{m.label}</span>
          </div>
        ))}
        <div className="vtg-depth-thumb" style={{ top: `${thumbTop}%` }} />
      </div>
      <button
        type="button"
        className="vtg-depth-close"
        title="Close the cave view"
        aria-label="Close the cave view"
        onClick={() => viewer.setSlice(null)}
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M4.5 4.5 11.5 11.5" />
          <path d="M11.5 4.5 4.5 11.5" />
        </svg>
      </button>
    </div>
  );
}
