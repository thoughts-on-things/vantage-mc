import { memo, type CSSProperties } from 'react';
import { Check, History, LoaderCircle, Play, SlidersHorizontal } from 'lucide-react';
import type { WorldInfo } from '../bridge.js';
import { loadViewer } from '../hooks/useLibrary.js';
import { relativeTime, sourceLabel, worldActionLabel, type WorldActionKind } from '../lib/format.js';
import { renderState, RENDER_STATE_COPY } from '../lib/library.js';
import type { DesktopSettings } from '../settings.js';

export const WorldCard = memo(function WorldCard({ world, index, settings, selected, busy, locked, onSelect, onOpen }: {
  world: WorldInfo;
  index: number;
  settings: DesktopSettings;
  selected: boolean;
  busy: WorldActionKind | null;
  locked: boolean;
  onSelect: (path: string) => void;
  onOpen: (world: WorldInfo) => void;
}) {
  const state = renderState(world, settings);
  return (
    <article
      className={`world-card world-tone-${index % 4}${selected ? ' selected' : ''}${busy ? ' busy' : ''}${locked ? ' locked' : ''}`}
      style={{ '--card-index': Math.min(index, 12) } as CSSProperties}
      role="button"
      tabIndex={locked ? -1 : 0}
      aria-pressed={selected}
      aria-disabled={locked}
      aria-label={`${world.name}, ${world.cached ? 'render ready' : 'not rendered'}`}
      data-world-index={index}
      onClick={() => { if (!locked) onSelect(world.path); }}
      onDoubleClick={() => { if (!locked) onOpen(world); }}
      onPointerEnter={() => { if (world.cached) void loadViewer(); }}
      onFocus={() => { if (!locked) onSelect(world.path); if (world.cached) void loadViewer(); }}
      onKeyDown={(event) => {
        if (locked) return;
        if (event.key === 'Enter') onOpen(world);
        if (event.key === ' ') {
          event.preventDefault();
          onSelect(world.path);
        }
      }}
    >
      <div className="world-art">
        <WorldArt world={world} />
        <div className="world-art-shade" />
        {state === 'ready' && <span className="ready-badge"><Check size={12} /> rendered</span>}
        {state === 'outdated' && <span className="ready-badge stale"><History size={12} /> played since</span>}
        {state === 'settings' && <span className="ready-badge stale"><SlidersHorizontal size={12} /> settings changed</span>}
        {!world.thumbnailUrl && !busy && (
          <span className="thumbnail-state">
            {world.iconUrl ? 'Minecraft icon · open for preview' : world.cached ? 'Open for real preview' : 'Preview after render'}
          </span>
        )}
        {busy && <div className="card-busy" role="status"><LoaderCircle className="spin" size={16} /><span>{worldActionLabel(busy)}</span></div>}
        <button
          className="card-open"
          disabled={locked}
          onClick={(event) => { event.stopPropagation(); if (!locked) onOpen(world); }}
          aria-label={`${busy ? worldActionLabel(busy) : 'Open'} ${world.name}`}
          title={RENDER_STATE_COPY[state].detail}
        >
          {busy ? <LoaderCircle className="spin" size={16} /> : <Play size={16} fill="currentColor" />}
        </button>
      </div>
      <div className="world-card-copy">
        <div><h3>{world.name}</h3><p>{relativeTime(world.lastPlayedMs)}</p></div>
        <span className="source-chip">{sourceLabel(world.source)}</span>
      </div>
    </article>
  );
});

export function WorldArt({ world }: { world: WorldInfo }) {
  if (world.thumbnailUrl) return <img className="render-thumbnail" src={world.thumbnailUrl} alt="" />;
  if (world.iconUrl) return <img className="world-icon" src={world.iconUrl} alt="" />;
  return <GeneratedWorldArt seed={world.name} />;
}

function GeneratedWorldArt({ seed }: { seed: string }) {
  const hue = [...seed].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 80;
  return (
    <div className="generated-art" style={{ '--world-hue': `${hue}` } as CSSProperties}>
      <i className="sun" /><i className="mountain far" /><i className="mountain near" /><i className="ground" />
    </div>
  );
}

export function WorldSkeleton() {
  return <div className="world-card skeleton"><div className="world-art" /><div className="world-card-copy"><div><i /><i /></div></div></div>;
}
