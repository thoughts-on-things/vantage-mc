import { Cpu, Gauge, Layers3, Moon, Sparkles, X, Zap } from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { SystemProfile } from '../bridge.js';
import { renderThreadCount } from '../lib/renderProfile.js';
import type { DesktopSettings, PerformanceMode } from '../settings.js';

const MODE_LABELS: Record<PerformanceMode, [string, string]> = {
  efficient: ['Efficient', 'Cool & quiet'],
  balanced: ['Balanced', 'Smart limits'],
  maximum: ['Maximum', 'Full CPU'],
};

export function SettingsSheet({ settings, system, onChange, onClose }: {
  settings: DesktopSettings;
  system: SystemProfile;
  onChange: (next: DesktopSettings) => void;
  onClose: () => void;
}) {
  const sheetRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const update = (next: Partial<DesktopSettings>) => onChange({ ...settings, ...next });
  useEffect(() => closeRef.current?.focus(), []);

  const keepFocusInside = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return;
    const controls = sheetRef.current?.querySelectorAll<HTMLElement>('button, input:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (!controls?.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  return (
    <div className="settings-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={sheetRef} className="settings-sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title" onKeyDown={keepFocusInside}>
        <header className="settings-head">
          <div><p className="eyebrow">Desktop engine</p><h2 id="settings-title">Settings</h2></div>
          <button ref={closeRef} className="icon-button" onClick={onClose} aria-label="Close settings"><X size={18} /></button>
        </header>

        <div className="settings-body">
          <section className="settings-group">
            <div className="settings-group-title"><Gauge size={16} /><div><h3>Performance</h3><p>Choose how much of this PC Vantage can use.</p></div></div>
            <div className="mode-picker" role="radiogroup" aria-label="Performance mode">
              {(Object.keys(MODE_LABELS) as PerformanceMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={settings.performanceMode === mode}
                  className={settings.performanceMode === mode ? 'active' : ''}
                  onClick={() => update({ performanceMode: mode })}
                >
                  <b>{MODE_LABELS[mode][0]}</b><small>{MODE_LABELS[mode][1]}</small>
                </button>
              ))}
            </div>
            <div className="host-card">
              <span className="host-icon"><Cpu size={18} /></span>
              <span><b>{system.logicalCores} logical CPU threads detected</b><small>{performanceCopy(settings.performanceMode, system.logicalCores)}</small></span>
              <em>{system.architecture}</em>
            </div>
          </section>

          <section className="settings-group">
            <div className="settings-group-title"><Layers3 size={16} /><div><h3>Render detail</h3><p>Applied the next time a world is rendered.</p></div></div>
            <SettingToggle
              icon={<Moon size={17} />}
              title="Cave-ready geometry"
              copy="Keep the underground mesh so C opens the new depth-slice renderer."
              checked={settings.fullCaves}
              onChange={(fullCaves) => update({ fullCaves })}
            />
            <SettingToggle
              icon={<Sparkles size={17} />}
              title="Smooth block lighting"
              copy="Blend light per vertex for softer terrain and more readable caves."
              checked={settings.smoothLighting}
              onChange={(smoothLighting) => update({ smoothLighting })}
            />
            <SettingToggle
              icon={<Zap size={17} />}
              title="Biome color blending"
              copy="Blend grass, foliage, and water colors across biome boundaries."
              checked={settings.biomeBlend}
              onChange={(biomeBlend) => update({ biomeBlend })}
            />
          </section>
        </div>

        <footer className="settings-foot"><span><i /> Saved automatically on this PC</span><button className="primary-button compact" onClick={onClose}>Done</button></footer>
      </section>
    </div>
  );
}

function SettingToggle({ icon, title, copy, checked, onChange }: {
  icon: ReactNode; title: string; copy: string; checked: boolean; onChange: (checked: boolean) => void;
}) {
  return (
    <label className="setting-row">
      <span className="setting-icon">{icon}</span>
      <span className="setting-copy"><b>{title}</b><small>{copy}</small></span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="switch" aria-hidden="true"><i /></span>
    </label>
  );
}

function performanceCopy(mode: PerformanceMode, cores: number): string {
  if (mode === 'efficient') return `Renders with up to ${renderThreadCount('efficient', cores)} threads.`;
  if (mode === 'maximum') return `Requests all ${cores} threads; RAM safety still applies.`;
  return 'The native memory planner chooses the fastest safe thread count.';
}
