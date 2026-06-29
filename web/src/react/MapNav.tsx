// <MapNav> — the floating navigation cluster: a compass that tracks the camera
// heading (click to face north), a 2D/3D toggle that levels or restores the tilt,
// zoom in/out buttons (the same inertial zoom as the wheel), a home button that
// re-frames the tile, and a live readout of the world coordinate the view is
// centred on. It reads the engine's controls every frame and writes the DOM
// directly (needle transform, tilt label, coordinate text), so it never triggers
// a React re-render while you fly around.

import { useEffect, useRef } from 'react';
import { useVantage } from './context.js';
import { DEFAULT_ORBIT_ANGLE } from '../three/index.js';

export interface MapNavProps {
  /** Show the compass. Default `true`. */
  compass?: boolean;
  /** Show the 2D/3D tilt toggle. Default `true`. */
  tilt?: boolean;
  /** Show the zoom in/out buttons. Default `true`. */
  zoom?: boolean;
  /** Show the home (re-frame) button. Default `true`. */
  home?: boolean;
  /** Show the centred-coordinate readout. Default `true`. */
  coords?: boolean;
  className?: string;
}

/** Above this pitch (radians) the view counts as tilted ("3D"). */
const TILT_THRESHOLD = 0.12;

const Icon = {
  minus: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <line x1="3.5" y1="8" x2="12.5" y2="8" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <line x1="3.5" y1="8" x2="12.5" y2="8" />
      <line x1="8" y1="3.5" x2="8" y2="12.5" />
    </svg>
  ),
  home: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 7.5 8 3l5.5 4.5" />
      <path d="M4 7v5.5h8V7" />
    </svg>
  ),
};

export function MapNav({ compass = true, tilt = true, zoom = true, home = true, coords = true, className }: MapNavProps) {
  const { viewer } = useVantage();
  const needleRef = useRef<SVGGElement>(null);
  const coordRef = useRef<HTMLSpanElement>(null);
  const tiltRef = useRef<HTMLButtonElement>(null);

  // Drive the compass needle, tilt label, and coordinate text from the live
  // camera each frame — imperatively, no React state, no re-render churn.
  useEffect(() => {
    if (!viewer) return;
    let raf = 0;
    let lastDeg = NaN;
    let lastTxt = '';
    let last3d: boolean | null = null;
    const tick = () => {
      const c = viewer.controls;
      const deg = (c.rotation * 180) / Math.PI;
      if (needleRef.current && deg !== lastDeg) {
        needleRef.current.setAttribute('transform', `rotate(${(-deg).toFixed(1)})`);
        lastDeg = deg;
      }
      if (coordRef.current) {
        const txt = `${Math.round(c.position.x)}, ${Math.round(c.position.z)}`;
        if (txt !== lastTxt) {
          coordRef.current.textContent = txt;
          lastTxt = txt;
        }
      }
      if (tiltRef.current) {
        const is3d = c.angle > TILT_THRESHOLD;
        if (is3d !== last3d) {
          tiltRef.current.textContent = is3d ? '3D' : '2D';
          tiltRef.current.classList.toggle('vtg-on', is3d);
          tiltRef.current.title = is3d ? 'Level to top-down (2D)' : 'Tilt to 3D';
          last3d = is3d;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [viewer]);

  if (!viewer) return null;

  // Toggle between a flat top-down map and the default aerial tilt.
  const toggleTilt = () => viewer.setTilt(viewer.tilt > TILT_THRESHOLD ? 0 : DEFAULT_ORBIT_ANGLE);

  return (
    <div className={className ? `vtg-nav vtg-glass ${className}` : 'vtg-nav vtg-glass'} role="group" aria-label="map navigation">
      {compass && (
        <button type="button" className="vtg-compass" title="Face north" aria-label="Face north" onClick={() => viewer.resetNorth()}>
          <svg viewBox="-16 -16 32 32" aria-hidden="true">
            <circle cx="0" cy="0" r="14.5" fill="none" stroke="rgba(140,178,238,0.18)" strokeWidth="1" />
            <g ref={needleRef}>
              <polygon className="vtg-n" points="0,-10.5 3.6,0.5 0,-1.8 -3.6,0.5" />
              <polygon className="vtg-s" points="0,10.5 3.6,-0.5 0,1.8 -3.6,-0.5" />
              <text className="vtg-cn" x="0" y="-11.5" textAnchor="middle">N</text>
            </g>
          </svg>
        </button>
      )}

      {tilt && (
        <button ref={tiltRef} type="button" className="vtg-navbtn vtg-navbtn-text" title="Tilt to 3D" aria-label="Toggle tilt" onClick={toggleTilt}>
          3D
        </button>
      )}

      {coords && (
        <span className="vtg-coords" title="World X, Z at view centre">
          <b>xz</b>
          <span ref={coordRef}>0, 0</span>
        </span>
      )}

      {(zoom || home) && <span className="vtg-nav-sep" />}

      {zoom && (
        <>
          <button type="button" className="vtg-navbtn" title="Zoom out" aria-label="Zoom out" onClick={() => viewer.zoomBy(-1)}>
            {Icon.minus}
          </button>
          <button type="button" className="vtg-navbtn" title="Zoom in" aria-label="Zoom in" onClick={() => viewer.zoomBy(1)}>
            {Icon.plus}
          </button>
        </>
      )}

      {home && (
        <button type="button" className="vtg-navbtn" title="Reset view" aria-label="Reset view" onClick={() => viewer.resetView()}>
          {Icon.home}
        </button>
      )}
    </div>
  );
}
