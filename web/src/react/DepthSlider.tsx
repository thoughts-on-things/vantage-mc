// <DepthSlider> — the cave view's depth gauge: a vertical strip on the left
// edge that appears while the engine's depth slice is open and drags the cut
// plane up and down the world's Y range. The track is painted like a core
// sample of the dimension it is slicing (the overworld's sky → grass → stone →
// bedrock, the nether's crust → netherrack → lava, the end's void → endstone);
// everything above the thumb is struck through, mirroring what the slice cut
// away. Landmarks mark the dimension's own reference heights. `[` / `]` nudge
// the depth; the toggle key (default `c`, shared with <MapNav>'s layers button)
// opens and closes the view.

import { useEffect, useRef, useState } from 'react';
import { useVantage } from './context.js';
import type { WorldDimension } from '../three/index.js';

/** The core sample painted into the track, top of the world first, plus the
 *  landmark heights worth labelling in that dimension. */
const CORE: Record<WorldDimension['kind'], { gradient: string; marks: { y: number; label: string }[] }> = {
  overworld: {
    gradient: 'linear-gradient(180deg, #6f9bce 0%, #6e9150 12%, #6e6f74 48%, #3e424b 76%, #16181d 100%)',
    marks: [
      { y: 63, label: 'sea' },
      { y: 0, label: '0' },
    ],
  },
  nether: {
    // Roof crust, netherrack, then the lava sea the caverns bottom out in.
    gradient: 'linear-gradient(180deg, #3a2320 0%, #6b3330 22%, #7a3a38 62%, #b4471d 88%, #d9691f 100%)',
    marks: [
      { y: 31, label: 'lava' },
      { y: 4, label: 'floor' },
    ],
  },
  end: {
    gradient: 'linear-gradient(180deg, #17131f 0%, #2a2338 34%, #ded8a5 62%, #b8b183 82%, #17131f 100%)',
    marks: [{ y: 49, label: 'gate' }],
  },
  custom: {
    gradient: 'linear-gradient(180deg, #6f9bce 0%, #6e9150 12%, #6e6f74 48%, #3e424b 76%, #16181d 100%)',
    marks: [{ y: 0, label: '0' }],
  },
};

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
  const { viewer, info, dimension } = useVantage();
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

  // The core sample for whichever dimension is loaded, with only the landmarks
  // that fall inside its baked range.
  const core = CORE[dimension?.kind ?? 'overworld'];
  const marks = core.marks.filter((m) => m.y > min && m.y < max);

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
        <div className="vtg-depth-track" style={{ background: core.gradient }}>
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
