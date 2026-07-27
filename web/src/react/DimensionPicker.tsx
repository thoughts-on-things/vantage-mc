// <DimensionPicker> — switch between the dimensions of a rendered world.
//
// Renders nothing unless the loaded world has more than one dimension (i.e. it
// came from a `world.json` index), so it can be dropped into any viewer
// unconditionally. Each dimension is its own render: picking one reloads the
// map, restoring wherever the camera last was in it.
//
// The row behaves like a toolbar: Tab reaches the current dimension, arrow keys
// walk the rest, Enter/Space switches. Activation is manual on purpose — a
// dimension change is a full world load, too heavy to fire on every arrow press.

import { useRef, useState } from 'react';
import { useVantage } from './context.js';
import type { WorldDimension } from '../three/index.js';

export interface DimensionPickerProps {
  /** Extra class on the root element. */
  className?: string;
  /** Where the picker sits. Default `'top-center'` — it reads as a tab bar
   *  above the map, clear of the corner panels. */
  position?: 'top-center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
}

/** One line-drawn glyph per dimension, in the same 16px language as <MapNav>:
 *  the overworld's sunlit hills, the nether's flame, the end's void star. */
const ICON: Record<WorldDimension['kind'], React.ReactElement> = {
  overworld: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11.7" cy="4.3" r="1.9" />
      <path d="M1.6 12.6 5.3 7.4l2.4 3.1 1.6-1.9 3.6 4z" />
    </svg>
  ),
  nether: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 14.2c2.4 0 4.2-1.7 4.2-4 0-3.6-2.6-5.2-4.2-8.4C6.4 5 3.8 6.6 3.8 10.2c0 2.3 1.8 4 4.2 4z" />
      <path d="M8 14.2c1.2 0 2-.9 2-2 0-1.4-1.1-2.1-2-3.4-.9 1.3-2 2-2 3.4 0 1.1.8 2 2 2z" />
    </svg>
  ),
  end: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2.2c.6 3.3 2.5 5.2 5.8 5.8-3.3.6-5.2 2.5-5.8 5.8-.6-3.3-2.5-5.2-5.8-5.8C5.5 7.4 7.4 5.5 8 2.2z" />
    </svg>
  ),
  custom: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2.2 13.8 8 8 13.8 2.2 8z" />
      <path d="M8 5.6 10.4 8 8 10.4 5.6 8z" />
    </svg>
  ),
};

/** Placement is a class, not an inline style, so the stylesheet can move the
 *  row to the bottom on phone-width screens where the corners are already full. */
const POSITIONS: Record<NonNullable<DimensionPickerProps['position']>, string> = {
  'top-center': 'vtg-dims-tc',
  'top-left': 'vtg-dims-tl',
  'top-right': 'vtg-dims-tr',
  'bottom-left': 'vtg-dims-bl',
  'bottom-right': 'vtg-dims-br',
};

export function DimensionPicker({ className, position = 'top-center' }: DimensionPickerProps) {
  const { viewer, dimensions, dimension } = useVantage();
  const [switching, setSwitching] = useState<string | null>(null);
  // Roving tab stop: anchored to the current dimension until the arrow keys
  // move it, so Tab always lands somewhere meaningful.
  const [roving, setRoving] = useState<number | null>(null);
  const btns = useRef<(HTMLButtonElement | null)[]>([]);

  // One dimension (or a plain manifest world) has nothing to switch between.
  if (!viewer || dimensions.length < 2) return null;

  const activeIndex = Math.max(
    0,
    dimensions.findIndex((d) => d.slug === dimension?.slug),
  );
  // The tab stop has to be a button that can take focus: an empty dimension is
  // disabled, so anchor on the first one with tiles when the open one is empty.
  const anchor = dimensions[activeIndex]!.tiles > 0 ? activeIndex : Math.max(0, dimensions.findIndex((d) => d.tiles > 0));
  const stop = roving ?? anchor;

  const select = (d: WorldDimension) => {
    if (d.slug === dimension?.slug || switching) return;
    setSwitching(d.slug);
    void viewer
      .setDimension(d.slug)
      .catch(() => {}) // the engine keeps the current world on failure
      .finally(() => setSwitching(null));
  };

  // Walk to the next dimension with something to look at, wrapping around.
  const move = (from: number, step: number) => {
    const n = dimensions.length;
    for (let k = 1; k <= n; k++) {
      const i = (((from + step * k) % n) + n) % n;
      if (dimensions[i]!.tiles > 0) {
        setRoving(i);
        btns.current[i]?.focus();
        return;
      }
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') move(stop, 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') move(stop, -1);
    else if (e.key === 'Home') move(-1, 1);
    else if (e.key === 'End') move(dimensions.length, -1);
    else return;
    e.preventDefault();
  };

  return (
    <div
      className={`vtg-dims vtg-glass ${POSITIONS[position]}${className ? ` ${className}` : ''}`}
      role="toolbar"
      aria-orientation="horizontal"
      aria-label="Dimensions"
      aria-busy={switching !== null}
      onKeyDown={onKeyDown}
    >
      {dimensions.map((d, i) => {
        const active = d.slug === dimension?.slug;
        const empty = d.tiles === 0;
        const busy = switching === d.slug;
        return (
          <button
            key={d.slug}
            ref={(el) => {
              btns.current[i] = el;
            }}
            type="button"
            className={`vtg-dim-btn vtg-k-${d.kind}${active ? ' vtg-on' : ''}`}
            aria-pressed={active}
            aria-busy={busy}
            tabIndex={i === stop ? 0 : -1}
            // An empty dimension has a manifest but nothing to look at.
            disabled={empty}
            title={empty ? `${d.label} — nothing generated yet` : active ? d.label : `${d.label} — ${d.tiles.toLocaleString()} tiles`}
            onFocus={() => setRoving(i)}
            onClick={() => select(d)}
          >
            {/* Fixed-size slot: the spinner takes the glyph's place while a
                dimension loads, so the row never twitches mid-switch. */}
            <span className="vtg-dim-ico" aria-hidden="true">
              {busy ? <i className="vtg-dim-spin" /> : ICON[d.kind]}
            </span>
            <span className="vtg-dim-label">{d.label}</span>
          </button>
        );
      })}
    </div>
  );
}
