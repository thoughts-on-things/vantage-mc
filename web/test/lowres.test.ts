// VLR1 lowres-tile decoding.

import { describe, expect, it } from 'vitest';
import { LOWRES_EMPTY, parseLowresTile } from '../src/core/index.js';

/** Hand-rolled 3×3 VLR1 blob matching the generator's layout. */
function encodeVLR1(): ArrayBuffer {
  const gw = 3;
  const n = gw * gw;
  const size = 28 + 2 * n + 3 * n + ((4 - ((28 + 2 * n + 3 * n) % 4)) % 4);
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  new Uint8Array(buf).set([0x56, 0x4c, 0x52, 0x31]); // "VLR1"
  v.setUint32(4, 1, true); // version
  v.setUint32(8, gw, true);
  v.setUint32(12, gw, true);
  v.setInt32(16, -256, true); // originX
  v.setInt32(20, 512, true); // originZ
  v.setUint32(24, 2, true); // span
  const heights = new Int16Array(buf, 28, n);
  heights.set([64, 65, 66, 67, 68, 69, 70, 71, LOWRES_EMPTY]);
  const rgb = new Uint8Array(buf, 28 + 2 * n, 3 * n);
  for (let i = 0; i < 3 * n; i++) rgb[i] = i;
  return buf;
}

describe('parseLowresTile', () => {
  it('decodes VLR1 heights, colors, and placement', () => {
    const t = parseLowresTile(encodeVLR1());
    expect([t.width, t.depth]).toEqual([3, 3]);
    expect([t.originX, t.originZ, t.span]).toEqual([-256, 512, 2]);
    expect(t.heights[0]).toBe(64);
    expect(t.heights[8]).toBe(LOWRES_EMPTY);
    expect(t.rgb[3 * 8 + 2]).toBe(26);
  });

  it('throws on a wrong magic', () => {
    const buf = new ArrayBuffer(32);
    new Uint8Array(buf).set([88, 88, 88, 88]);
    expect(() => parseLowresTile(buf)).toThrow(/lowres magic/);
  });
});
