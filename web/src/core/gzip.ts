// Transparent gzip handling for tile payloads. The generator writes tiles and
// the texture array gzip-wrapped (~8× smaller), so any static file host serves
// them efficiently with zero configuration. Decompression uses the platform's
// native DecompressionStream (browsers + Node 18+); when a server (or CDN)
// already inflates via Content-Encoding, the magic sniff makes this a no-op.

/** Whether the buffer starts with the gzip magic (0x1f 0x8b). */
export function isGzip(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 2) return false;
  const b = new Uint8Array(buffer, 0, 2);
  return b[0] === 0x1f && b[1] === 0x8b;
}

/** Inflate the buffer if it is gzip-wrapped; return it untouched otherwise. */
export async function maybeInflate(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  if (!isGzip(buffer)) return buffer;
  const ds = new DecompressionStream('gzip');
  const stream = new Response(buffer).body!.pipeThrough(ds);
  return new Response(stream).arrayBuffer();
}
