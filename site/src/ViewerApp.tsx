// Full-screen viewer mode — the real vantage-mc React components, exactly as a
// consumer would mount them, plus a thin site chrome (back button, world label,
// controls legend).

import { useEffect, useMemo, useState } from 'react';
import {
  BiomeLayer,
  DepthSlider,
  LightPanel,
  MapNav,
  Reticle,
  SettingsPanel,
  useVantage,
  VantageViewer,
} from 'vantage-mc/react';

function Chrome({ label, onExit }: { label: string; onExit: () => void }) {
  const { viewer, status, error } = useVantage();
  const [flying, setFlying] = useState(false);
  useEffect(() => {
    if (!viewer) return;
    setFlying(viewer.isFlying);
    return viewer.on('mode', ({ fly }) => setFlying(fly));
  }, [viewer]);

  return (
    <>
      <div className="viewer-chrome vtg-glass">
        <button className="viewer-back" onClick={onExit} title="Back to the site">
          ← <span className="viewer-wordmark">vantage</span>
        </button>
        <span className="viewer-label" title={label}>
          {label}
        </span>
      </div>
      {status === 'ready' && (
        <div className="viewer-legend vtg-glass">
          {flying ? (
            <>
              <b>WASD</b> fly · <b>Space/Shift</b> up·down · <b>mouse</b> look · <b>Esc</b> exit
            </>
          ) : (
            <>
              <b>drag</b> pan · <b>right-drag</b> orbit · <b>scroll</b> zoom · <b>B</b> biomes · <b>C</b> caves
            </>
          )}
        </div>
      )}
      {status === 'error' && error && (
        <div className="viewer-error vtg-glass">
          <p>{error.message}</p>
          <button onClick={onExit}>← back to the site</button>
        </div>
      )}
    </>
  );
}

export function ViewerApp({ world, label, onExit }: { world: string; label: string; onExit: () => void }) {
  // First paint fast on the public site: a lighter ring than the library
  // default, live-tunable from the settings panel once you're in.
  const streaming = useMemo(() => ({ viewDistance: 512, maxTiles: 80 }), []);
  return (
    <div className="viewer-shell">
      <VantageViewer world={world} streaming={streaming}>
        <Chrome label={label} onExit={onExit} />
        <Reticle />
        <BiomeLayer legend hover />
        <LightPanel />
        <SettingsPanel />
        <MapNav />
        <DepthSlider />
      </VantageViewer>
    </div>
  );
}
