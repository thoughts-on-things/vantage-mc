import { useState } from 'react';
import { Box, ChevronRight, Compass, Cpu, FolderSearch, ImageIcon, LoaderCircle, Sparkles, Trash2 } from 'lucide-react';
import type { RenderProgress, WorldInfo } from '../bridge.js';
import { actionHint, phaseCopy, sourceLabel, type WorldAction, type WorldActionKind } from '../lib/format.js';
import { WorldArt } from './WorldCard.js';

export function WorldDetail({ world, progress, action, cancelling, onOpen, onCancel, onRegenerateThumbnail, onResetRender }: {
  world: WorldInfo | null;
  progress: RenderProgress | null;
  action: WorldAction | null;
  cancelling: boolean;
  onOpen: () => void;
  onCancel: () => void;
  onRegenerateThumbnail: () => void;
  onResetRender: () => void;
}) {
  if (!world) return <aside className="world-detail empty"><Compass size={28} /><p>Select a world to see its details.</p></aside>;

  const activeProgress = progress?.worldPath === world.path && !['done', 'failed'].includes(progress.phase) ? progress : null;
  const actionKind = action?.path === world.path ? action.kind : null;
  const rendering = actionKind === 'rendering';

  return (
    <aside className="world-detail">
      <div className="detail-art"><WorldArt world={world} /><div className="detail-art-fade" /></div>
      <div className="detail-top">
        <span className="detail-kicker">Selected world</span>
        <h2>{world.name}</h2>
        <p className="detail-path">{world.path}</p>
      </div>
      <div className="detail-stats">
        <div><Box size={16} /><span><small>Edition</small><b>Java</b></span></div>
        <div><Cpu size={16} /><span><small>Data version</small><b>{world.dataVersion || 'Unknown'}</b></span></div>
        <div><FolderSearch size={16} /><span><small>Found via</small><b>{sourceLabel(world.source)}</b></span></div>
      </div>
      <div className="detail-note">
        <Sparkles size={16} />
        <p><b>{world.cached ? 'Your render is ready.' : 'Built locally, stays local.'}</b> Vantage reads your save without modifying it.</p>
      </div>
      {actionKind === 'opening' ? (
        <IndeterminateProgress
          title="Opening GPU viewer"
          copy="Loading the cached terrain and warming the renderer."
          className="opening-progress"
        />
      ) : actionKind === 'thumbnail' || actionKind === 'resetting' ? (
        <IndeterminateProgress
          title={actionKind === 'thumbnail' ? 'Preparing a fresh preview' : 'Resetting render cache'}
          copy={actionKind === 'thumbnail'
            ? 'Opening the existing map; the new preview appears after terrain settles.'
            : 'Removing generated files. Your Minecraft save stays untouched.'}
          className="maintenance-progress"
        />
      ) : activeProgress || rendering ? (
        <RenderProgressPanel progress={activeProgress} cancelling={cancelling} onCancel={onCancel} />
      ) : (
        <>
          <button className="primary-button" onClick={onOpen} disabled={Boolean(action)}>
            {world.cached ? <><Compass size={18} /> Explore world</> : <><Sparkles size={18} /> Render this world</>}
            <ChevronRight size={18} />
          </button>
          {world.cached && <RenderTools onRegenerateThumbnail={onRegenerateThumbnail} onResetRender={onResetRender} />}
        </>
      )}
      <p className="shortcut-hint">{actionKind ? actionHint(actionKind) : 'Double-click a rendered world to open it instantly.'}</p>
    </aside>
  );
}

function IndeterminateProgress({ title, copy, className }: { title: string; copy: string; className: string }) {
  return (
    <div className={`render-progress ${className}`} role="status" aria-live="polite">
      <div className="progress-heading"><span><LoaderCircle className="spin" size={17} /> {title}</span></div>
      <div className="progress-track indeterminate"><span /></div>
      <p>{copy}</p>
    </div>
  );
}

function RenderProgressPanel({ progress, cancelling, onCancel }: {
  progress: RenderProgress | null;
  cancelling: boolean;
  onCancel: () => void;
}) {
  const fraction = progress?.phase === 'tiles' && progress.total > 0 ? progress.completed / progress.total : 0.12;
  return (
    <div className="render-progress" role="status" aria-live="polite">
      <div className="progress-heading">
        <span><LoaderCircle className="spin" size={17} /> {cancelling ? 'Stopping safely' : progress ? phaseCopy[progress.phase] : 'Finishing render'}</span>
        {!cancelling && <b>{Math.round(fraction * 100)}%</b>}
      </div>
      <div className="progress-track"><span style={{ width: `${Math.max(4, fraction * 100)}%` }} /></div>
      <p>
        {cancelling
          ? 'Closing workers and leaving the cache in a safe state.'
          : progress?.phase === 'tiles'
            ? `${progress.completed} of ${progress.total} terrain tiles`
            : 'This usually takes only a moment.'}
      </p>
      <button className="cancel-button" onClick={onCancel} disabled={cancelling}>{cancelling ? 'Stopping…' : 'Cancel render'}</button>
    </div>
  );
}

function RenderTools({ onRegenerateThumbnail, onResetRender }: { onRegenerateThumbnail: () => void; onResetRender: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <div className="reset-confirm" role="group" aria-label="Confirm render reset">
        <div><Trash2 size={15} /><p><b>Reset this render?</b><span>The map and preview will be deleted. The original world is never changed.</span></p></div>
        <span><button onClick={() => setConfirming(false)}>Keep render</button><button className="danger" onClick={onResetRender}>Reset render</button></span>
      </div>
    );
  }
  return (
    <div className="render-tools" aria-label="Render maintenance">
      <button onClick={onRegenerateThumbnail}><ImageIcon size={14} /> Regenerate preview</button>
      <button onClick={() => setConfirming(true)}><Trash2 size={14} /> Reset render</button>
    </div>
  );
}
