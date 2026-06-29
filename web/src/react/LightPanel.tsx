// <LightPanel> — a drop-in control panel for the live lighting appearance. Each
// slider drives the engine's setLight() (no re-bake), so this is the reference
// UI for the configurable lighting: daylight, ambient floor, and exposure.

import { useEffect, useState } from 'react';
import { useVantage } from './context.js';
import { Panel } from './Panel.js';
import type { LightSettings } from '../three/index.js';

export interface LightPanelProps {
  /** Panel heading. Default `'lighting'`. */
  title?: string;
  /** Start collapsed to the header. Default `true`. */
  defaultCollapsed?: boolean;
  className?: string;
}

interface Knob {
  key: keyof LightSettings;
  label: string;
  min: number;
  max: number;
  step: number;
}

const KNOBS: Knob[] = [
  { key: 'daylight', label: 'daylight', min: 0, max: 1, step: 0.01 },
  { key: 'ambient', label: 'ambient', min: 0, max: 0.6, step: 0.01 },
  { key: 'exposure', label: 'exposure', min: 0.4, max: 2, step: 0.01 },
];

export function LightPanel({ title = 'lighting', defaultCollapsed = true, className }: LightPanelProps) {
  const { viewer } = useVantage();
  const [light, setLight] = useState<Required<LightSettings>>({ ambient: 0.12, daylight: 1, exposure: 1 });

  // Seed the sliders from the engine's current settings once it exists.
  useEffect(() => {
    if (viewer) setLight(viewer.lightSettings);
  }, [viewer]);

  if (!viewer) return null;

  const update = (key: keyof LightSettings, value: number) => {
    setLight((p) => ({ ...p, [key]: value }));
    viewer.setLight({ [key]: value });
  };

  return (
    <Panel
      icon="☀"
      title={title}
      defaultCollapsed={defaultCollapsed}
      className={className}
      style={{ top: 'auto', right: 'auto', bottom: 16, left: 16, width: 214 }}
    >
      <div className="vtg-sliders">
        {KNOBS.map((k) => (
          <label key={k.key} className="vtg-slider">
            <span className="vtg-slider-row">
              <span>{k.label}</span>
              <b>{light[k.key].toFixed(2)}</b>
            </span>
            <input
              type="range"
              min={k.min}
              max={k.max}
              step={k.step}
              value={light[k.key]}
              onChange={(e) => update(k.key, Number(e.target.value))}
            />
          </label>
        ))}
      </div>
    </Panel>
  );
}
