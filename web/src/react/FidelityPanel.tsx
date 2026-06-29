// <FidelityPanel> — drop-in controls for the live display fidelity: how crisp,
// punchy, and hazy the render looks. Each slider drives the engine's setDisplay()
// (shader uniforms + render scale, no re-bake), the reference UI for the tunable
// "make it crispy" dials. Pairs with <LightPanel> (lighting) — same pattern.

import { useEffect, useState } from 'react';
import { useVantage } from './context.js';
import { CINEMATIC_DISPLAY, DISPLAY_PRESETS } from '../three/index.js';
import type { DisplaySettings, RenderMode } from '../three/index.js';

export interface FidelityPanelProps {
  /** Panel heading. Default `'fidelity'`. */
  title?: string;
  className?: string;
}

/** The numeric (slider-driven) display keys — excludes the `tonemap` enum, which
 *  the mode toggle sets, not a slider. */
type NumKey = Exclude<keyof DisplaySettings, 'tonemap'>;

interface Knob {
  key: NumKey;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Suffix shown after the value (e.g. `×` for render scale). */
  suffix?: string;
}

const KNOBS: Knob[] = [
  { key: 'gtao', label: 'contact shadows', min: 0, max: 1.5, step: 0.05 },
  { key: 'aoRadius', label: 'shadow radius', min: 0.5, max: 6, step: 0.5 },
  { key: 'bloom', label: 'bloom', min: 0, max: 1.2, step: 0.05 },
  { key: 'toneExposure', label: 'tone exposure', min: 0.4, max: 2, step: 0.05 },
  { key: 'sharpness', label: 'sharpness', min: 0, max: 3, step: 0.05 },
  { key: 'ao', label: 'baked AO', min: 0, max: 2, step: 0.05 },
  { key: 'saturation', label: 'saturation', min: 0, max: 2, step: 0.05 },
  { key: 'contrast', label: 'contrast', min: 0.5, max: 1.6, step: 0.02 },
  { key: 'fog', label: 'haze', min: 0, max: 1.5, step: 0.05 },
  { key: 'renderScale', label: 'render scale', min: 0.5, max: 2, step: 0.25, suffix: '×' },
];

const DEFAULTS: Required<DisplaySettings> = CINEMATIC_DISPLAY;

const MODES: { id: RenderMode; label: string }[] = [
  { id: 'vanilla', label: 'vanilla' },
  { id: 'cinematic', label: 'fidelity' },
];

export function FidelityPanel({ title = 'fidelity', className }: FidelityPanelProps) {
  const { viewer } = useVantage();
  const [display, setDisplay] = useState<Required<DisplaySettings>>(DEFAULTS);
  const [mode, setMode] = useState<RenderMode>('cinematic');

  // Seed the sliders from the engine's current settings once it exists.
  useEffect(() => {
    if (viewer) setDisplay(viewer.displaySettings);
  }, [viewer]);

  if (!viewer) return null;

  const update = (key: NumKey, value: number) => {
    setDisplay((p) => ({ ...p, [key]: value }));
    viewer.setDisplay({ [key]: value });
  };

  // Switching mode applies the whole preset (tone curve, GTAO, bloom, grade) and
  // reseeds the sliders so they reflect the new look; tweak from there.
  const applyMode = (m: RenderMode) => {
    setMode(m);
    const preset = DISPLAY_PRESETS[m];
    setDisplay(preset);
    viewer.setDisplay(preset);
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
        <div className="vtg-seg" role="group" aria-label="render mode">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={mode === m.id ? 'vtg-seg-on' : ''}
              onClick={() => applyMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
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
