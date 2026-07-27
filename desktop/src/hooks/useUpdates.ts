import { useCallback, useEffect, useRef, useState } from 'react';
import { checkForUpdate, relaunchApp, type AppUpdate } from '../bridge.js';

/** Long enough that a session sees at most a few checks; a fresh check also
 *  runs on every launch, which is when most people meet an update. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdatePhase = 'idle' | 'available' | 'downloading' | 'restarting';

export interface UpdatesController {
  phase: UpdatePhase;
  version: string | null;
  /** Download completion 0..1, or null before the size is known. */
  progress: number | null;
  install: () => void;
}

/**
 * Watches the release feed and drives the download-and-restart flow. Checks
 * are silent by design: a machine that is offline, ahead of the feed, or
 * installed through a package manager simply never shows the pill.
 */
export function useUpdates(): UpdatesController {
  const [phase, setPhase] = useState<UpdatePhase>('idle');
  const [version, setVersion] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const updateRef = useRef<AppUpdate | null>(null);
  const installingRef = useRef(false);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      if (installingRef.current) return;
      try {
        const update = await checkForUpdate();
        if (!alive || installingRef.current) return;
        if (!update) {
          // An authoritative "this build is current" withdraws any earlier
          // offer — the app may have been updated underneath us by a package
          // manager. A failed check (below) never clears it: offline is not
          // proof the update went away.
          updateRef.current = null;
          setVersion(null);
          setPhase('idle');
          return;
        }
        updateRef.current = update;
        setVersion(update.version);
        setPhase('available');
      } catch (error) {
        // Expected whenever there is no feed to ask (no release yet,
        // offline, package-manager installs), so production stays quiet.
        if (import.meta.env.DEV) console.warn('Update check skipped:', error);
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const install = useCallback(() => {
    const update = updateRef.current;
    if (!update || installingRef.current) return;
    installingRef.current = true;
    setPhase('downloading');
    setProgress(null);
    void (async () => {
      try {
        await update.install(({ downloaded, total }) => {
          setProgress(total ? Math.min(downloaded / total, 1) : null);
        });
        setPhase('restarting');
        await relaunchApp();
      } catch (error) {
        // A failed download leaves the offer in place; the next click
        // retries. Unlike the periodic check this is a user-initiated action
        // that failed, so it stays logged in production — it is the only
        // trace when someone reports an update that would not install.
        console.warn('Update failed:', error);
        installingRef.current = false;
        setProgress(null);
        setPhase('available');
      }
    })();
  }, []);

  return { phase, version, progress, install };
}
