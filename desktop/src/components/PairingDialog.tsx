import { useEffect, useRef, useState } from 'react';
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { KeyRound, LoaderCircle, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import { getPairingInfo, pairHost, type PairingInfo } from '../bridge.js';
import type { HostsController } from '../hooks/useHosts.js';
import type { LibraryController } from '../hooks/useLibrary.js';
import { userFacingError } from '../lib/format.js';
import {
  LatestWhileBusy,
  PairingUrlDeduper,
  parsePairingUrl,
  type PairingIntent,
} from '../lib/pairing.js';

type Prompt = { intent: PairingIntent | null; error: string | null };

/** Confirmation boundary for browser-initiated pairing. A page can launch the
 * custom scheme, but it cannot make Vantage redeem the code or save a server
 * until the player approves the discovered name and endpoint shown here. */
export function PairingDialog({ hosts, library }: { hosts: HostsController; library: LibraryController }) {
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [info, setInfo] = useState<PairingInfo | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const seen = useRef(new PairingUrlDeduper());
  const requests = useRef(new LatestWhileBusy<Prompt>());
  const sequence = useRef(0);

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    const accept = (urls: string[]) => {
      for (const raw of urls) {
        if (!seen.current.accept(raw)) continue;
        let next: Prompt;
        try {
          next = { intent: parsePairingUrl(raw), error: null };
        } catch (reason) {
          next = { intent: null, error: userFacingError(reason) };
        }
        const visible = requests.current.offer(next);
        if (!visible) continue;
        sequence.current += 1;
        setBusy(false);
        setInspecting(false);
        setInfo(null);
        setPrompt(visible);
      }
    };
    void (async () => {
      // Listen first, then read the cold-start value so a link arriving between
      // the two cannot be lost. `seen` removes the harmless overlap.
      const stop = await onOpenUrl((urls) => active && accept(urls));
      if (!active) {
        stop();
        return;
      }
      unlisten = stop;
      const initial = await getCurrent();
      if (active && initial) accept(initial);
    })().catch((reason) => {
      if (active) setPrompt({ intent: null, error: userFacingError(reason) });
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const inspect = async () => {
    if (!prompt?.intent) return;
    const request = sequence.current;
    setInspecting(true);
    try {
      const value = await getPairingInfo(prompt.intent.endpoint);
      if (request === sequence.current) setInfo(value);
    } catch (reason) {
      if (request === sequence.current) {
        setPrompt({ intent: prompt.intent, error: userFacingError(reason) });
      }
    } finally {
      if (request === sequence.current) setInspecting(false);
    }
  };

  const dismiss = () => {
    sequence.current += 1;
    setPrompt(null);
    setInfo(null);
  };

  if (!prompt) return null;

  const confirm = async () => {
    if (!prompt.intent || !info) return;
    const request = sequence.current;
    requests.current.start();
    setBusy(true);
    try {
      const platform = navigator.platform?.trim();
      const entry = await pairHost(
        prompt.intent.endpoint,
        prompt.intent.code,
        platform ? `Vantage Desktop on ${platform}` : 'Vantage Desktop',
      );
      await hosts.refresh();
      if (request === sequence.current) {
        setPrompt(null);
        await library.openHost(entry);
      }
    } catch (reason) {
      if (request === sequence.current) {
        setPrompt({ intent: prompt.intent, error: userFacingError(reason) });
      }
    } finally {
      const next = requests.current.finish();
      if (next) {
        sequence.current += 1;
        setInfo(null);
        setInspecting(false);
        setPrompt(next);
        setBusy(false);
      } else if (request === sequence.current) {
        setBusy(false);
      }
    }
  };

  return (
    <div className="pairing-layer" role="presentation">
      <section className="pairing-dialog" role="dialog" aria-modal="true" aria-labelledby="pairing-title">
        <button className="pairing-close" onClick={dismiss} disabled={busy} aria-label="Cancel pairing">
          <X size={16} />
        </button>
        <span className="pairing-icon"><KeyRound size={22} /></span>
        <p className="eyebrow">Server pairing</p>
        <h1 id="pairing-title">
          {info ? `Connect to ${info.name}?` : 'Verify this Vantage server?'}
        </h1>
        {prompt.intent ? (
          <>
            <code className="pairing-endpoint">{info?.endpoint ?? prompt.intent.endpoint}</code>
            <p className="pairing-copy">
              Vantage will exchange a one-time code with this server, save its map-only access token, and open every dimension it streams.
            </p>
            <p className="pairing-safe"><ShieldCheck size={15} /> The browser link does not contain the access token.</p>
          </>
        ) : null}
        {prompt.error ? (
          <p className="pairing-error" role="alert"><TriangleAlert size={15} /> {prompt.error}</p>
        ) : null}
        <div className="pairing-actions">
          <button onClick={dismiss} disabled={busy}>Cancel</button>
          {prompt.intent ? (
            <button
              className="primary-button"
              onClick={() => void (info ? confirm() : inspect())}
              disabled={busy || inspecting}
            >
              {busy || inspecting ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}
              {busy ? 'Connecting…' : inspecting ? 'Verifying…' : info ? 'Connect and open' : 'Verify server'}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
