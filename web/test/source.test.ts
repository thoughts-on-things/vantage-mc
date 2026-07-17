import { afterEach, describe, expect, it, vi } from 'vitest';
import { worldFromDirectory, worldFromFiles, worldFromHttp, worldFromUrl, worldFromVantageServer } from '../src/core/index.js';

const MANIFEST = { format: 1, tileChunks: 8, tileBlocks: 128, textures: 'terrain.vtexarr', biomes: [], tiles: [] };

function jsonFile(value: unknown): File {
  return new File([JSON.stringify(value)], 'manifest.json');
}

function binFile(name: string, bytes: number[]): File {
  return new File([new Uint8Array(bytes)], name);
}

/** Files as `<input webkitdirectory>` presents them: paths via `pathOf`. */
function pick(entries: Record<string, File>): { files: File[]; pathOf: (f: File) => string } {
  const paths = new Map(Object.entries(entries).map(([p, f]) => [f, p]));
  return { files: [...paths.keys()], pathOf: (f) => paths.get(f)! };
}

describe('worldFromFiles', () => {
  it('keys files relative to the manifest and fetches by manifest path', async () => {
    const { files, pathOf } = pick({
      'render/manifest.json': jsonFile(MANIFEST),
      'render/terrain.vtexarr': binFile('terrain.vtexarr', [1, 2]),
      'render/tiles/t.0.0.vtile': binFile('t.0.0.vtile', [3, 4, 5]),
    });
    const src = await worldFromFiles(files, pathOf);
    expect(src.label).toBe('render');
    expect(src.manifest).toEqual(MANIFEST);
    expect(new Uint8Array(await src.fetch('tiles/t.0.0.vtile'))).toEqual(new Uint8Array([3, 4, 5]));
    expect(new Uint8Array(await src.fetch('./terrain.vtexarr'))).toEqual(new Uint8Array([1, 2]));
  });

  it('accepts the render root itself (manifest at the top level)', async () => {
    const { files, pathOf } = pick({
      'manifest.json': jsonFile(MANIFEST),
      'tiles/t.1.2.vtile': binFile('t.1.2.vtile', [9]),
    });
    const src = await worldFromFiles(files, pathOf);
    expect(new Uint8Array(await src.fetch('tiles/t.1.2.vtile'))).toEqual(new Uint8Array([9]));
  });

  it('prefers the shallowest manifest when several are present', async () => {
    const inner = { ...MANIFEST, format: 2 };
    const { files, pathOf } = pick({
      'a/manifest.json': jsonFile(MANIFEST),
      'a/old/manifest.json': jsonFile(inner),
    });
    const src = await worldFromFiles(files, pathOf);
    expect((src.manifest as { format: number }).format).toBe(1);
  });

  it('rejects a selection without a manifest.json', async () => {
    const { files, pathOf } = pick({ 'render/tiles/t.0.0.vtile': binFile('t.0.0.vtile', [1]) });
    await expect(worldFromFiles(files, pathOf)).rejects.toThrow(/no manifest\.json/);
  });

  it('rejects fetches for files outside the selection', async () => {
    const { files, pathOf } = pick({ 'manifest.json': jsonFile(MANIFEST) });
    const src = await worldFromFiles(files, pathOf);
    await expect(src.fetch('tiles/t.9.9.vtile')).rejects.toThrow(/not in the selected folder/);
  });
});

/** Minimal FileSystemDirectoryHandle over a nested plain-object tree. */
function dirHandle(name: string, tree: Record<string, unknown>): FileSystemDirectoryHandle {
  return {
    name,
    getDirectoryHandle: (child: string) => {
      const node = tree[child];
      if (typeof node !== 'object' || node === null || node instanceof File) return Promise.reject(new Error('NotFound'));
      return Promise.resolve(dirHandle(child, node as Record<string, unknown>));
    },
    getFileHandle: (child: string) => {
      const node = tree[child];
      if (!(node instanceof File)) return Promise.reject(new Error('NotFound'));
      return Promise.resolve({ name: child, getFile: () => Promise.resolve(node) });
    },
  } as unknown as FileSystemDirectoryHandle;
}

describe('worldFromDirectory', () => {
  it('reads the manifest from the root and walks subdirectories on fetch', async () => {
    const dir = dirHandle('render', {
      'manifest.json': jsonFile(MANIFEST),
      'terrain.vtexarr': binFile('terrain.vtexarr', [7]),
      tiles: { 't.0.0.vtile': binFile('t.0.0.vtile', [1, 2, 3]) },
    });
    const src = await worldFromDirectory(dir);
    expect(src.label).toBe('render');
    expect(src.manifest).toEqual(MANIFEST);
    expect(new Uint8Array(await src.fetch('terrain.vtexarr'))).toEqual(new Uint8Array([7]));
    expect(new Uint8Array(await src.fetch('tiles/t.0.0.vtile'))).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('explains when the picked folder is not a render', async () => {
    await expect(worldFromDirectory(dirHandle('saves', {}))).rejects.toThrow(/no manifest\.json in "saves"/);
  });

  it('refuses path escapes', async () => {
    const src = await worldFromDirectory(dirHandle('render', { 'manifest.json': jsonFile(MANIFEST) }));
    await expect(src.fetch('../secrets.txt')).rejects.toThrow(/bad tile path/);
  });
});

describe('worldFromUrl', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fetches the manifest and resolves tile paths against it', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(String(url));
      const body = String(url).endsWith('manifest.json')
        ? new Response(JSON.stringify(MANIFEST), { headers: { 'content-type': 'application/json' } })
        : new Response(new Uint8Array([5, 6]));
      return Promise.resolve(body);
    });
    const src = await worldFromUrl('https://example.test/demo/manifest.json');
    expect(src.manifest).toEqual(MANIFEST);
    expect(new Uint8Array(await src.fetch('tiles/t.0.0.vtile'))).toEqual(new Uint8Array([5, 6]));
    expect(calls).toEqual(['https://example.test/demo/manifest.json', 'https://example.test/demo/tiles/t.0.0.vtile']);
  });

  it('throws on a non-OK manifest response', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('nope', { status: 404, statusText: 'Not Found' })));
    await expect(worldFromUrl('https://example.test/manifest.json')).rejects.toThrow(/404/);
  });
});

describe('authenticated HTTP worlds', () => {
  it('keeps the bearer token in headers for the manifest and every artifact', async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const http = (input: string, init?: RequestInit) => {
      calls.push({ url: input, auth: new Headers(init?.headers).get('authorization') });
      const body = input.endsWith('manifest.json')
        ? new Response(JSON.stringify(MANIFEST), { headers: { 'content-type': 'application/json' } })
        : new Response(new Uint8Array([8, 9]));
      return Promise.resolve(body);
    };
    const src = await worldFromHttp('https://maps.example.test/world/manifest.json', {
      accessToken: 'secret-token',
      fetch: http,
    });
    await src.fetch('tiles/t.0.0.vtile');
    expect(calls).toEqual([
      { url: 'https://maps.example.test/world/manifest.json', auth: 'Bearer secret-token' },
      { url: 'https://maps.example.test/world/tiles/t.0.0.vtile', auth: 'Bearer secret-token' },
    ]);
  });

  it('polls conditionally: presents the validator, maps 304 to unchanged, confines paths', async () => {
    const calls: { url: string; inm: string | null; auth: string | null }[] = [];
    const http = (input: string, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      calls.push({ url: input, inm: h.get('if-none-match'), auth: h.get('authorization') });
      if (h.get('if-none-match') === '"abc"') return Promise.resolve(new Response(null, { status: 304, headers: { etag: '"abc"' } }));
      return Promise.resolve(new Response(JSON.stringify(MANIFEST), { headers: { etag: '"abc"' } }));
    };
    const src = await worldFromHttp('https://maps.example.test/world/manifest.json', {
      accessToken: 'secret-token',
      fetch: http,
    });
    const first = await src.fetchConditional!('manifest.json', undefined);
    expect(first).not.toBe('unchanged');
    expect((first as { etag?: string }).etag).toBe('"abc"');
    expect(await src.fetchConditional!('manifest.json', '"abc"')).toBe('unchanged');
    expect(calls[1]?.inm).toBeNull(); // no validator yet — an unconditional read
    expect(calls[2]).toEqual({
      url: 'https://maps.example.test/world/manifest.json',
      inm: '"abc"',
      auth: 'Bearer secret-token',
    });
    await expect(src.fetchConditional!('https://evil.test/tile', undefined)).rejects.toThrow(/unsafe remote artifact path/);
  });

  it('replaces a caller-cased Authorization header instead of duplicating it', async () => {
    const captured: Record<string, string>[] = [];
    const http = (input: string, init?: RequestInit) => {
      captured.push({ ...(init?.headers as Record<string, string>) });
      return Promise.resolve(new Response(JSON.stringify(MANIFEST)));
    };
    await worldFromHttp('https://maps.example.test/world/manifest.json', {
      accessToken: 'wins',
      headers: { Authorization: 'Bearer stale', 'X-Extra': 'kept' },
      fetch: http,
    });
    // One lowercase key per header — the token replaced the caller's value.
    expect(captured[0]).toEqual({ authorization: 'Bearer wins', 'x-extra': 'kept' });
  });

  it('rejects manifest paths that could exfiltrate credentials', async () => {
    const http = (input: string) => Promise.resolve(
      input.endsWith('manifest.json')
        ? new Response(JSON.stringify(MANIFEST))
        : new Response(new Uint8Array([1])),
    );
    const src = await worldFromHttp('https://maps.example.test/world/manifest.json', {
      accessToken: 'secret-token',
      fetch: http,
    });
    await expect(src.fetch('https://evil.test/tile')).rejects.toThrow(/unsafe remote artifact path/);
    await expect(src.fetch('../other-world/tile')).rejects.toThrow(/unsafe remote artifact path/);
    await expect(src.fetch('%2e%2e/secrets')).rejects.toThrow(/unsafe remote artifact path/);
  });

  it('builds the protocol-v1 manifest URL for a Vantage server', async () => {
    const calls: string[] = [];
    const http = (input: string) => {
      calls.push(input);
      return Promise.resolve(new Response(JSON.stringify(MANIFEST)));
    };
    await worldFromVantageServer('https://play.example.test/maps', { fetch: http });
    expect(calls).toEqual(['https://play.example.test/maps/v1/worlds/default/manifest.json']);
  });

  it('rejects URL credentials in favor of explicit headers', async () => {
    await expect(worldFromHttp('https://user:secret@maps.example.test/manifest.json')).rejects.toThrow(/headers/);
    expect(() => worldFromVantageServer('https://user:secret@maps.example.test/')).toThrow(/headers/);
  });
});
