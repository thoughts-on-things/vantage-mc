export interface PairingIntent {
  endpoint: string;
  code: string;
}

export class LatestWhileBusy<T> {
  private busy = false;
  private pending: T | null = null;

  offer(value: T): T | null {
    if (this.busy) {
      this.pending = value;
      return null;
    }
    return value;
  }

  start(): void {
    this.busy = true;
  }

  finish(): T | null {
    this.busy = false;
    const pending = this.pending;
    this.pending = null;
    return pending;
  }
}

/** Suppresses the duplicate event emitted by cold-start setup without making a
 * cancelled one-time link impossible to retry. */
export class PairingUrlDeduper {
  private readonly seen = new Map<string, number>();

  accept(raw: string, now = Date.now()): boolean {
    for (const [url, at] of this.seen) {
      if (now - at > 1000) this.seen.delete(url);
    }
    const previous = this.seen.get(raw);
    if (previous !== undefined && now - previous <= 1000) return false;
    this.seen.set(raw, now);
    return true;
  }
}

/** Parse the only deep-link shape Vantage accepts. This is repeated by the
 * native pairing command before it performs network I/O. */
export function parsePairingUrl(raw: string): PairingIntent {
  if (raw.length > 2048) throw new Error('That Vantage pairing link is too long.');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('That Vantage pairing link is not valid.');
  }
  if (
    url.protocol !== 'vantage:' ||
    url.hostname !== 'connect' ||
    url.username ||
    url.password ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.hash
  ) {
    throw new Error('That link is not a Vantage server pairing request.');
  }
  const keys = [...url.searchParams.keys()];
  if (
    keys.length !== 2 ||
    keys.some((key) => key !== 'host' && key !== 'code') ||
    url.searchParams.getAll('host').length !== 1 ||
    url.searchParams.getAll('code').length !== 1
  ) {
    throw new Error('That Vantage pairing link has invalid parameters.');
  }
  const endpoint = url.searchParams.get('host')!;
  const code = url.searchParams.get('code')!;
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(code)) {
    throw new Error('That Vantage pairing code is not valid.');
  }
  let host: URL;
  try {
    host = new URL(endpoint);
  } catch {
    throw new Error('That Vantage server address is not valid.');
  }
  const loopback = host.hostname === 'localhost' || host.hostname.endsWith('.localhost') ||
    host.hostname === '127.0.0.1' || host.hostname === '[::1]';
  if (host.protocol === 'http:' && !loopback) {
    throw new Error('Vantage pairing requires HTTPS except on loopback.');
  }
  if (
    (host.protocol !== 'https:' && host.protocol !== 'http:') ||
    host.username ||
    host.password ||
    host.search ||
    host.hash
  ) {
    throw new Error('That Vantage server address is not safe.');
  }
  host.pathname = host.pathname.endsWith('/') ? host.pathname : `${host.pathname}/`;
  return { endpoint: host.toString(), code };
}
