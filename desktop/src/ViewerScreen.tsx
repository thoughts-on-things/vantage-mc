import { useEffect, useMemo, useRef } from 'react';
import { ArrowLeft } from 'lucide-react';
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
import { saveWorldThumbnail, type SystemProfile, type WorldInfo } from './bridge.js';
import { compactNumber, sourceLabel } from './lib/format.js';
import { selectRenderProfile, type RenderProfile } from './lib/renderProfile.js';
import type { DesktopSettings } from './settings.js';

export default function ViewerScreen({ world, manifestUrl, settings, system, hasThumbnail, onThumbnail, onBack }: {
  world: WorldInfo;
  manifestUrl: string;
  settings: DesktopSettings;
  system: SystemProfile;
  hasThumbnail: boolean;
  onThumbnail: (dataUrl: string) => void;
  onBack: () => void;
}) {
  const profile = useMemo(() => selectRenderProfile(settings.performanceMode, system.logicalCores), [settings.performanceMode, system.logicalCores]);

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
        <ThumbnailCapture worldPath={world.path} hasThumbnail={hasThumbnail} onThumbnail={onThumbnail} />
        <Reticle />
        <DepthSlider />
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

function ThumbnailCapture({ worldPath, hasThumbnail, onThumbnail }: {
  worldPath: string;
  hasThumbnail: boolean;
  onThumbnail: (dataUrl: string) => void;
}) {
  const { viewer } = useVantage();
  const attemptedPath = useRef<string | null>(null);
  const onThumbnailRef = useRef(onThumbnail);
  onThumbnailRef.current = onThumbnail;

  useEffect(() => {
    if (hasThumbnail || !viewer || attemptedPath.current === worldPath) return;
    let cancelled = false;
    let frame = 0;
    let timer = 0;

    const capture = () => {
      attemptedPath.current = worldPath;
      frame = requestAnimationFrame(() => {
        void (async () => {
          try {
            viewer.screenshot(); // forces a current canvas frame under render-on-demand
            const dataUrl = thumbnailFromCanvas(viewer.renderer.domElement);
            await saveWorldThumbnail(worldPath, dataUrl);
            if (!cancelled) onThumbnailRef.current(dataUrl);
          } catch (reason) {
            console.warn('Vantage could not create this world thumbnail:', reason);
          }
        })();
      });
    };

    // Wait for the initial resident tile set to finish streaming. Capturing on
    // the first non-zero triangle count can produce a sparse, misleading image.
    const stopListening = viewer.on('stats', (stats) => {
      window.clearTimeout(timer);
      if (stats.loaded <= 0 || stats.loading > 0 || stats.triangleCount <= 0) return;
      timer = window.setTimeout(capture, 650);
    });

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (frame) cancelAnimationFrame(frame);
      stopListening();
    };
  }, [hasThumbnail, viewer, worldPath]);

  return null;
}

function thumbnailFromCanvas(source: HTMLCanvasElement): string {
  const width = 480;
  const height = 320;
  const target = document.createElement('canvas');
  target.width = width;
  target.height = height;
  const context = target.getContext('2d');
  if (!context || source.width <= 0 || source.height <= 0) throw new Error('Viewer canvas is not ready');

  const targetAspect = width / height;
  const sourceAspect = source.width / source.height;
  let sx = 0;
  let sy = 0;
  let sw = source.width;
  let sh = source.height;
  if (sourceAspect > targetAspect) {
    sw = source.height * targetAspect;
    sx = (source.width - sw) / 2;
  } else {
    sh = source.width / targetAspect;
    sy = (source.height - sh) / 2;
  }
  context.drawImage(source, sx, sy, sw, sh, 0, 0, width, height);
  return target.toDataURL('image/png');
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
  const { status, info, viewer } = useVantage();
  const triangles = info ? compactNumber(info.triangleCount) : '—';
  const caves = Boolean(info && viewer?.hasCaves);
  return (
    <div className="viewer-status glass-panel" aria-live="polite">
      <span className={status === 'ready' ? 'live-dot' : 'live-dot pending'} />
      <b>{status === 'ready' ? 'GPU view ready' : 'Streaming terrain'}</b>
      <small>{triangles} tris · {profile.name} · {caves ? 'cave-ready' : 'surface'}</small>
      <span className="control-hint">drag pan · right-drag orbit · C caves · scroll zoom</span>
    </div>
  );
}
