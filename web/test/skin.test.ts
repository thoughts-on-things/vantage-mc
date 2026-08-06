// The player skin layout and the procedural default palette. Both are pure —
// the canvas drawing that uses them isn't testable outside a browser, which is
// exactly why the parts that can go quietly wrong live here.

import { describe, expect, it } from 'vitest';
import { boxFaces, defaultPalette, defaultSlim, hashId, modelParts, WIDE_MODEL } from '../src/three/skin.js';

describe('boxFaces', () => {
  it('unwraps the head the way a Minecraft skin does', () => {
    // The canonical 64×64 layout, straight off the wiki: the head block at
    // (0,0) puts its top at (8,0), the face at (8,8), and reads right, front,
    // left, back across the middle row.
    const [px, nx, py, ny, pz, nz] = boxFaces(0, 0, 8, 8, 8);
    expect(py).toEqual({ x: 8, y: 0, w: 8, h: 8 }); // top
    expect(ny).toEqual({ x: 16, y: 0, w: 8, h: 8 }); // bottom
    expect(nx).toEqual({ x: 0, y: 8, w: 8, h: 8 }); // right (the player's)
    expect(pz).toEqual({ x: 8, y: 8, w: 8, h: 8 }); // front — the face
    expect(px).toEqual({ x: 16, y: 8, w: 8, h: 8 }); // left
    expect(nz).toEqual({ x: 24, y: 8, w: 8, h: 8 }); // back
  });

  it('unwraps the body, whose depth differs from its width', () => {
    const [px, nx, py, ny, pz, nz] = boxFaces(16, 16, 8, 12, 4);
    expect(py).toEqual({ x: 20, y: 16, w: 8, h: 4 });
    expect(ny).toEqual({ x: 28, y: 16, w: 8, h: 4 });
    expect(nx).toEqual({ x: 16, y: 20, w: 4, h: 12 });
    expect(pz).toEqual({ x: 20, y: 20, w: 8, h: 12 });
    expect(px).toEqual({ x: 28, y: 20, w: 4, h: 12 });
    expect(nz).toEqual({ x: 32, y: 20, w: 8, h: 12 });
  });

  it('keeps every rect inside the sheet for every part of the model', () => {
    for (const part of [...WIDE_MODEL, ...modelParts(true)]) {
      const [w, h, d] = part.size;
      for (const origin of [part.base, part.overlay]) {
        for (const rect of boxFaces(origin[0], origin[1], w, h, d)) {
          expect(rect.x).toBeGreaterThanOrEqual(0);
          expect(rect.y).toBeGreaterThanOrEqual(0);
          expect(rect.x + rect.w).toBeLessThanOrEqual(64);
          expect(rect.y + rect.h).toBeLessThanOrEqual(64);
        }
      }
    }
  });
});

describe('the model', () => {
  it('is 32 skin pixels — two blocks — tall, feet on the ground', () => {
    const head = WIDE_MODEL.find((p) => p.node === 'head')!;
    const leg = WIDE_MODEL.find((p) => p.node === 'rightLeg')!;
    // Head pivot 24 + offset 4 + half of 8 = 32; leg pivot 12 + offset -6 - 6 = 0.
    expect(24 + head.offset[1] + head.size[1] / 2).toBe(32);
    expect(12 + leg.offset[1] - leg.size[1] / 2).toBe(0);
  });

  it('narrows only the arms for a slim skin', () => {
    const slim = modelParts(true);
    expect(slim.filter((p) => p.size[0] === 3).map((p) => p.node)).toEqual(['rightArm', 'leftArm']);
    for (const part of slim) {
      if (part.node === 'rightArm' || part.node === 'leftArm') continue;
      expect(part).toEqual(WIDE_MODEL.find((p) => p.node === part.node));
    }
  });
});

describe('defaultPalette', () => {
  // The regression this file exists for: `hashId` fills all 32 bits, so a
  // signed `>>` on it goes negative for half of all ids, indexes off the front
  // of a palette, and yields `undefined` — which a canvas accepts silently and
  // then draws the previous colour with. On screen: an entirely black player.
  it('never yields an undefined colour, for any id', () => {
    const ids = ['', 'a', 'Notch', '91c71e4a-146c-4788-bbb9-39002556a24e'];
    for (let i = 0; i < 2000; i++) ids.push(`player-${i}`);
    for (const id of ids) {
      const palette = defaultPalette(id);
      for (const [key, value] of Object.entries(palette)) {
        expect(typeof value, `${key} of "${id}"`).toBe('string');
        expect(value, `${key} of "${id}"`).toMatch(/^(#[0-9a-f]{6}|hsl\(\d+ \d+% \d+%\))$/);
      }
    }
  });

  it('reaches every skin tone across a population', () => {
    const tones = new Set<string>();
    for (let i = 0; i < 500; i++) tones.add(defaultPalette(`player-${i}`).skinTone);
    expect(tones.size).toBe(5);
  });

  it('is stable for a given id', () => {
    expect(defaultPalette('Notch')).toEqual(defaultPalette('Notch'));
    expect(defaultPalette('Notch')).not.toEqual(defaultPalette('Herobrine'));
  });
});

describe('hashId', () => {
  it('stays unsigned', () => {
    for (let i = 0; i < 5000; i++) expect(hashId(`id-${i}`)).toBeGreaterThanOrEqual(0);
  });

  it('splits a population between the wide and slim models', () => {
    let slim = 0;
    for (let i = 0; i < 400; i++) if (defaultSlim(`player-${i}`)) slim++;
    expect(slim).toBeGreaterThan(100);
    expect(slim).toBeLessThan(300);
  });
});
