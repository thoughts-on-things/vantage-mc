// <Reticle> — a subtle marker at the screen centre, where the camera's look-at
// pivot always projects. It gives the eye a fixed reference while panning and,
// crucially, shows the point the view rotates and tilts around. It's faint at
// rest and brightens into a ring during a drag (read each frame from the
// controls, no React re-render).

import { useEffect, useRef } from 'react';
import { useVantage } from './context.js';

export interface ReticleProps {
  className?: string;
}

export function Reticle({ className }: ReticleProps) {
  const { viewer } = useVantage();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!viewer) return;
    let raf = 0;
    let active = false;
    const tick = () => {
      const next = viewer.controls.isInteracting;
      if (next !== active && ref.current) {
        ref.current.classList.toggle('vtg-reticle-on', next);
        active = next;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [viewer]);

  if (!viewer) return null;

  return (
    <div ref={ref} className={className ? `vtg-reticle ${className}` : 'vtg-reticle'} aria-hidden="true">
      <span className="vtg-ret-ring" />
      <span className="vtg-ret-dot" />
    </div>
  );
}
