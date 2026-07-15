import { tileKey, type ManifestTile } from '../core/index.js';

export interface TileCandidate {
  ref: ManifestTile;
  distanceSq: number;
  priority: number;
}

/**
 * Query a regular sparse tile index by coordinate range. Work is proportional
 * to the visible grid, not the total manifest: a 100k-tile world and a 1k-tile
 * world cost the same to plan at the same view distance.
 */
export function nearbyTiles(
  index: ReadonlyMap<string, ManifestTile>,
  tileBlocks: number,
  focusX: number,
  focusZ: number,
  radius: number,
  predictedX = focusX,
  predictedZ = focusZ,
): TileCandidate[] {
  const radiusSq = radius * radius;
  const minX = Math.floor((focusX - radius) / tileBlocks - 0.5);
  const maxX = Math.ceil((focusX + radius) / tileBlocks - 0.5);
  const minZ = Math.floor((focusZ - radius) / tileBlocks - 0.5);
  const maxZ = Math.ceil((focusZ + radius) / tileBlocks - 0.5);
  const out: TileCandidate[] = [];
  for (let z = minZ; z <= maxZ; z++) {
    for (let x = minX; x <= maxX; x++) {
      const ref = index.get(tileKey(x, z));
      if (!ref) continue;
      const cx = (x + 0.5) * tileBlocks;
      const cz = (z + 0.5) * tileBlocks;
      const dx = cx - focusX;
      const dz = cz - focusZ;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq > radiusSq) continue;
      const px = cx - predictedX;
      const pz = cz - predictedZ;
      // Current distance keeps the centre sharp; a modest look-ahead component
      // lets fast pans spend their next request on where the camera is going.
      const priority = distanceSq * 0.72 + (px * px + pz * pz) * 0.28;
      out.push({ ref, distanceSq, priority });
    }
  }
  out.sort((a, b) => a.priority - b.priority || a.distanceSq - b.distanceSq);
  return out;
}

/** Nearest/highest-priority admission under both count and weighted budgets. */
export function admitTiles(
  candidates: readonly TileCandidate[],
  maxTiles: number,
  maxBytes: number,
  estimateBytes: (ref: ManifestTile) => number,
): TileCandidate[] {
  const admitted: TileCandidate[] = [];
  let bytes = 0;
  for (const candidate of candidates) {
    if (admitted.length >= maxTiles) break;
    const weight = Math.max(1, estimateBytes(candidate.ref));
    // Always admit the nearest tile, even if one unusually large tile exceeds
    // the whole budget; a map that shows one tile is better than a retry loop.
    if (admitted.length > 0 && bytes + weight > maxBytes) continue;
    admitted.push(candidate);
    bytes += weight;
  }
  return admitted;
}
