import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Compass,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plug,
  Plus,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { HostEntry, HostProbe } from '../bridge.js';
import type { HostsController } from '../hooks/useHosts.js';
import type { LibraryController } from '../hooks/useLibrary.js';
import { renderAge } from '../lib/format.js';

/**
 * Servers this copy of Vantage can stream a map from.
 *
 * A server is not a save on this PC: there is nothing to render, nothing to
 * cache, and nothing to delete but the connection itself. The host has already
 * baked the tiles, and opening one streams them straight into the viewer.
 */
export function ServersScreen({ hosts, library }: { hosts: HostsController; library: LibraryController }) {
  const [editing, setEditing] = useState<HostEntry | 'new' | null>(null);
  const busyId = library.action?.kind === 'opening' ? library.action.path : null;
  const locked = Boolean(library.action);
  const error = hosts.error ?? library.error;

  return (
    <main className="library servers">
      <header className="library-header">
        <div>
          <p className="eyebrow">Multiplayer</p>
          <h1>Servers</h1>
          <p>Stream a map from a server running <code>vantage server</code>. The terrain arrives as you look at it — nothing is downloaded to this PC.</p>
        </div>
        <div className="header-actions">
          <button
            className="primary-button"
            onClick={() => setEditing((current) => (current === 'new' ? null : 'new'))}
            disabled={locked}
          >
            <Plus size={16} /> Add a server
          </button>
        </div>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <span>Couldn&apos;t complete that action</span>
          <p>{error}</p>
          <button
            onClick={() => {
              hosts.dismissError();
              library.dismissError();
            }}
            aria-label="Dismiss error"
          >
            <X size={15} />
          </button>
        </div>
      )}

      {editing === 'new' && (
        <ServerForm hosts={hosts} onDone={() => setEditing(null)} />
      )}

      {hosts.loading && !hosts.hosts.length ? (
        <p className="renders-loading" role="status"><LoaderCircle className="spin" size={16} /> Loading saved servers…</p>
      ) : hosts.hosts.length ? (
        <ul className="server-list">
          {hosts.hosts.map((entry) =>
            editing !== 'new' && editing?.id === entry.id ? (
              <li key={entry.id} className="server-row editing">
                <ServerForm hosts={hosts} entry={entry} onDone={() => setEditing(null)} />
              </li>
            ) : (
              <ServerRow
                key={entry.id}
                entry={entry}
                busy={busyId === entry.id}
                locked={locked}
                onConnect={() => void library.openHost(entry)}
                onEdit={() => setEditing(entry)}
                onRemove={() => void hosts.remove(entry.id)}
              />
            ),
          )}
        </ul>
      ) : (
        editing !== 'new' && (
          <div className="empty-library">
            <Plug size={28} />
            <h3>No servers yet</h3>
            <p>
              Add the map address your server admin gave you. It looks like <code>https://map.example.net</code>,
              or <code>127.0.0.1:8268</code> for a sidecar on this machine.
            </p>
          </div>
        )
      )}
    </main>
  );
}

function ServerRow({ entry, busy, locked, onConnect, onEdit, onRemove }: {
  entry: HostEntry;
  busy: boolean;
  locked: boolean;
  onConnect: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <li className={`server-row${busy ? ' busy' : ''}`}>
      <div className="server-mark" aria-hidden="true"><Plug size={19} /></div>
      <div className="server-copy">
        <h3>{entry.label}</h3>
        <p className="server-endpoint" title={entry.endpoint}>{entry.endpoint}</p>
        <div className="render-tags">
          {entry.worldId !== 'default' && <span className="tag">world {entry.worldId}</span>}
          <span className="tag">{entry.hasToken ? <><KeyRound size={12} /> access token saved</> : 'no token'}</span>
          {entry.lastConnectedMs !== null && <span className="tag">connected {renderAge(entry.lastConnectedMs)}</span>}
        </div>
      </div>
      {confirming ? (
        <div className="render-confirm" role="group" aria-label={`Confirm removing ${entry.label}`}>
          <p>Remove this connection{entry.hasToken ? ' and its saved token' : ''}?</p>
          <span>
            <button onClick={() => setConfirming(false)}>Keep</button>
            <button className="danger" onClick={onRemove}>Remove</button>
          </span>
        </div>
      ) : (
        <div className="render-actions">
          <button className="ghost-button" onClick={onConnect} disabled={locked} aria-label={`Connect to ${entry.label}`}>
            {busy ? <LoaderCircle className="spin" size={15} /> : <Compass size={15} />} Connect
          </button>
          <button className="ghost-button" onClick={onEdit} disabled={locked} aria-label={`Edit ${entry.label}`}>
            <Pencil size={15} /> Edit
          </button>
          <button className="ghost-button danger" onClick={() => setConfirming(true)} disabled={locked} aria-label={`Remove ${entry.label}`}>
            <Trash2 size={15} /> Remove
          </button>
        </div>
      )}
    </li>
  );
}

/** Add or edit one connection, with a test that says what actually answered. */
function ServerForm({ hosts, entry, onDone }: {
  hosts: HostsController;
  entry?: HostEntry;
  onDone: () => void;
}) {
  const [endpoint, setEndpoint] = useState(entry?.endpoint ?? '');
  const [token, setToken] = useState('');
  const [label, setLabel] = useState(entry?.label ?? '');
  const [worldId, setWorldId] = useState(entry?.worldId ?? 'default');
  const [forgetToken, setForgetToken] = useState(false);
  const [probe, setProbe] = useState<HostProbe | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const addressRef = useRef<HTMLInputElement>(null);

  useEffect(() => addressRef.current?.focus(), []);
  // A probe result describes one address answering for one credential, so
  // editing either retires it: an "unauthorized" verdict left standing under a
  // freshly typed token would be describing the previous one.
  useEffect(() => setProbe(null), [endpoint, token]);

  const test = useCallback(async () => {
    setTesting(true);
    try {
      const result = await hosts.probe(endpoint, token || undefined);
      setProbe(result);
      // A server that named exactly one world has answered the question the
      // world field was going to ask.
      if (result?.worlds.length === 1) setWorldId(result.worlds[0]!);
    } finally {
      setTesting(false);
    }
  }, [endpoint, hosts, token]);

  const submit = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const saved = await hosts.save({
        ...(entry ? { id: entry.id } : {}),
        label,
        endpoint,
        worldId,
        ...(token ? { token } : {}),
        ...(forgetToken ? { forgetToken: true } : {}),
      });
      if (saved) onDone();
    } finally {
      setSaving(false);
    }
  }, [endpoint, entry, forgetToken, hosts, label, onDone, token, worldId]);

  const busy = testing || saving;

  return (
    <form className="server-form" onSubmit={(event) => void submit(event)}>
      <div className="server-fields">
        <label>
          <span>Map address</span>
          <input
            ref={addressRef}
            type="text"
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
            placeholder="map.example.net"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            required
          />
          <small>A plain host gets https; a loopback or LAN address gets http, because the sidecar terminates no TLS of its own.</small>
        </label>
        <label>
          <span>Access token <em>optional</em></span>
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={entry?.hasToken ? 'Saved token kept' : 'Only if your server needs one'}
            autoComplete="off"
            spellCheck={false}
            disabled={forgetToken}
          />
          <small>Stored on this PC and sent only to this server. It stays in the native app and never reaches the map page.</small>
        </label>
        <label>
          <span>Display name <em>optional</em></span>
          <input
            type="text"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Defaults to the host name"
          />
        </label>
        {probe && probe.worlds.length > 1 ? (
          <label>
            <span>World</span>
            <select value={worldId} onChange={(event) => setWorldId(event.target.value)}>
              {probe.worlds.map((world) => <option key={world} value={world}>{world}</option>)}
            </select>
          </label>
        ) : (
          worldId !== 'default' && (
            <label>
              <span>World</span>
              <input type="text" value={worldId} onChange={(event) => setWorldId(event.target.value)} spellCheck={false} />
            </label>
          )
        )}
      </div>

      {entry?.hasToken && (
        <label className="server-forget">
          <input type="checkbox" checked={forgetToken} onChange={(event) => setForgetToken(event.target.checked)} />
          <span>Forget the saved access token</span>
        </label>
      )}

      {probe && <ProbeVerdict probe={probe} />}

      <div className="server-form-actions">
        <button type="button" className="ghost-button" onClick={() => void test()} disabled={busy || !endpoint.trim()}>
          {testing ? <LoaderCircle className="spin" size={15} /> : <Plug size={15} />} Test connection
        </button>
        <span className="spacer" />
        <button type="button" className="ghost-button" onClick={onDone} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy || !endpoint.trim()}>
          {saving ? <LoaderCircle className="spin" size={15} /> : null} {entry ? 'Save changes' : 'Add server'}
        </button>
      </div>
    </form>
  );
}

/** What the test found, in the terms a server admin would have used. */
function ProbeVerdict({ probe }: { probe: HostProbe }) {
  if (probe.unauthorized) {
    return (
      <p className="probe-verdict warn" role="status">
        <TriangleAlert size={15} />
        <span>
          <b>That server needs a different access token.</b>
          <small>{probe.endpoint} answered, but refused the credential offered.</small>
        </span>
      </p>
    );
  }
  const worlds = probe.worlds.length
    ? `${probe.worlds.length} world${probe.worlds.length === 1 ? '' : 's'}: ${probe.worlds.join(', ')}`
    : 'no worlds listed';
  return (
    <p className={`probe-verdict${probe.note ? ' warn' : ' ok'}`} role="status">
      {probe.note ? <TriangleAlert size={15} /> : <ShieldCheck size={15} />}
      <span>
        <b>
          {probe.protocol !== null ? `Vantage protocol ${probe.protocol}` : 'Answered'}
          {probe.auth ? ` · ${probe.auth} auth` : ''} · {worlds}
        </b>
        <small>{probe.note ?? probe.endpoint}</small>
      </span>
    </p>
  );
}
