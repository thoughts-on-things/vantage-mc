// <LightPanel> — a drop-in control panel for the live lighting appearance. Each
// slider drives the engine's setLight() (no re-bake), so this is the reference
// UI for the configurable lighting: daylight, ambient floor, and exposure.

import { useEffect, useState } from 'react';
import { useVantage } from './context.js';
import type { LightSettings } from '../three/index.js';

export interface LightPanelProps {
  /** Panel heading. Default `'lighting'`. */
  title?: string;
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

export function LightPanel({ title = 'lighting', className }: LightPanelProps) {
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
    <div
      className={className ? `vtg-panel vtg-glass ${className}` : 'vtg-panel vtg-glass'}
      style={{ top: 'auto', right: 'auto', bottom: 14, left: 14, width: 210 }}
    >
      <header>
        <span className="vtg-sw">
          ☀ <b>{title}</b>
        </span>
      </header>
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
    </div>
  );
}
