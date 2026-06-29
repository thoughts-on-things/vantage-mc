// <BiomeLayer> — the drop-in interactive biome panel: a legend that toggles the
// biome recolour view, isolates a biome on click, previews on hover, and a
// floating chip that identifies the biome under the cursor. All state lives in
// the engine; this component is the UI over it.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useVantage } from './context.js';
import { Panel } from './Panel.js';
import { cssRgb } from './styles.js';

export interface BiomeLayerProps {
  /** Show the legend panel. Default `true`. */
  legend?: boolean;
  /** Show the hover-to-identify tooltip. Default `true`. */
  hover?: boolean;
  /** Open into the biome layer as soon as a tile loads. Default `false`. */
  defaultEnabled?: boolean;
  /** Start the legend panel collapsed to its header. Default `false`. */
  defaultCollapsed?: boolean;
  /** Key that toggles the layer. Default `'b'`; pass `null` to disable. */
  toggleKey?: string | null;
  /** Panel heading. Default `'biomes'`. */
  title?: string;
  className?: string;
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA';
}

export function BiomeLayer({
  legend = true,
  hover = true,
  defaultEnabled = false,
  defaultCollapsed = false,
  toggleKey = 'b',
  title = 'biomes',
  className,
}: BiomeLayerProps) {
  const { viewer, biomes, biomeLayerEnabled, highlightedBiome, hoveredBiome } = useVantage();
  const [committed, setCommitted] = useState<number | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const appliedDefault = useRef(false);

  const byId = useMemo(() => new Map(biomes.map((b) => [b.id, b])), [biomes]);

  // Open into the biome layer once, after the first tile loads.
  useEffect(() => {
    if (defaultEnabled && viewer && biomes.length > 0 && !appliedDefault.current) {
      appliedDefault.current = true;
      viewer.setBiomeLayer(true);
    }
  }, [defaultEnabled, viewer, biomes.length]);

  // Reset the local selection whenever the engine turns the layer off.
  useEffect(() => {
    if (!biomeLayerEnabled) setCommitted(null);
  }, [biomeLayerEnabled]);

  // Keyboard toggle.
  useEffect(() => {
    if (!viewer || !toggleKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.key.toLowerCase() === toggleKey.toLowerCase()) viewer.toggleBiomeLayer();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewer, toggleKey]);

  // Follow the cursor with the tooltip without re-rendering on every move.
  useEffect(() => {
    if (!hover) return;
    const onMove = (e: PointerEvent) => {
      const el = tipRef.current;
      if (el) {
        el.style.left = `${e.clientX + 14}px`;
        el.style.top = `${e.clientY + 14}px`;
      }
    };
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, [hover]);

  if (!viewer || biomes.length === 0) return null;

  const selectRow = (id: number) => {
    const next = committed === id ? null : id; // click the selected biome again to clear
    setCommitted(next);
    viewer.setHighlightedBiome(next); // enables the layer if it was off
  };
  const previewRow = (id: number) => {
    if (biomeLayerEnabled) viewer.setHighlightedBiome(id);
  };
  const endPreview = () => {
    if (biomeLayerEnabled) viewer.setHighlightedBiome(committed);
  };

  const hovered = hoveredBiome != null ? byId.get(hoveredBiome) : undefined;

  return (
    <>
      {legend && (
        <Panel
          icon="▦"
          title={title}
          defaultCollapsed={defaultCollapsed}
          className={className}
          headerExtra={
            <button
              type="button"
              className={biomeLayerEnabled ? 'vtg-toggle vtg-on' : 'vtg-toggle'}
              onClick={() => viewer.toggleBiomeLayer()}
              title={`Toggle biome view${toggleKey ? ` (${toggleKey.toUpperCase()})` : ''}`}
            >
              {biomeLayerEnabled ? 'on' : 'off'}
            </button>
          }
        >
          <div className="vtg-legend">
            {biomes.map((b) => {
              const sel = biomeLayerEnabled && committed === b.id;
              const dim = biomeLayerEnabled && highlightedBiome != null && highlightedBiome !== b.id;
              const onMesh = hoveredBiome === b.id;
              return (
                <div
                  key={b.id}
                  className={['vtg-row', sel && 'vtg-sel', dim && 'vtg-dim', onMesh && 'vtg-hover'].filter(Boolean).join(' ')}
                  onClick={() => selectRow(b.id)}
                  onMouseEnter={() => previewRow(b.id)}
                  onMouseLeave={endPreview}
                >
                  <span className="vtg-chip" style={{ background: cssRgb(b.color) }} />
                  <span className="vtg-name">{b.label}</span>
                  <span className="vtg-pct">{Math.round(b.fraction * 100)}%</span>
                </div>
              );
            })}
          </div>
        </Panel>
      )}

      {hover && (
        <div ref={tipRef} className="vtg-tip" style={{ display: hovered ? 'flex' : 'none' }}>
          <span className="vtg-chip" style={{ background: hovered ? cssRgb(hovered.color) : 'transparent' }} />
          {hovered?.label ?? '—'}
        </div>
      )}
    </>
  );
}
