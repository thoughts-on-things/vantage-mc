import { useEffect, useMemo } from 'react';
import { ArrowLeft } from 'lucide-react';
import {
  BiomeLayer,
  LightPanel,
  MapNav,
  Reticle,
  SettingsPanel,
  useVantage,
  VantageViewer,
  type DisplaySettings,
  type StreamingSettings,
} from 'vantage-mc/react';
import type { WorldInfo } from './bridge.js';

interface RenderProfile {
  name: 'efficient' | 'balanced' | 'high';
  maxPixelRatio: number;
  streaming: Required<StreamingSettings>;
  display: DisplaySettings;
}

export default function ViewerScreen({ world, manifestUrl, onBack }: {
  world: WorldInfo;
  manifestUrl: string;
  onBack: () => void;
}) {
  const profile = useMemo(selectRenderProfile, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select')) return;
      onBack();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onBack]);

  return (
    <div className="viewer-screen">
      <VantageViewer
        world={manifestUrl}
        view="orbit"
        urlState={false}
        antialias
        renderOnDemand
        maxPixelRatio={profile.maxPixelRatio}
        streaming={profile.streaming}
        display={profile.display}
        className="desktop-viewer"
        loading={<ViewerLoader worldName={world.name} profile={profile.name} />}
      >
        <Reticle />
        <BiomeLayer legend hover />
        <LightPanel />
        <SettingsPanel />
        <MapNav />
        <ViewerTelemetry profile={profile} />
      </VantageViewer>
      <div className="viewer-toolbar glass-panel">
        <button className="toolbar-back" onClick={onBack} aria-label="Return to world library">
          <ArrowLeft size={17} /> Library <kbd>Esc</kbd>
        </button>
        <span className="toolbar-rule" />
        <div><strong>{world.name}</strong><small>{sourceLabel(world.source)} · local render</small></div>
      </div>
    </div>
  );
}

function ViewerLoader({ worldName, profile }: { worldName: string; profile: RenderProfile['name'] }) {
  return (
    <div className="viewer-loading" role="status" aria-live="polite">
      <div className="loader-mark" aria-hidden="true"><span /><span /><span /></div>
      <div className="loader-copy"><strong>Opening {worldName}</strong><span>Warming the GPU · {profile} quality</span></div>
      <div className="loader-track"><span /></div>
    </div>
  );
}

function ViewerTelemetry({ profile }: { profile: RenderProfile }) {
  const { status, info } = useVantage();
  const triangles = info ? compactNumber(info.triangleCount) : '—';
  return (
    <div className="viewer-status glass-panel" aria-live="polite">
      <span className={status === 'ready' ? 'live-dot' : 'live-dot pending'} />
      <b>{status === 'ready' ? 'GPU view ready' : 'Streaming terrain'}</b>
      <small>{triangles} tris · {profile.name} · on-demand</small>
      <span className="control-hint">drag pan · right-drag orbit · scroll zoom</span>
    </div>
  );
}

function selectRenderProfile(): RenderProfile {
  const cores = navigator.hardwareConcurrency || 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  const dpr = window.devicePixelRatio || 1;
  const display: DisplaySettings = { sharpness: 0.08, ao: 1.05, saturation: 1.03, contrast: 1.02, fog: 0.92, renderScale: 1 };

  if (cores <= 4 || memory <= 4) {
    return {
      name: 'efficient',
      maxPixelRatio: Math.min(1.35, dpr),
      streaming: { viewDistance: 640, maxTiles: 84, concurrency: Math.max(2, Math.min(4, cores - 1)) },
      display,
    };
  }
  if (cores >= 10 && memory >= 8) {
    return {
      name: 'high',
      maxPixelRatio: Math.min(2, dpr),
      streaming: { viewDistance: 1152, maxTiles: 264, concurrency: Math.min(8, Math.max(5, Math.floor(cores / 2))) },
      display,
    };
  }
  return {
    name: 'balanced',
    maxPixelRatio: Math.min(1.75, dpr),
    streaming: { viewDistance: 768, maxTiles: 120, concurrency: Math.min(6, Math.max(3, Math.floor(cores / 2))) },
    display,
  };
}

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
function compactNumber(value: number): string {
  return compact.format(value);
}

function sourceLabel(source: string): string {
  return ({ vanilla: 'Minecraft', prism: 'Prism', multimc: 'MultiMC', curseforge: 'CurseForge', modrinth: 'Modrinth', gdlauncher: 'GDLauncher' } as Record<string, string>)[source] ?? source;
}
