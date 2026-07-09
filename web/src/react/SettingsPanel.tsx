// <SettingsPanel> — the fidelity/performance dial, BlueMap's quality menu done
// as a drop-in panel. Presets (potato → ultra) set streaming range + render
// scale together; individual sliders expose the same knobs for fine-tuning.
// Everything applies live: streaming re-plans in place, no reload.

import { useEffect, useState } from 'react';
import { useVantage } from './context.js';
import { Panel } from './Panel.js';

export interface SettingsPanelProps {
  /** Panel heading. Default `'quality'`. */
  title?: string;
  /** Start collapsed to the header. Default `true`. */
  defaultCollapsed?: boolean;
  className?: string;
}

/** A quality preset: streamed range, resident-tile budget, and render scale.
 *  Tile budgets are sized to fill the view-distance disc (π·(vd/tileBlocks)²
 *  for 128-block tiles) so the range is actually reachable. */
export interface QualityPreset {
  name: string;
  viewDistance: number;
  maxTiles: number;
  renderScale: number;
}

export const QUALITY_PRESETS: QualityPreset[] = [
  { name: 'low', viewDistance: 448, maxTiles: 44, renderScale: 0.75 },
  { name: 'med', viewDistance: 768, maxTiles: 120, renderScale: 1 },
  { name: 'high', viewDistance: 1152, maxTiles: 264, renderScale: 1 },
  { name: 'ultra', viewDistance: 1408, maxTiles: 400, renderScale: 1 },
];

interface Knobs {
  viewDistance: number;
  maxTiles: number;
  renderScale: number;
  fog: number;
}

export function SettingsPanel({ title = 'quality', defaultCollapsed = true, className }: SettingsPanelProps) {
  const { viewer } = useVantage();
  const [k, setK] = useState<Knobs>({ viewDistance: 768, maxTiles: 120, renderScale: 1, fog: 1 });

  // Seed from the engine's current settings once it exists.
  useEffect(() => {
    if (!viewer) return;
    const s = viewer.streamingSettings;
    const d = viewer.displaySettings;
    setK({ viewDistance: s.viewDistance, maxTiles: s.maxTiles, renderScale: d.renderScale, fog: d.fog });
  }, [viewer]);

  if (!viewer) return null;

  const apply = (next: Partial<Knobs>) => {
    const merged = { ...k, ...next };
    setK(merged);
    if (next.viewDistance !== undefined || next.maxTiles !== undefined) {
      viewer.setStreaming({ viewDistance: merged.viewDistance, maxTiles: merged.maxTiles });
    }
    if (next.renderScale !== undefined || next.fog !== undefined) {
      viewer.setDisplay({ renderScale: merged.renderScale, fog: merged.fog });
    }
  };

  const active = QUALITY_PRESETS.find(
    (p) => p.viewDistance === k.viewDistance && p.maxTiles === k.maxTiles && p.renderScale === k.renderScale,
  );

  const SLIDERS = [
    { key: 'viewDistance' as const, label: 'view distance', min: 256, max: 2048, step: 64, fmt: (v: number) => `${v}m` },
    { key: 'maxTiles' as const, label: 'tile budget', min: 24, max: 512, step: 8, fmt: (v: number) => `${v}` },
    { key: 'renderScale' as const, label: 'render scale', min: 0.5, max: 2, step: 0.05, fmt: (v: number) => `${v.toFixed(2)}×` },
    { key: 'fog' as const, label: 'haze', min: 0, max: 1, step: 0.05, fmt: (v: number) => v.toFixed(2) },
  ];

  return (
    <Panel
      icon="⚙"
      title={title}
      defaultCollapsed={defaultCollapsed}
      className={className}
      style={{ top: 'auto', bottom: 16, right: 16, width: 232 }}
    >
      <div className="vtg-sliders">
        <div className="vtg-seg vtg-seg-full">
          {QUALITY_PRESETS.map((p) => (
            <button
              key={p.name}
              className={active?.name === p.name ? 'vtg-seg-on' : undefined}
              onClick={() => apply({ viewDistance: p.viewDistance, maxTiles: p.maxTiles, renderScale: p.renderScale })}
            >
              {p.name}
            </button>
          ))}
        </div>
        {SLIDERS.map((s) => (
          <label key={s.key} className="vtg-slider">
            <span className="vtg-slider-row">
              <span>{s.label}</span>
              <b>{s.fmt(k[s.key])}</b>
            </span>
            <input
              type="range"
              min={s.min}
              max={s.max}
              step={s.step}
              value={k[s.key]}
              onChange={(e) => apply({ [s.key]: Number(e.target.value) })}
            />
          </label>
        ))}
      </div>
    </Panel>
  );
}
