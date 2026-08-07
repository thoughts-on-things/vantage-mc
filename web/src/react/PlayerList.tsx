// <PlayerList> — who is on the server, and where.
//
// Renders nothing at all unless the loaded world actually serves a roster
// (`players.json`), so it can be dropped into any viewer unconditionally: a
// plain single-player render simply never shows it.
//
// Clicking a player flies the camera to them; the pin button keeps the camera
// with them as they move. Both are just calls into the engine, so a consumer
// that wants its own UI can ignore this component and use `viewer.players`,
// `viewer.focusPlayer` and `viewer.followPlayer` directly.

import { useEffect, useState, type CSSProperties } from 'react';
import { useVantage } from './context.js';
import { Panel } from './Panel.js';
import type { PlayerView } from '../three/index.js';

export interface PlayerListProps {
  /** Panel heading. Default `'players'`. */
  title?: string;
  /** Start collapsed (header only). Default `false` — the roster is the point. */
  defaultCollapsed?: boolean;
  /** Key that shows/hides players on the map. Default `'p'`; `null` disables. */
  toggleKey?: string | null;
  /** Override the panel's placement/size. */
  style?: CSSProperties;
  className?: string;
}

const PIN = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 9.4V14" />
    <path d="M5 2h6l-.8 4.2 2 2.2H3.8l2-2.2z" />
  </svg>
);

const ICON = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="8" cy="5" r="2.6" />
    <path d="M2.8 13.8c0-2.6 2.3-4.2 5.2-4.2s5.2 1.6 5.2 4.2" />
  </svg>
);

/** Distance in blocks, in the compact form a coordinate readout wants. */
function distanceLabel(blocks: number): string {
  if (blocks < 1000) return `${Math.round(blocks)}m`;
  return `${(blocks / 1000).toFixed(1)}km`;
}

/** How long ago a last-known position was recorded. Absent or nonsensical
 *  timestamps just don't get a label. */
function agoLabel(seen: number | undefined): string | null {
  if (!seen || seen <= 0) return null;
  const seconds = (Date.now() - seen) / 1000;
  if (seconds < 0 || seconds > 60 * 60 * 24 * 3650) return null;
  if (seconds < 90) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/** Everything worth saying about a player in one hover. */
function describe(player: PlayerView, ago: string | null): string {
  const parts = [`${player.name} · ${Math.round(player.x)}, ${Math.round(player.y)}, ${Math.round(player.z)}`];
  if (player.foreign && player.dimension) parts.push(player.dimension.split(':').pop()!);
  if (player.gamemode) parts.push(player.gamemode);
  if (player.health !== undefined) parts.push(`${Math.round(player.health * 10) / 10} hp`);
  if (ago) parts.push(`last seen ${ago}`);
  return parts.join(' · ');
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

export function PlayerList({ title = 'players', defaultCollapsed = false, toggleKey = 'p', style, className }: PlayerListProps) {
  const { viewer } = useVantage();
  const [players, setPlayers] = useState<PlayerView[]>([]);
  const [available, setAvailable] = useState(false);
  const [live, setLive] = useState(true);
  const [following, setFollowing] = useState<string | null>(null);
  // The camera keeps moving between roster updates, so distances are re-read
  // on a slow tick of their own rather than per frame — this is a list, not a
  // HUD, and a React commit per frame for it would be absurd.
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!viewer) return;
    setPlayers(viewer.players);
    setFollowing(viewer.followedPlayer);
    const offs = [
      viewer.on('players', (e) => {
        setPlayers(e.players);
        setAvailable(e.available);
      }),
      viewer.on('follow', ({ uuid }) => setFollowing(uuid)),
      // A world reload drops the roster with it.
      viewer.on('load', () => {
        setPlayers([]);
        setAvailable(false);
        setFollowing(null);
      }),
    ];
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      offs.forEach((off) => off());
      clearInterval(timer);
    };
  }, [viewer]);

  // Keyboard toggle, in the same language as `B` for biomes and `C` for caves.
  useEffect(() => {
    if (!viewer || !toggleKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() !== toggleKey.toLowerCase()) return;
      setLive((on) => {
        viewer.setPlayers({ enabled: !on });
        return !on;
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewer, toggleKey]);

  if (!viewer || !available || players.length === 0) return null;

  const focus = viewer.controls.position;
  const rows = players
    .map((p) => ({ p, distance: Math.hypot(p.drawX - focus.x, p.drawZ - focus.z) }))
    .sort((a, b) => Number(a.p.stale) - Number(b.p.stale) || a.distance - b.distance);
  const online = players.filter((p) => !p.stale).length;

  const toggle = () => {
    const next = !live;
    setLive(next);
    viewer.setPlayers({ enabled: next });
  };

  return (
    <Panel
      icon={ICON}
      title={title}
      defaultCollapsed={defaultCollapsed}
      className={className}
      style={{ top: 16, left: 16, right: 'auto', width: 216, ...style }}
      headerExtra={
        <button
          type="button"
          className={`vtg-toggle${live ? ' vtg-on' : ''}`}
          aria-pressed={live}
          title={`${live ? 'Hide' : 'Show'} players on the map${toggleKey ? ` (${toggleKey.toUpperCase()})` : ''}`}
          onClick={toggle}
        >
          {online > 0 ? `${online} on` : `${players.length}`}
        </button>
      }
    >
      <div className="vtg-players">
        {rows.map(({ p, distance }) => {
          const ago = p.stale ? agoLabel(p.seen) : null;
          const icon = viewer.playerIcon(p.uuid);
          const followed = following === p.uuid;
          return (
            <div
              key={p.uuid}
              className={`vtg-row vtg-player${p.stale ? ' vtg-dim' : ''}${followed ? ' vtg-sel' : ''}`}
              role="button"
              tabIndex={0}
              title={describe(p, ago)}
              onClick={() => viewer.focusPlayer(p.uuid)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                viewer.focusPlayer(p.uuid);
              }}
            >
              {icon ? (
                <img className="vtg-face" src={icon} alt="" width={16} height={16} />
              ) : (
                <span className="vtg-face vtg-face-blank" />
              )}
              <span className="vtg-name">{p.name}</span>
              <span className="vtg-pct">{p.foreign ? (p.dimension?.split(':').pop() ?? 'away') : ago ?? distanceLabel(distance)}</span>
              {/* Following a player who isn't on this map has nowhere to go. */}
              {p.visible && (
                <button
                  type="button"
                  className={`vtg-follow${followed ? ' vtg-on' : ''}`}
                  aria-pressed={followed}
                  title={followed ? 'Stop following' : `Follow ${p.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    viewer.followPlayer(followed ? null : p.uuid);
                  }}
                >
                  {PIN}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
