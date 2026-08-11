import { useCallback, useEffect, useState } from 'react';
import {
  deleteHost,
  listHosts,
  probeHost,
  saveHost,
  type HostEntry,
  type HostInput,
  type HostProbe,
} from '../bridge.js';
import { userFacingError } from '../lib/format.js';

export interface HostsController {
  hosts: HostEntry[];
  loading: boolean;
  error: string | null;
  dismissError: () => void;
  refresh: () => Promise<void>;
  /** Resolves to the saved entry, or null when saving failed. */
  save: (input: HostInput) => Promise<HostEntry | null>;
  remove: (id: string) => Promise<void>;
  /** Resolves to null when the address could not be reached at all. */
  probe: (endpoint: string, token?: string) => Promise<HostProbe | null>;
}

/**
 * The saved `vantage server` connections.
 *
 * Deliberately separate from the world library: a server is not a save on this
 * PC, has no render to manage, and its lifecycle is "reachable or not" rather
 * than "rendered or not". The one thing the two share is the viewer, which the
 * library owns.
 */
export function useHosts(): HostsController {
  const [hosts, setHosts] = useState<HostEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setHosts(await listHosts());
      setError(null);
    } catch (reason) {
      setError(userFacingError(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(async (input: HostInput): Promise<HostEntry | null> => {
    setError(null);
    try {
      const entry = await saveHost(input);
      setHosts((current) => {
        const index = current.findIndex((host) => host.id === entry.id);
        if (index < 0) return [...current, entry];
        const next = [...current];
        next[index] = entry;
        return next;
      });
      return entry;
    } catch (reason) {
      setError(userFacingError(reason));
      return null;
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    setError(null);
    try {
      await deleteHost(id);
      setHosts((current) => current.filter((host) => host.id !== id));
    } catch (reason) {
      setError(userFacingError(reason));
    }
  }, []);

  const probe = useCallback(async (endpoint: string, token?: string): Promise<HostProbe | null> => {
    setError(null);
    try {
      return await probeHost(endpoint, token);
    } catch (reason) {
      setError(userFacingError(reason));
      return null;
    }
  }, []);

  const dismissError = useCallback(() => setError(null), []);

  return { hosts, loading, error, dismissError, refresh, save, remove, probe };
}
