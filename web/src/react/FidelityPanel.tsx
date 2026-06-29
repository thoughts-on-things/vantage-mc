// <FidelityPanel> — drop-in controls for the live display fidelity: how crisp,
// punchy, and hazy the render looks. Each slider drives the engine's setDisplay()
// (shader uniforms + render scale, no re-bake), the reference UI for the tunable
// "make it crispy" dials. Pairs with <LightPanel> (lighting) — same pattern.

import { useEffect, useState } from 'react';
import { useVantage } from './context.js';
import type { DisplaySettings } from '../three/index.js';

export interface FidelityPanelProps {
  /** Panel heading. Default `'fidelity'`. */
  title?: string;
  className?: string;
}

interface Knob {
  key: keyof DisplaySettings;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Suffix shown after the value (e.g. `×` for render scale). */
  suffix?: string;
}

const KNOBS: Knob[] = [
  { key: 'sharpness', label: 'sharpness', min: 0, max: 3, step: 0.05 },
  { key: 'ao', label: 'ambient occlusion', min: 0, max: 2, step: 0.05 },
  { key: 'saturation', label: 'saturation', min: 0, max: 2, step: 0.05 },
  { key: 'contrast', label: 'contrast', min: 0.5, max: 1.6, step: 0.02 },
  { key: 'fog', label: 'haze', min: 0, max: 1.5, step: 0.05 },
  { key: 'renderScale', label: 'render scale', min: 0.5, max: 2, step: 0.25, suffix: '×' },
];

export function FidelityPanel({ title = 'fidelity', className }: FidelityPanelProps) {
  const { viewer } = useVantage();
  const [display, setDisplay] = useState<Required<DisplaySettings>>({
    sharpness: 0,
    ao: 1,
    saturation: 1,
    contrast: 1,
    fog: 1,
    renderScale: 1,
  });

  // Seed the sliders from the engine's current settings once it exists.
  useEffect(() => {
    if (viewer) setDisplay(viewer.displaySettings);
  }, [viewer]);

  if (!viewer) return null;

  const update = (key: keyof DisplaySettings, value: number) => {
    setDisplay((p) => ({ ...p, [key]: value }));
    viewer.setDisplay({ [key]: value });
  };

  return (
    <div
      className={className ? `vtg-panel vtg-glass ${className}` : 'vtg-panel vtg-glass'}
      style={{ top: 'auto', right: 14, bottom: 14, width: 226 }}
    >
      <header>
        <span className="vtg-sw">
          ◆ <b>{title}</b>
        </span>
      </header>
      <div className="vtg-sliders">
        {KNOBS.map((k) => (
          <label key={k.key} className="vtg-slider">
            <span className="vtg-slider-row">
              <span>{k.label}</span>
              <b>
                {display[k.key].toFixed(2)}
                {k.suffix ?? ''}
              </b>
            </span>
            <input
              type="range"
              min={k.min}
              max={k.max}
              step={k.step}
              value={display[k.key]}
              onChange={(e) => update(k.key, Number(e.target.value))}
            />
          </label>
        ))}
      </div>
    </div>
  );
}
