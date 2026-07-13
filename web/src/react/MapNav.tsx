// <MapNav> — the floating navigation cluster: a compass that tracks the camera
// heading (click to face north), a 2D/3D toggle that levels or restores the tilt,
// zoom in/out buttons (the same inertial zoom as the wheel), a home button that
// re-frames the tile, and a live readout of the world coordinate the view is
// centred on. It reads the engine's controls every frame and writes the DOM
// directly (needle transform, tilt label, coordinate text), so it never triggers
// a React re-render while you fly around.

import { useEffect, useRef, useState } from 'react';
import { useVantage } from './context.js';
import { DEFAULT_ORBIT_ANGLE } from '../three/index.js';

export interface MapNavProps {
  /** Show the compass. Default `true`. */
  compass?: boolean;
  /** Show the 2D/3D tilt toggle. Default `true`. */
  tilt?: boolean;
  /** Show the free-flight toggle. Default `true`. */
  fly?: boolean;
  /** Show the zoom in/out buttons. Default `true`. */
  zoom?: boolean;
  /** Show the home (re-frame) button. Default `true`. */
  home?: boolean;
  /** Show the centred-coordinate readout. Default `true`. */
  coords?: boolean;
  /** Show the screenshot (PNG download) button. Default `true`. */
  screenshot?: boolean;
  /** Show the fullscreen toggle. Default `true` (hidden automatically where
   *  the Fullscreen API is unavailable, e.g. iPhone Safari). */
  fullscreen?: boolean;
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
  fly: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 1.5 1.2 6.6l5 1.7 1.7 5z" />
      <path d="M14.5 1.5 7.9 8.1" />
    </svg>
  ),
  camera: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 5h2.2L6 3h4l1.8 2H14v8H2z" />
      <circle cx="8" cy="9" r="2.4" />
    </svg>
  ),
  expand: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2.5H2.5V6" />
      <path d="M10 2.5h3.5V6" />
      <path d="M6 13.5H2.5V10" />
      <path d="M10 13.5h3.5V10" />
    </svg>
  ),
  compress: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 6H6V2.5" />
      <path d="M13.5 6H10V2.5" />
      <path d="M2.5 10H6v3.5" />
      <path d="M13.5 10H10v3.5" />
    </svg>
  ),
};

export function MapNav({
  compass = true,
  tilt = true,
  fly = true,
  zoom = true,
  home = true,
  coords = true,
  screenshot = true,
  fullscreen = true,
  className,
}: MapNavProps) {
  const { viewer } = useVantage();
  const navRef = useRef<HTMLDivElement>(null);
  const needleRef = useRef<SVGGElement>(null);
  const coordRef = useRef<HTMLSpanElement>(null);
  const tiltRef = useRef<HTMLButtonElement>(null);
  const [flying, setFlying] = useState(false);
  const [isFs, setIsFs] = useState(false);

  // Free-flight is the one nav state that drives a real re-render (rare toggle),
  // so the button can reflect active styling and the tilt/home buttons can hide.
  useEffect(() => {
    if (!viewer) return;
    setFlying(viewer.isFlying);
    return viewer.on('mode', ({ fly }) => setFlying(fly));
  }, [viewer]);

  // Track fullscreen from the document so Esc / F11 keep the icon honest.
  useEffect(() => {
    const sync = () => setIsFs(document.fullscreenElement != null);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

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

  // Toggle between a clean north-up flat map (2D) and the default aerial tilt (3D).
  const toggleTilt = () => (viewer.tilt > TILT_THRESHOLD ? viewer.flatten() : viewer.setTilt(DEFAULT_ORBIT_ANGLE));

  // Save the current view as a PNG, named after the world coordinate.
  const takeScreenshot = () => {
    const p = viewer.controls.position;
    const a = document.createElement('a');
    a.href = viewer.screenshot();
    a.download = `vantage_${Math.round(p.x)}_${Math.round(p.z)}.png`;
    a.click();
  };

  // Fullscreen the whole viewer root (canvas + overlay panels), not just the
  // canvas — the legend and this nav should survive the transition. Requests
  // can still be denied at runtime (e.g. a sandboxed iframe that reports
  // fullscreenEnabled anyway), so rejections are swallowed, not thrown.
  const canFullscreen = typeof document !== 'undefined' && document.fullscreenEnabled;
  const toggleFullscreen = () => {
    if (document.fullscreenElement != null) document.exitFullscreen().catch(() => {});
    else
      (navRef.current?.closest('.vtg-root') ?? document.documentElement).requestFullscreen().catch(() => {});
  };

  return (
    <div ref={navRef} className={className ? `vtg-nav vtg-glass ${className}` : 'vtg-nav vtg-glass'} role="group" aria-label="map navigation">
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

      {tilt && !flying && (
        <button ref={tiltRef} type="button" className="vtg-navbtn vtg-navbtn-text" title="Tilt to 3D" aria-label="Toggle tilt" onClick={toggleTilt}>
          3D
        </button>
      )}

      {fly && (
        <button
          type="button"
          className={flying ? 'vtg-navbtn vtg-on' : 'vtg-navbtn'}
          title={flying ? 'Exit free-flight (Esc)' : 'Free-flight — fly over the world'}
          aria-label="Toggle free-flight"
          aria-pressed={flying}
          onClick={() => viewer.toggleFly()}
        >
          {Icon.fly}
        </button>
      )}

      {coords && (
        <span className="vtg-coords" title="World X, Z at view centre">
          <b>xz</b>
          <span ref={coordRef}>0, 0</span>
        </span>
      )}

      {(screenshot || (fullscreen && canFullscreen) || (!flying && (zoom || home))) && <span className="vtg-nav-sep" />}

      {zoom && !flying && (
        <>
          <button type="button" className="vtg-navbtn" title="Zoom out" aria-label="Zoom out" onClick={() => viewer.zoomBy(-1)}>
            {Icon.minus}
          </button>
          <button type="button" className="vtg-navbtn" title="Zoom in" aria-label="Zoom in" onClick={() => viewer.zoomBy(1)}>
            {Icon.plus}
          </button>
        </>
      )}

      {home && !flying && (
        <button type="button" className="vtg-navbtn" title="Reset view" aria-label="Reset view" onClick={() => viewer.resetView()}>
          {Icon.home}
        </button>
      )}

      {screenshot && (
        <button type="button" className="vtg-navbtn" title="Save a screenshot (PNG)" aria-label="Save a screenshot" onClick={takeScreenshot}>
          {Icon.camera}
        </button>
      )}

      {fullscreen && canFullscreen && (
        <button
          type="button"
          className={isFs ? 'vtg-navbtn vtg-on' : 'vtg-navbtn'}
          title={isFs ? 'Exit fullscreen' : 'Fullscreen'}
          aria-label="Toggle fullscreen"
          aria-pressed={isFs}
          onClick={toggleFullscreen}
        >
          {isFs ? Icon.compress : Icon.expand}
        </button>
      )}
    </div>
  );
}
