import * as THREE from 'three';

/**
 * Loading and showing the generated sprite sheets in public/sprites/
 * (made by `npm run sprites`).
 */

const BASE = `${import.meta.env.BASE_URL}sprites/`;
const loader = new THREE.TextureLoader();

async function loadTexture(name: string): Promise<THREE.Texture> {
  const tex = await loader.loadAsync(`${BASE}${name}.png`);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

async function loadJson<T>(name: string): Promise<T> {
  const res = await fetch(`${BASE}${name}.json`);
  if (!res.ok) throw new Error(`could not load ${name}.json`);
  return (await res.json()) as T;
}

// ---- Racers -------------------------------------------------------------------

export interface RacerMeta {
  id: string;
  name: string;
  /** Size of one frame on the sheet, and how the frames are laid out. */
  cellW: number;
  cellH: number;
  cols: number;
  rows: number;
  /** Pixels of empty padding under the tyres in each frame. */
  pad: number;
  /** How many pixels the standard kart size comes out as on this sheet. */
  kartPx: number;
  /**
   * View angle of each frame in degrees: 0 = seen from behind, 180 = from the
   * front, positive = nose pointing right on screen, negative = pointing left.
   */
  angles: number[];
}

export class RacerSprite {
  readonly sprite: THREE.Sprite;
  private readonly tex: THREE.Texture;

  constructor(
    source: THREE.Texture,
    readonly meta: RacerMeta,
    /** World size of the standard kart; every racer's kart comes out this big. */
    kartSize: number,
  ) {
    // Own copy of the texture so each racer can show a different frame.
    this.tex = source.clone();
    this.tex.needsUpdate = true;
    this.sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.tex, transparent: true, alphaTest: 0.05 }),
    );
    this.sprite.center.set(0.5, meta.pad / meta.cellH);
    const width = (kartSize * meta.cellW) / meta.kartPx;
    this.sprite.scale.set(width, (width * meta.cellH) / meta.cellW, 1);
    this.tex.repeat.set(1 / meta.cols, 1 / meta.rows);
    this.setView(0);
  }

  /**
   * The frame on the sheet nearest to a view angle, in degrees. 0 = from
   * directly behind; positive = nose pointing right on screen; negative = left.
   */
  frameFor(degrees: number): number {
    const { angles } = this.meta;
    // Shortest way round the circle between two angles, so -170 is close to 180.
    const gap = (a: number) => Math.abs(((((a - degrees) % 360) + 540) % 360) - 180);
    let frame = 0;
    for (let i = 1; i < angles.length; i++) {
      if (gap(angles[i]) < gap(angles[frame])) frame = i;
    }
    return frame;
  }

  /** Fade the sprite: 1 = solid, 0 = invisible. */
  setOpacity(opacity: number): void {
    this.sprite.material.opacity = opacity;
    this.sprite.visible = opacity > 0.02;
  }

  /** Show the kart as seen from a given angle (see `frameFor`). */
  setView(degrees: number): void {
    const { cols, rows } = this.meta;
    const frame = this.frameFor(degrees);
    this.tex.offset.x = (frame % cols) / cols;
    // Texture rows count up from the bottom of the image; sheet rows from the top.
    this.tex.offset.y = (rows - 1 - Math.floor(frame / cols)) / rows;
  }
}

export async function loadRacer(id: string, kartSize: number): Promise<RacerSprite> {
  const [tex, meta] = await Promise.all([loadTexture(id), loadJson<RacerMeta>(id)]);
  return new RacerSprite(tex, meta, kartSize);
}

// ---- Object sheets (scenery, items) ---------------------------------------------

interface KitMeta {
  cell: number;
  pad: number;
  frames: { name: string; width: number; height: number }[];
}

export interface SpriteKit {
  /** Names of the objects on the sheet, in order. */
  readonly names: string[];
  /** Make one sprite of an object, `height` world units tall, standing on the ground. */
  make(name: string, height: number, mirrored?: boolean): THREE.Sprite;
  /** Width of an object divided by its height. */
  aspect(name: string): number;
}

/** Load a sheet of separate objects, e.g. 'scenery' or 'items'. */
export async function loadKit(sheet: string): Promise<SpriteKit> {
  const [source, meta] = await Promise.all([loadTexture(sheet), loadJson<KitMeta>(sheet)]);
  const n = meta.frames.length;

  // One shared material per (object, mirrored) pair.
  const materials = new Map<string, THREE.SpriteMaterial>();
  meta.frames.forEach((frame, i) => {
    for (const mirrored of [false, true]) {
      const tex = source.clone();
      tex.needsUpdate = true;
      tex.repeat.x = (mirrored ? -1 : 1) / n;
      tex.offset.x = (mirrored ? i + 1 : i) / n;
      materials.set(`${frame.name}:${mirrored}`, new THREE.SpriteMaterial({ map: tex, alphaTest: 0.4 }));
    }
  });

  return {
    names: meta.frames.map((f) => f.name),
    aspect(name) {
      const frame = meta.frames.find((f) => f.name === name);
      if (!frame) throw new Error(`unknown object "${name}" on sheet "${sheet}"`);
      return frame.width / frame.height;
    },
    make(name, height, mirrored = false) {
      const frame = meta.frames.find((f) => f.name === name);
      const material = materials.get(`${name}:${mirrored}`);
      if (!frame || !material) throw new Error(`unknown object "${name}" on sheet "${sheet}"`);
      const sprite = new THREE.Sprite(material);
      // The drawing only fills part of its square cell; scale the cell so the
      // drawing itself comes out `height` tall.
      const size = height * (meta.cell / frame.height);
      sprite.scale.set(size, size, 1);
      sprite.center.set(0.5, meta.pad / meta.cell);
      return sprite;
    },
  };
}
