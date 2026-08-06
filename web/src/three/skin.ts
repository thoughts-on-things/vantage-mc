// Minecraft player skins: the 64×64 texture layout, and a procedural default
// for players whose real skin we don't have (which, by design, is most of them
// — Vantage never sends a player's name to a third-party skin service).
//
// A skin is one image holding the unwrapped faces of every cube in the player
// model. Each cube's six faces sit in a fixed cross layout, so the whole
// mapping reduces to "where does this cube's rect start", which is what
// {@link boxFaces} answers.

/** Skin sheet size. Modern skins are 64×64; legacy 64×32 sheets are drawn onto
 *  a 64×64 canvas with the missing limbs mirrored in (see {@link normalizeSkin}). */
export const SKIN_SIZE = 64;

/** One face rectangle in skin pixels, origin top-left. */
export interface FaceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The six face rects of a cube, in three.js `BoxGeometry` face order:
 *  `+X, -X, +Y, -Y, +Z, -Z`. The model faces `+Z`, so `+Z` is the front and
 *  `-X` is the player's right. */
export type BoxFaces = [FaceRect, FaceRect, FaceRect, FaceRect, FaceRect, FaceRect];

/**
 * Unwrap a cube of `w × h × d` skin pixels whose layout block starts at
 * `(x, y)`. This is the standard Minecraft cross: depth-wide side flaps, the
 * top and bottom above, and the faces reading right, front, left, back.
 */
export function boxFaces(x: number, y: number, w: number, h: number, d: number): BoxFaces {
  return [
    { x: x + d + w, y: y + d, w: d, h }, // +X — the player's left
    { x, y: y + d, w: d, h }, // -X — the player's right
    { x: x + d, y, w, h: d }, // +Y — top
    { x: x + d + w, y, w, h: d }, // -Y — bottom
    { x: x + d, y: y + d, w, h }, // +Z — front (the face)
    { x: x + 2 * d + w, y: y + d, w, h }, // -Z — back
  ];
}

/** Every cube of the player model, in skin pixels: its size, where it pivots
 *  (feet at y=0), and where its base and overlay rects live on the sheet. */
export interface ModelPart {
  /** Node this cube belongs to. Limbs swing, so they are separate nodes. */
  node: 'head' | 'body' | 'rightArm' | 'leftArm' | 'rightLeg' | 'leftLeg';
  /** Box size in skin pixels. */
  size: [number, number, number];
  /** Box centre relative to the node's pivot, in skin pixels. */
  offset: [number, number, number];
  /** Base layer sheet origin. */
  base: [number, number];
  /** Outer layer (hat, jacket, sleeve, trouser leg) sheet origin. */
  overlay: [number, number];
  /** How far the outer layer is inflated, in skin pixels per side. */
  inflate: number;
}

/** Where each node pivots, in skin pixels with the feet at y=0. Limbs hang from
 *  the shoulder/hip so a swing rotates about the right place. */
export const NODE_PIVOTS: Record<ModelPart['node'], [number, number, number]> = {
  head: [0, 24, 0],
  body: [0, 0, 0],
  rightArm: [-6, 22, 0],
  leftArm: [6, 22, 0],
  rightLeg: [-2, 12, 0],
  leftLeg: [2, 12, 0],
};

/** The classic (wide-armed) player model. A slim skin narrows the arms — see
 *  {@link modelParts}. */
export const WIDE_MODEL: readonly ModelPart[] = [
  { node: 'head', size: [8, 8, 8], offset: [0, 4, 0], base: [0, 0], overlay: [32, 0], inflate: 0.5 },
  { node: 'body', size: [8, 12, 4], offset: [0, 18, 0], base: [16, 16], overlay: [16, 32], inflate: 0.25 },
  { node: 'rightArm', size: [4, 12, 4], offset: [0, -4, 0], base: [40, 16], overlay: [40, 32], inflate: 0.25 },
  { node: 'leftArm', size: [4, 12, 4], offset: [0, -4, 0], base: [32, 48], overlay: [48, 48], inflate: 0.25 },
  { node: 'rightLeg', size: [4, 12, 4], offset: [0, -6, 0], base: [0, 16], overlay: [0, 32], inflate: 0.25 },
  { node: 'leftLeg', size: [4, 12, 4], offset: [0, -6, 0], base: [16, 48], overlay: [0, 48], inflate: 0.25 },
];

/** The model for an arm width: 4 px classic ("Steve"), 3 px slim ("Alex").
 *  A slim arm keeps its outer edge where the wide one had it, so the shoulder
 *  still meets the body. */
export function modelParts(slim: boolean): readonly ModelPart[] {
  if (!slim) return WIDE_MODEL;
  return WIDE_MODEL.map((part) => {
    if (part.node !== 'rightArm' && part.node !== 'leftArm') return part;
    const sign = part.node === 'rightArm' ? -1 : 1;
    return {
      ...part,
      size: [3, part.size[1], part.size[2]],
      // Half a pixel back toward the body, so the sleeve hangs off the same shoulder.
      offset: [part.offset[0] + sign * 0.5, part.offset[1], part.offset[2]],
    };
  });
}

/** Blocks per skin pixel — the model is 32 px tall and 2 blocks tall. */
export const PIXEL = 1 / 16;

/** Minecraft's own face shading, softened. There are no lights in a Vantage
 *  scene (the terrain carries baked light), so without this a player is a flat
 *  silhouette with no readable form. Order matches {@link BoxFaces}. */
export const FACE_SHADE: readonly number[] = [0.72, 0.72, 1.0, 0.62, 0.86, 0.86];

// --- the default skin -------------------------------------------------------

/** A stable 32-bit hash of a player id, so the same player always gets the
 *  same colours across sessions and machines. */
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function hsl(h: number, s: number, l: number): string {
  return `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
}

/** Whether a player's default model is the slim one. Mojang picks this from the
 *  account UUID; without a real skin we do the same thing from the id we have,
 *  so a crowd isn't uniform. */
export function defaultSlim(id: string): boolean {
  return (hashId(id) & 1) === 1;
}

/** The colours of one player's default skin. */
export interface SkinPalette {
  skinTone: string;
  skinShade: string;
  hair: string;
  eyes: string;
  shirt: string;
  shirtDark: string;
  trousers: string;
  trousersDark: string;
  shoes: string;
}

const TONES = ['#f0c8a0', '#d9a271', '#b4784a', '#8a552f', '#5c3a20'];
const SHADES = ['#d8b28c', '#c08e61', '#9c6640', '#744628', '#4a2e19'];
const HAIRS = ['#2a1c12', '#54331a', '#8a5a2b', '#c8a24c', '#7a7a7a'];
const EYES = ['#3b6ea5', '#4d7a3a', '#5a4634', '#3a3a3a'];

/**
 * Pick a player's default colours from their id.
 *
 * Every index here is taken with an **unsigned** shift: `hashId` fills all 32
 * bits, and a signed `>>` past 2^31 goes negative — which reads off the front
 * of a palette and yields `undefined`, a value the canvas silently ignores,
 * leaving whatever colour was set last. That failure mode is invisible in code
 * review and unmistakable on screen (an entirely black player), so the palette
 * lives here where it can be tested without a canvas.
 */
export function defaultPalette(id: string): SkinPalette {
  const h = hashId(id);
  const hue = h % 360;
  const accent = (hue + 150 + ((h >>> 9) % 60)) % 360;
  const tone = (h >>> 5) % TONES.length;
  return {
    skinTone: TONES[tone]!,
    skinShade: SHADES[tone]!,
    hair: HAIRS[(h >>> 13) % HAIRS.length]!,
    eyes: EYES[(h >>> 17) % EYES.length]!,
    shirt: hsl(hue, 0.52, 0.52),
    shirtDark: hsl(hue, 0.5, 0.4),
    trousers: hsl(accent, 0.3, 0.34),
    trousersDark: hsl(accent, 0.3, 0.26),
    shoes: '#3a3a42',
  };
}

/**
 * Draw a complete, plausible 64×64 skin for a player we have no real skin for.
 *
 * Deliberately not a copy of Steve or Alex: the colours come from the player's
 * own id, so a server full of unskinned players reads as a crowd of distinct
 * people rather than a row of identical mannequins — and Vantage ships no
 * Mojang artwork.
 */
export function defaultSkinCanvas(id: string, doc: Document = document): HTMLCanvasElement {
  const canvas = doc.createElement('canvas');
  canvas.width = SKIN_SIZE;
  canvas.height = SKIN_SIZE;
  const g = canvas.getContext('2d')!;
  const { skinTone, skinShade, hair, shirt, shirtDark, trousers, trousersDark, shoes, eyes } = defaultPalette(id);

  const fill = (rect: FaceRect, color: string) => {
    g.fillStyle = color;
    g.fillRect(rect.x, rect.y, rect.w, rect.h);
  };
  const paintBox = (faces: BoxFaces, main: string, side: string, top?: string, bottom?: string) => {
    fill(faces[0], side);
    fill(faces[1], side);
    fill(faces[2], top ?? main);
    fill(faces[3], bottom ?? side);
    fill(faces[4], main);
    fill(faces[5], main);
  };

  // Head: skin tone all round, hair on top and down the back.
  const head = boxFaces(0, 0, 8, 8, 8);
  paintBox(head, skinTone, skinShade, hair, skinShade);
  // A fringe over the front and sides so the hair colour is visible head-on.
  g.fillStyle = hair;
  g.fillRect(head[4].x, head[4].y, 8, 2);
  g.fillRect(head[0].x, head[0].y, 8, 2);
  g.fillRect(head[1].x, head[1].y, 8, 2);
  g.fillRect(head[5].x, head[5].y, 8, 3);
  // Eyes and mouth on the front face only.
  const fx = head[4].x;
  const fy = head[4].y;
  g.fillStyle = '#f4f4f4';
  g.fillRect(fx + 1, fy + 3, 2, 1);
  g.fillRect(fx + 5, fy + 3, 2, 1);
  g.fillStyle = eyes;
  g.fillRect(fx + 2, fy + 3, 1, 1);
  g.fillRect(fx + 5, fy + 3, 1, 1);
  g.fillStyle = skinShade;
  g.fillRect(fx + 3, fy + 5, 2, 1);

  paintBox(boxFaces(16, 16, 8, 12, 4), shirt, shirtDark, shirtDark, trousersDark);
  for (const [x, y] of [[40, 16], [32, 48]] as const) {
    const arm = boxFaces(x, y, 4, 12, 4);
    paintBox(arm, shirt, shirtDark, shirtDark, skinTone);
    // Bare forearm and hand below the sleeve.
    g.fillStyle = skinTone;
    for (const face of [arm[0], arm[1], arm[4], arm[5]]) g.fillRect(face.x, face.y + 8, face.w, 4);
    fill(arm[3], skinTone);
  }
  for (const [x, y] of [[0, 16], [16, 48]] as const) {
    const leg = boxFaces(x, y, 4, 12, 4);
    paintBox(leg, trousers, trousersDark, trousersDark, shoes);
    g.fillStyle = shoes;
    for (const face of [leg[0], leg[1], leg[4], leg[5]]) g.fillRect(face.x, face.y + 10, face.w, 2);
  }

  // The outer layer stays empty: transparent texels are cut out by the
  // material's alpha test, so an unskinned player simply has no hat or jacket.
  return canvas;
}

/**
 * Normalize any skin image onto a 64×64 canvas.
 *
 * A legacy 64×32 sheet has no left arm or leg and no second layer below the
 * hat; Minecraft mirrors the right limbs into the left slots, and so do we, or
 * half the model would render transparent.
 */
export function normalizeSkin(image: CanvasImageSource, width: number, height: number, doc: Document = document): HTMLCanvasElement {
  const canvas = doc.createElement('canvas');
  canvas.width = SKIN_SIZE;
  canvas.height = SKIN_SIZE;
  const g = canvas.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  const scale = width >= SKIN_SIZE ? width / SKIN_SIZE : 1;
  g.drawImage(image, 0, 0, width, height, 0, 0, SKIN_SIZE, (height / scale));
  if (height / scale >= SKIN_SIZE) return canvas;

  // Legacy sheet: mirror right arm → left arm, right leg → left leg. The
  // mirror is horizontal per face rect, which is what makes a mirrored limb
  // read the right way round.
  const mirror = (from: BoxFaces, to: BoxFaces, order: number[]) => {
    for (let i = 0; i < 6; i++) {
      const src = from[order[i]!]!;
      const dst = to[i]!;
      g.save();
      g.translate(dst.x + dst.w, dst.y);
      g.scale(-1, 1);
      g.drawImage(canvas, src.x, src.y, src.w, src.h, 0, 0, dst.w, dst.h);
      g.restore();
    }
  };
  // Mirroring swaps the +X and -X faces of the limb as well as flipping each.
  const swap = [1, 0, 2, 3, 4, 5];
  mirror(boxFaces(40, 16, 4, 12, 4), boxFaces(32, 48, 4, 12, 4), swap);
  mirror(boxFaces(0, 16, 4, 12, 4), boxFaces(16, 48, 4, 12, 4), swap);
  return canvas;
}

/**
 * Crop a player's face — the head's front plus whatever the hat layer draws
 * over it — into a square canvas, for the map marker and the player list. This
 * is the same image every Minecraft server's player list shows.
 */
export function headIconCanvas(skin: CanvasImageSource, size = 64, doc: Document = document): HTMLCanvasElement {
  const canvas = doc.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  const face = boxFaces(0, 0, 8, 8, 8)[4]!;
  const hat = boxFaces(32, 0, 8, 8, 8)[4]!;
  g.drawImage(skin, face.x, face.y, face.w, face.h, 0, 0, size, size);
  g.drawImage(skin, hat.x, hat.y, hat.w, hat.h, 0, 0, size, size);
  return canvas;
}
