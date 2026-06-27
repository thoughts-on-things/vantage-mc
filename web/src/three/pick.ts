// March the surface map along a world-space ray to find the biome under the
// cursor. O(columns along the ray) — independent of mesh size, so it never
// stalls on huge renders the way a per-triangle raycast would.

import * as THREE from 'three';
import type { SurfaceMap } from '../core/index.js';

const _entry = new THREE.Vector3();

/**
 * Return the biome id at the first surface column the ray drops below the
 * terrain top, or `-1` if it misses. `bounds` bounds the march so empty sky is
 * skipped.
 */
export function pickBiome(ray: THREE.Ray, surf: SurfaceMap, bounds: THREE.Box3): number {
  let t = 0;
  if (!bounds.containsPoint(ray.origin)) {
    if (!ray.intersectBox(bounds, _entry)) return -1; // ray misses the terrain box
    t = ray.origin.distanceTo(_entry); // direction is unit -> t == distance
  }
  const maxT = t + bounds.min.distanceTo(bounds.max) + 4;
  for (; t <= maxT; t += 0.5) {
    const x = ray.origin.x + ray.direction.x * t;
    const y = ray.origin.y + ray.direction.y * t;
    const z = ray.origin.z + ray.direction.z * t;
    const cxi = Math.floor(x - surf.originX);
    const czi = Math.floor(z - surf.originZ);
    if (cxi < 0 || czi < 0 || cxi >= surf.width || czi >= surf.depth) continue;
    const idx = czi * surf.width + cxi;
    if (y <= surf.height[idx]! + 1) return surf.biome[idx]!;
  }
  return -1;
}
