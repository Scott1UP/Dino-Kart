import * as THREE from 'three';
import type { Layout, Mottle, Surface, Theme } from './layouts';
import { makeRng } from './rng';

/**
 * A track, built from a layout (where everything is) and a theme (what it
 * looks like).
 *
 * From that one definition we build the terrain, paint its texture, build the
 * fences, bridges and water, and answer "what is under this point", so the
 * picture and the physics can never disagree.
 *
 * World units are the layout's own units: layout point (x, y) is world (x, z),
 * with height as world y. The lap runs in waypoint order.
 */

const SAMPLES_PER_WAYPOINT = 24;

/** Soft wall, marked by the fences: how far from the centre line a kart may stray. */
export const WALL_DIST = 64;
/** The walls narrow in to a bridge's railings over this many samples either side of it. */
const WALL_TAPER = 16;
/**
 * A bridge deck sits this far above the road's height, so that where it meets
 * the bank the ground never shows through the planks.
 */
const DECK_LIFT = 0.7;
/** Water is a little wider than the road, with a bank. */
const WATER_EXTRA = 4.5;

/** A boost pad is this long and wide; driving over it gives a burst of speed. */
const PAD_LENGTH = 30;
const PAD_HALF_WIDTH = 11;

const FENCE_HEIGHT = 9;
/** Length of fence shown by one repeat of its texture (one post and the rails to the next). */
const FENCE_PANEL = 14;

// The terrain is a grid of heights covering the map plus a margin all round.
const MARGIN = 200;
const CELL = 10;
const TEXTURE_SCALE = 1.6;

// How the special surfaces are painted, on any track.
const WATER: Mottle = { base: '#3fb6e6', tints: ['#63c9f0', '#2f9fd6', '#8ddcf7'], blotches: 36, minR: 2, maxR: 8 };
const ICE: Mottle = { base: '#6fd0f2', tints: ['#9be2fa', '#52bfe8', '#c3f0ff'], blotches: 30, minR: 3, maxR: 10 };
const LAKE: Mottle = { base: '#a6ebe6', tints: ['#c9f6f1', '#86dcd8', '#e3fbf8'], blotches: 30, minR: 3, maxR: 10 };

export type { Surface };

export interface TrackQuery {
  /** Distance from the centre line. */
  dist: number;
  /** Index of the nearest centre-line sample (progress around the lap). */
  index: number;
  /** Nearest point on the centre line. */
  x: number;
  z: number;
  surface: Surface;
}

/** Something on the road to steer round. */
export interface Rock {
  x: number;
  y: number;
  z: number;
  radius: number;
  /** The sample it is at, and how far right of the centre line. */
  sample: number;
  lane: number;
  sheet: string;
  sprite: string;
}

const smooth = (t: number) => {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
};

function canvasTexture(canvas: HTMLCanvasElement, repeat = false): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

export class Track {
  readonly count: number;
  /** Evenly spaced centre-line samples. Sample 0 is the start/finish line. */
  readonly xs: Float32Array;
  readonly zs: Float32Array;
  /** Which waypoint each sample is at (fractional), for looking up height and surface. */
  private readonly at: Float32Array;
  /** Whether each sample is on a bridge deck. */
  private readonly bridge: Uint8Array;
  /** How far from the centre line the soft wall is at each sample. */
  private readonly wall: Float32Array;
  /** The road surface at each sample. */
  private readonly surface: Surface[];
  /** World distance between neighbouring samples. */
  readonly spacing: number;
  readonly texture: THREE.CanvasTexture;
  readonly roadHalf: number;
  private readonly bridgeWall: number;
  /** Height of the highest piece of road. */
  private readonly top: number;
  /**
   * Boost pads: the sample each is at, how far right of the centre line it
   * sits (some are in the middle of the road, some come as a pair either
   * side), and its centre point.
   */
  readonly boostPads: { sample: number; lane: number; x: number; z: number }[];
  /** The sample at each row of item eggs. */
  readonly itemRows: number[];
  readonly rocks: Rock[];

  // Terrain height grid.
  private readonly cols: number;
  private readonly rows: number;
  private readonly heights: Float32Array;

  constructor(
    readonly layout: Layout,
    readonly theme: Theme,
  ) {
    const waypoints = layout.waypoints;
    this.count = waypoints.length * SAMPLES_PER_WAYPOINT;
    this.xs = new Float32Array(this.count);
    this.zs = new Float32Array(this.count);
    this.at = new Float32Array(this.count);
    this.bridge = new Uint8Array(this.count);
    this.wall = new Float32Array(this.count);
    this.roadHalf = layout.roadWidth / 2;
    this.bridgeWall = this.roadHalf + 4;
    this.top = Math.max(1, ...layout.heights.map(([, h]) => h));
    this.cols = Math.ceil((layout.size[0] + MARGIN * 2) / CELL) + 1;
    this.rows = Math.ceil((layout.size[1] + MARGIN * 2) / CELL) + 1;
    this.heights = new Float32Array(this.cols * this.rows);

    // A uniform Catmull-Rom spline with tension 0.5 through the waypoints.
    const curve = new THREE.CatmullRomCurve3(
      waypoints.map(([x, y]) => new THREE.Vector3(x, 0, y)),
      true,
      'catmullrom',
      0.5,
    );
    this.spacing = curve.getLength() / this.count;
    const pts = curve.getSpacedPoints(this.count);

    // Rotate the samples so that number 0 is the start/finish line.
    const [startX, startZ] = layout.start;
    let start = 0;
    let best = Infinity;
    for (let i = 0; i < this.count; i++) {
      const d = Math.hypot(pts[i].x - startX, pts[i].z - startZ);
      if (d < best) {
        best = d;
        start = i;
      }
    }
    for (let i = 0; i < this.count; i++) {
      const src = (i + start) % this.count;
      this.xs[i] = pts[src].x;
      this.zs[i] = pts[src].z;
      this.at[i] = curve.getUtoTmapping(src / this.count, 0) * waypoints.length;
    }

    this.surface = Array.from(this.at, (w) => {
      const span = layout.surfaces.find((s) => w >= s.from && w < s.to);
      return span ? span.type : 'road';
    });

    // Bridges: every sample within half the bridge's length of its middle.
    for (const span of layout.bridges) {
      const mid = this.sampleAt(span.at);
      const reach = Math.round(span.halfLength / this.spacing);
      for (let n = -reach; n <= reach; n++) this.bridge[this.wrap(mid + n)] = 1;
    }
    for (let i = 0; i < this.count; i++) {
      // Samples to the nearest bridge sample, to taper the wall in towards the railings.
      let gap = WALL_TAPER;
      for (let n = 0; n < WALL_TAPER && gap === WALL_TAPER; n++) {
        if (this.bridge[this.wrap(i + n)] || this.bridge[this.wrap(i - n)]) gap = n;
      }
      this.wall[i] = this.bridgeWall + (WALL_DIST - this.bridgeWall) * smooth(gap / WALL_TAPER);
    }

    this.boostPads = layout.boostPads.flatMap((pad) => {
      const sample = this.sampleAt(pad.waypoint);
      return pad.lanes.map((lane) => {
        const [x, z] = this.beside(sample, lane);
        return { sample, lane, x, z };
      });
    });
    this.itemRows = layout.itemRows.map((w) => this.sampleAt(w));

    this.buildTerrain();
    this.rocks = layout.rocks.map((rock) => {
      const sample = this.sampleAt(rock.waypoint);
      const [x, z] = this.beside(sample, rock.lane);
      return { ...rock, sample, x, z, y: this.groundAt(x, z, sample) };
    });

    this.texture = canvasTexture(this.paint());
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.generateMipmaps = true;
  }

  private wrap(index: number): number {
    return ((index % this.count) + this.count) % this.count;
  }

  /** Height of the road at a point along the lap, given as a waypoint number. */
  private roadHeight(w: number): number {
    const keys = this.layout.heights;
    if (w <= keys[0][0]) return keys[0][1];
    for (let k = 1; k < keys.length; k++) {
      const [w1, h1] = keys[k];
      if (w > w1) continue;
      const [w0, h0] = keys[k - 1];
      return h0 + (h1 - h0) * smooth((w - w0) / (w1 - w0));
    }
    return keys[keys.length - 1][1];
  }

  /** Heading (radians, 0 = +x, increasing towards +z) of the track at a sample. */
  headingAt(index: number): number {
    const a = this.wrap(index);
    const b = (a + 1) % this.count;
    return Math.atan2(this.zs[b] - this.zs[a], this.xs[b] - this.xs[a]);
  }

  /** The sample nearest to a waypoint number (e.g. 4.5 = halfway from waypoint 4 to 5). */
  sampleAt(waypoint: number): number {
    let best = 0;
    for (let i = 1; i < this.count; i++) {
      if (Math.abs(this.at[i] - waypoint) < Math.abs(this.at[best] - waypoint)) best = i;
    }
    return best;
  }

  /** A point `side` units to the right of the centre line at a sample (negative = left). */
  beside(index: number, side: number): [number, number] {
    const i = this.wrap(index);
    const heading = this.headingAt(i);
    return [this.xs[i] - Math.sin(heading) * side, this.zs[i] + Math.cos(heading) * side];
  }

  /** Half the width of the driving surface at a sample. */
  private halfWidth(index: number): number {
    return this.roadHalf + (this.surface[index] === 'water' ? WATER_EXTRA : 0);
  }

  /** Height of the road surface at a sample. */
  roadY(index: number): number {
    return this.roadHeight(this.at[this.wrap(index)]);
  }

  /** How far from the centre line the soft wall is at a sample. */
  wallAt(index: number): number {
    return this.wall[this.wrap(index)];
  }

  /** Whether a sample is on a bridge deck. */
  onBridge(index: number): boolean {
    return this.bridge[this.wrap(index)] === 1;
  }

  /**
   * What is under a point. If `near` is given, only the stretch of track around
   * that sample is considered: a kart is always matched to the piece of road
   * it was just on, so it can never "jump" to another part of the lap that
   * happens to pass close by, or to the road above or below it at a bridge.
   */
  query(x: number, z: number, near = -1, window = 45): TrackQuery {
    let best = Infinity;
    let index = 0;
    const from = near < 0 ? 0 : near - window;
    const to = near < 0 ? this.count - 1 : near + window;
    for (let n = from; n <= to; n++) {
      const i = this.wrap(n);
      const dx = x - this.xs[i];
      const dz = z - this.zs[i];
      const d = dx * dx + dz * dz;
      if (d < best) {
        best = d;
        index = i;
      }
    }
    const dist = Math.sqrt(best);
    const surface: Surface = dist > this.halfWidth(index) ? 'grass' : this.surface[index];
    return { dist, index, x: this.xs[index], z: this.zs[index], surface };
  }

  /**
   * Height of whatever a kart at this point stands on, given the sample of
   * road it is on: the bridge deck if that sample is on a bridge, otherwise
   * the ground (which under a bridge is the road below).
   */
  groundAt(x: number, z: number, index: number): number {
    return this.bridge[this.wrap(index)] ? this.roadY(index) + DECK_LIFT : this.heightAt(x, z);
  }

  /** Whether a kart on the given sample of road, at this point, is on a boost pad. */
  onBoostPad(x: number, z: number, index: number): boolean {
    const reach = Math.ceil(PAD_LENGTH / this.spacing) + 1;
    for (const pad of this.boostPads) {
      let gap = Math.abs(this.wrap(index) - pad.sample);
      gap = Math.min(gap, this.count - gap);
      if (gap > reach) continue;
      // The kart's position in the pad's own frame: along the road, and across it.
      const heading = this.headingAt(pad.sample);
      const dx = x - pad.x;
      const dz = z - pad.z;
      const along = dx * Math.cos(heading) + dz * Math.sin(heading);
      const across = -dx * Math.sin(heading) + dz * Math.cos(heading);
      // A little generous across, so clipping the edge of a pad still counts.
      if (Math.abs(along) <= PAD_LENGTH / 2 && Math.abs(across) <= PAD_HALF_WIDTH + 4) return true;
    }
    return false;
  }

  /** Samples from one index forwards to another, the short way if `to` is just ahead. */
  ahead(from: number, to: number): number {
    return this.wrap(to - from);
  }

  // ---- Terrain ----------------------------------------------------------------

  private buildTerrain(): void {
    const { cols, rows, heights } = this;
    const base = new Float32Array(cols * rows);
    const dist = new Float32Array(cols * rows);

    // Every point of ground starts at the height of the nearest piece of road
    // (ignoring bridges, which are in the air: the ground under one belongs to
    // the road below). Where two parts of the lap at different heights meet,
    // that makes a cliff.
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * CELL - MARGIN;
        const z = r * CELL - MARGIN;
        let best = Infinity;
        let nearest = 0;
        for (let i = 0; i < this.count; i++) {
          if (this.bridge[i]) continue;
          const dx = x - this.xs[i];
          const dz = z - this.zs[i];
          const d = dx * dx + dz * dz;
          if (d < best) {
            best = d;
            nearest = i;
          }
        }
        // Fade to flat towards the outer edge, where the terrain meets the plain beyond.
        const edge = Math.min(c, cols - 1 - c, r, rows - 1 - r) * CELL;
        base[r * cols + c] = this.heightBeside(x, z, nearest) * smooth(edge / 140);
        dist[r * cols + c] = Math.sqrt(best);
      }
    }

    // Soften those cliffs into slopes...
    let a = Float32Array.from(base);
    let b = new Float32Array(cols * rows);
    for (let pass = 0; pass < 4; pass++) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const l = Math.max(0, c - 1);
          const rt = Math.min(cols - 1, c + 1);
          const u = Math.max(0, r - 1);
          const d = Math.min(rows - 1, r + 1);
          b[r * cols + c] =
            (a[r * cols + c] * 2 + a[r * cols + l] + a[r * cols + rt] + a[u * cols + c] + a[d * cols + c]) / 6;
        }
      }
      [a, b] = [b, a];
    }
    // ...except on and beside the road itself, which keeps its exact height:
    // level across its width, and a sharp drop at a waterfall.
    for (let i = 0; i < heights.length; i++) {
      const keep = 1 - smooth((dist[i] - (WALL_DIST + 4)) / 30);
      heights[i] = a[i] + (base[i] - a[i]) * keep;
    }
  }

  /**
   * The road's height level with a point, given the sample nearest to it. The
   * point is slid along the road between that sample and its neighbours, so
   * the height changes smoothly up a slope instead of in one step per sample
   * (which made climbs bumpy to drive).
   */
  private heightBeside(x: number, z: number, nearest: number): number {
    let w = this.at[nearest];
    let bestGap = Infinity;
    for (const other of [this.wrap(nearest - 1), this.wrap(nearest + 1)]) {
      // Skip the join where waypoint numbers wrap round; the road is level there anyway.
      if (Math.abs(this.at[other] - this.at[nearest]) > 1) continue;
      const sx = this.xs[other] - this.xs[nearest];
      const sz = this.zs[other] - this.zs[nearest];
      const t = Math.max(
        0,
        Math.min(1, ((x - this.xs[nearest]) * sx + (z - this.zs[nearest]) * sz) / (sx * sx + sz * sz)),
      );
      const gap = Math.hypot(x - (this.xs[nearest] + sx * t), z - (this.zs[nearest] + sz * t));
      if (gap < bestGap) {
        bestGap = gap;
        w = this.at[nearest] + (this.at[other] - this.at[nearest]) * t;
      }
    }
    return this.roadHeight(w);
  }

  /** Height of the ground at any point. */
  heightAt(x: number, z: number): number {
    const { cols, rows, heights } = this;
    const gx = Math.max(0, Math.min(cols - 1.001, (x + MARGIN) / CELL));
    const gz = Math.max(0, Math.min(rows - 1.001, (z + MARGIN) / CELL));
    const c = Math.floor(gx);
    const r = Math.floor(gz);
    const fx = gx - c;
    const fz = gz - r;
    const i = r * cols + c;
    const top = heights[i] + (heights[i + 1] - heights[i]) * fx;
    const bottom = heights[i + cols] + (heights[i + cols + 1] - heights[i + cols]) * fx;
    return top + (bottom - top) * fz;
  }

  /** The middle of the map, for placing the plain around it. */
  get centre(): { x: number; z: number } {
    return { x: this.layout.size[0] / 2, z: this.layout.size[1] / 2 };
  }

  // ---- Meshes -----------------------------------------------------------------

  /** The ground: the height grid as a mesh, with the painted texture draped over it. */
  makeGround(): THREE.Mesh {
    const { cols, rows, heights } = this;
    const positions = new Float32Array(cols * rows * 3);
    const uvs = new Float32Array(cols * rows * 2);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        positions[i * 3] = c * CELL - MARGIN;
        positions[i * 3 + 1] = heights[i];
        positions[i * 3 + 2] = r * CELL - MARGIN;
        uvs[i * 2] = c / (cols - 1);
        uvs[i * 2 + 1] = 1 - r / (rows - 1);
      }
    }
    const indices: number[] = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const i = r * cols + c;
        indices.push(i, i + cols, i + 1, i + 1, i + cols, i + cols + 1);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: this.texture }));
  }

  /**
   * A strip of quads following a run of consecutive samples. For each sample,
   * `edge` gives the two points of the strip's cross-section (each x, y, z).
   * The texture runs along the strip, repeating every `tile` world units.
   */
  private strip(
    from: number,
    steps: number,
    tile: number,
    edge: (index: number) => [number, number, number, number, number, number],
  ): THREE.BufferGeometry {
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    for (let n = 0; n <= steps; n++) {
      const e = edge(this.wrap(from + n));
      positions.push(e[0], e[1], e[2], e[3], e[4], e[5]);
      const along = (n * this.spacing) / tile;
      uvs.push(along, 0, along, 1);
      if (n < steps) {
        const i = n * 2;
        indices.push(i, i + 1, i + 2, i + 2, i + 1, i + 3);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    return geometry;
  }

  /** Runs of consecutive samples for which `test` is true, as [first sample, number of steps]. */
  private runs(test: (index: number) => boolean): [number, number][] {
    // Start scanning from a sample that fails, so no run is split by the wrap-around.
    let offset = 0;
    while (offset < this.count && test(offset)) offset++;
    if (offset === this.count) return [[0, this.count]];
    const found: [number, number][] = [];
    let begin = -1;
    for (let n = 0; n <= this.count; n++) {
      const i = this.wrap(offset + n);
      const ok = n < this.count && test(i);
      if (ok && begin < 0) begin = n;
      if (!ok && begin >= 0) {
        found.push([this.wrap(offset + begin), n - 1 - begin]);
        begin = -1;
      }
    }
    return found.filter(([, steps]) => steps > 0);
  }

  /** A fence panel: a post, then two rails running on to the next post. */
  private fenceTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    const plank = (x: number, y: number, w: number, h: number) => {
      ctx.fillStyle = '#5a3716';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#b07a3f';
      ctx.fillRect(x + 2, y + 2, w - 4, h - 4);
      ctx.fillStyle = 'rgba(255, 225, 170, 0.35)';
      ctx.fillRect(x + 2, y + 2, w - 4, 3);
    };
    plank(-2, 14, 68, 13); // rails run edge to edge, so panels join up
    plank(-2, 36, 68, 13);
    plank(22, 2, 18, 62); // post
    const tex = canvasTexture(canvas, true);
    tex.magFilter = THREE.NearestFilter;
    return tex;
  }

  /**
   * Wooden fences along both sides of the road, on the line of the soft wall.
   * Left off rivers and waterfalls; on a bridge they are its railings.
   */
  makeFences(): THREE.Object3D {
    const group = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({
      map: this.fenceTexture(),
      alphaTest: 0.5,
      side: THREE.DoubleSide,
    });
    for (const [from, steps] of this.runs((i) => this.surface[i] !== 'water')) {
      for (const side of [-1, 1]) {
        const geometry = this.strip(from, steps, FENCE_PANEL, (i) => {
          const [x, z] = this.beside(i, side * this.wall[i]);
          const y = this.bridge[i] ? this.roadY(i) + DECK_LIFT : this.heightAt(x, z);
          return [x, y, z, x, y + FENCE_HEIGHT, z];
        });
        group.add(new THREE.Mesh(geometry, material));
      }
    }
    return group;
  }

  /** The bridges: a plank deck over the road below, with a pillar near each corner. */
  makeBridges(): THREE.Object3D {
    const group = new THREE.Group();

    const planks = document.createElement('canvas');
    planks.width = 32;
    planks.height = 64;
    const ctx = planks.getContext('2d')!;
    ctx.fillStyle = '#b98148';
    ctx.fillRect(0, 0, 32, 64);
    ctx.fillStyle = '#6b4526';
    ctx.fillRect(0, 0, 3, 64); // gap between planks
    ctx.fillStyle = 'rgba(255, 230, 180, 0.25)';
    ctx.fillRect(3, 0, 4, 64);
    ctx.fillStyle = '#8a5a30';
    ctx.fillRect(0, 0, 32, 5); // darker edge beams
    ctx.fillRect(0, 59, 32, 5);
    const deckMaterial = new THREE.MeshBasicMaterial({ map: canvasTexture(planks, true), side: THREE.DoubleSide });
    const pillar = new THREE.BoxGeometry(7, 1, 7);
    const wood = new THREE.MeshBasicMaterial({ color: 0x6b4526 });

    for (const [from, steps] of this.runs((i) => this.bridge[i] === 1)) {
      const deck = this.strip(from, steps, 9, (i) => {
        const [lx, lz] = this.beside(i, -this.bridgeWall);
        const [rx, rz] = this.beside(i, this.bridgeWall);
        const y = this.roadY(i) + DECK_LIFT;
        return [lx, y, lz, rx, y, rz];
      });
      group.add(new THREE.Mesh(deck, deckMaterial));

      // Pillars either side of the road below, under the deck.
      const mid = this.wrap(from + Math.round(steps / 2));
      const out = Math.round((this.roadHalf + WATER_EXTRA + 14) / this.spacing);
      for (const along of [-out, out]) {
        for (const side of [-1, 1]) {
          const i = this.wrap(mid + along);
          const [x, z] = this.beside(i, side * (this.bridgeWall - 4));
          const bottom = this.heightAt(x, z);
          const top = this.roadY(i);
          const post = new THREE.Mesh(pillar, wood);
          post.scale.y = top - bottom;
          post.position.set(x, (top + bottom) / 2, z);
          group.add(post);
        }
      }
    }
    return group;
  }

  /**
   * Moving water, on tracks that have any: a rippling surface on rivers and
   * white water pouring down a waterfall. Call `update` with the time each frame.
   */
  makeWater(): { object: THREE.Object3D; update: (time: number) => void } {
    const group = new THREE.Group();
    const rand = makeRng(5);
    const scrolling: [THREE.Texture, number][] = [];

    // Both lie just above the ground. The strip's texture runs along the flow.
    const surface = (half: number, lift: number) => (i: number) => {
      const [lx, lz] = this.beside(i, -half);
      const [rx, rz] = this.beside(i, half);
      const y = this.roadY(i) + lift;
      return [lx, y, lz, rx, y, rz] as [number, number, number, number, number, number];
    };
    const waterHalf = this.roadHalf + WATER_EXTRA;

    const rivers = this.runs((i) => this.surface[i] === 'water');
    if (rivers.length) {
      // See-through ripples that drift downstream over the painted water.
      const ripple = document.createElement('canvas');
      ripple.width = ripple.height = 128;
      const ctx = ripple.getContext('2d')!;
      ctx.lineCap = 'round';
      for (let n = 0; n < 26; n++) {
        const x = rand() * 128;
        const y = rand() * 128;
        const length = 10 + rand() * 22;
        ctx.strokeStyle = `rgba(255, 255, 255, ${0.25 + rand() * 0.45})`;
        ctx.lineWidth = 1.5 + rand() * 2.5;
        // Drawn again one tile over wherever it crosses an edge, so the tile repeats cleanly.
        for (const ox of [-128, 0, 128]) {
          ctx.beginPath();
          ctx.moveTo(x + ox, y);
          ctx.quadraticCurveTo(x + ox + length / 2, y - 4, x + ox + length, y);
          ctx.stroke();
        }
      }
      const rippleTex = canvasTexture(ripple, true);
      scrolling.push([rippleTex, 0.55]);
      const material = new THREE.MeshBasicMaterial({ map: rippleTex, transparent: true, depthWrite: false });
      for (const [from, steps] of rivers) {
        group.add(new THREE.Mesh(this.strip(from, steps, 60, surface(waterHalf, 0.35)), material));
      }
    }

    const falls = this.layout.waterfall;
    if (falls) {
      // Solid streaks of white and pale blue.
      const streak = document.createElement('canvas');
      streak.width = streak.height = 64;
      const ctx = streak.getContext('2d')!;
      ctx.fillStyle = '#bfeaff';
      ctx.fillRect(0, 0, 64, 64);
      for (let n = 0; n < 30; n++) {
        ctx.fillStyle = rand() < 0.6 ? 'rgba(255, 255, 255, 0.9)' : 'rgba(110, 200, 245, 0.8)';
        const y = rand() * 64;
        const h = 2 + rand() * 5;
        const x = rand() * 64;
        const w = 16 + rand() * 30;
        for (const ox of [-64, 0, 64]) ctx.fillRect(x + ox, y, w, h);
      }
      const streakTex = canvasTexture(streak, true);
      scrolling.push([streakTex, 2.4]);
      const from = this.sampleAt(falls.from);
      group.add(
        new THREE.Mesh(
          this.strip(from, this.ahead(from, this.sampleAt(falls.to)), 26, surface(waterHalf, 0.7)),
          new THREE.MeshBasicMaterial({ map: streakTex }),
        ),
      );
    }

    return {
      object: group,
      update(time) {
        // A texture's first axis runs along the flow; sliding it backwards moves the water forwards.
        for (const [tex, speed] of scrolling) tex.offset.x = -(time * speed) % 1;
      },
    };
  }

  // ---- Painting ---------------------------------------------------------------

  /** A path along the centre line from a sample, for a number of steps. */
  private path(from: number, steps: number): Path2D {
    const path = new Path2D();
    path.moveTo(this.xs[from], this.zs[from]);
    for (let n = 1; n <= steps; n++) {
      const i = this.wrap(from + n);
      path.lineTo(this.xs[i], this.zs[i]);
    }
    return path;
  }

  private paint(): HTMLCanvasElement {
    const { cols, rows, heights, theme, roadHalf } = this;
    const canvas = document.createElement('canvas');
    // The canvas covers exactly the area of the height grid.
    const spanX = (cols - 1) * CELL;
    const spanZ = (rows - 1) * CELL;
    canvas.width = Math.round(spanX * TEXTURE_SCALE);
    canvas.height = Math.round(spanZ * TEXTURE_SCALE);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(canvas.width / spanX, canvas.height / spanZ);
    ctx.translate(MARGIN, MARGIN);

    const pattern = (spec: Mottle, size: number, seed: number) =>
      ctx.createPattern(mottle(size, spec, seed), 'repeat')!;
    const rand = makeRng(11);

    ctx.fillStyle = pattern(theme.ground, 96, 1);
    ctx.fillRect(-MARGIN, -MARGIN, spanX, spanZ);

    // Ground cover by height and steepness: high ground is tinted, and
    // anything steep is bare cliff.
    const [cr, cg, cb] = theme.cliff;
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const i = r * cols + c;
        const h = heights[i];
        const slope = Math.hypot(heights[i + 1] - h, heights[i + cols] - h) / CELL;
        const x = c * CELL - MARGIN;
        const z = r * CELL - MARGIN;
        if (h > 1) {
          ctx.fillStyle = `rgba(${theme.highTint}, ${(0.2 * h) / this.top})`;
          ctx.fillRect(x, z, CELL + 0.5, CELL + 0.5);
        }
        if (slope > 0.22) {
          const shade = 0.85 + rand() * 0.3;
          ctx.fillStyle = `rgba(${cr * shade}, ${cg * shade}, ${cb * shade}, ${Math.min(1, (slope - 0.22) * 4)})`;
          ctx.fillRect(x - 1, z - 1, CELL + 2, CELL + 2);
        }
      }
    }

    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    const stroke = (path: Path2D, style: string | CanvasPattern, width: number, dash: number[] = []) => {
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.stroke(path);
    };

    // The road, in one unbroken pass: everything except the bridges, whose
    // decks are in the air and have another road on the ground beneath them.
    const road = pattern(theme.road, 64, 2);
    for (const [from, steps] of this.runs((i) => !this.bridge[i])) {
      const path = this.path(from, steps);
      stroke(path, 'rgba(40, 40, 40, 0.3)', roadHalf * 2 + 12); // soft shadow at the edge
      stroke(path, theme.roadRim, roadHalf * 2 + 5);
      stroke(path, road, roadHalf * 2);
      stroke(path, theme.dashes, 3, [16, 26]); // centre dashes
    }

    // Stretches of water, ice and frozen lake, painted over the road.
    const special: [Surface, Mottle, string, number][] = [
      ['water', WATER, '#1f7fb5', 3],
      ['ice', ICE, '#e9faff', 4],
      ['lake', LAKE, '#f2fffd', 5],
    ];
    for (const [type, spec, rim, seed] of special) {
      const fill = pattern(spec, 64, seed);
      for (const [from, steps] of this.runs((i) => this.surface[i] === type && !this.bridge[i])) {
        const half = this.halfWidth(from);
        const path = this.path(from, steps);
        // Rivers get rounded ends and a dark bank; ice and lakes a pale frosty rim, cut square.
        ctx.lineCap = type === 'water' ? 'round' : 'butt';
        stroke(path, rim, half * 2 + (type === 'water' ? 7 : 0));
        stroke(path, fill, half * 2 - (type === 'water' ? 0 : 6));
        ctx.lineCap = 'butt';
        if (type === 'water') continue;
        // Cracks and shine, so ice reads as ice.
        ctx.setLineDash([]);
        ctx.lineCap = 'round';
        for (let n = 0; n < steps * 0.9; n++) {
          const [x, z] = this.beside(this.wrap(from + Math.floor(rand() * steps)), (rand() * 2 - 1) * (half - 8));
          let angle = rand() * Math.PI * 2;
          ctx.strokeStyle = `rgba(255, 255, 255, ${0.35 + rand() * 0.45})`;
          ctx.lineWidth = 0.8 + rand() * 1.2;
          ctx.beginPath();
          ctx.moveTo(x, z);
          let px = x;
          let pz = z;
          for (let k = 0; k < 3; k++) {
            angle += (rand() - 0.5) * 1.4;
            px += Math.cos(angle) * (4 + rand() * 7);
            pz += Math.sin(angle) * (4 + rand() * 7);
            ctx.lineTo(px, pz);
          }
          ctx.stroke();
        }
        ctx.lineCap = 'butt';
      }
    }

    // The shadow of each bridge on the road below it.
    for (const [from, steps] of this.runs((i) => this.bridge[i] === 1)) {
      stroke(this.path(from, steps), 'rgba(10, 30, 60, 0.28)', this.bridgeWall * 2 + 6);
    }

    // Foam where a waterfall lands.
    if (this.layout.waterfall) {
      const landing = this.sampleAt(this.layout.waterfall.foamAt);
      for (let n = 0; n < 26; n++) {
        const angle = rand() * Math.PI * 2;
        const reach = rand() * roadHalf;
        ctx.fillStyle = `rgba(255, 255, 255, ${0.55 + rand() * 0.4})`;
        ctx.beginPath();
        ctx.arc(
          this.xs[landing] + Math.cos(angle) * reach,
          this.zs[landing] + Math.sin(angle) * reach * 1.3,
          4 + rand() * 9,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
    }
    ctx.setLineDash([]);

    /** Draw something at a sample, turned to face along the track (x = forwards, y = to the right). */
    const along = (index: number, draw: () => void) => {
      ctx.save();
      ctx.translate(this.xs[index], this.zs[index]);
      ctx.rotate(this.headingAt(index));
      draw();
      ctx.restore();
    };
    const chevrons = (color: string, width: number, reach: number, offsets: number[]) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const offset of offsets) {
        ctx.beginPath();
        ctx.moveTo(offset - reach * 0.55, -reach);
        ctx.lineTo(offset + reach * 0.55, 0);
        ctx.lineTo(offset - reach * 0.55, reach);
        ctx.stroke();
      }
    };

    // Trails of three-toed dinosaur footprints beside the road.
    for (const trail of this.layout.footprints) {
      const from = this.sampleAt(trail.from);
      const steps = this.ahead(from, this.sampleAt(trail.to));
      const stride = Math.max(1, Math.round(26 / this.spacing));
      for (let n = 0, foot = 1; n <= steps; n += stride, foot = -foot) {
        along(this.wrap(from + n), () => {
          ctx.translate(0, trail.lane + foot * 7);
          ctx.fillStyle = 'rgba(70, 95, 130, 0.38)';
          ctx.beginPath();
          ctx.ellipse(-2, 0, 5, 4.5, 0, 0, Math.PI * 2); // heel
          for (const toe of [-0.55, 0, 0.55]) {
            ctx.ellipse(6 * Math.cos(toe), 6 * Math.sin(toe), 5, 2.2, toe, 0, Math.PI * 2);
          }
          ctx.fill();
        });
      }
    }

    // Arrows on the road showing the way.
    for (const waypoint of this.layout.arrows) {
      along(this.sampleAt(waypoint), () => chevrons('rgba(255, 215, 60, 0.92)', 6, 15, [-9, 9]));
    }

    // Boost pads: a slim orange panel with three yellow arrows inside it.
    for (const pad of this.boostPads) {
      along(pad.sample, () => {
        ctx.translate(0, pad.lane);
        const edge = 2.5;
        ctx.fillStyle = '#3b2414';
        ctx.beginPath();
        ctx.roundRect(
          -PAD_LENGTH / 2 - edge,
          -PAD_HALF_WIDTH - edge,
          PAD_LENGTH + edge * 2,
          PAD_HALF_WIDTH * 2 + edge * 2,
          5,
        );
        ctx.fill();
        ctx.fillStyle = '#ff8a1f';
        ctx.beginPath();
        ctx.roundRect(-PAD_LENGTH / 2, -PAD_HALF_WIDTH, PAD_LENGTH, PAD_HALF_WIDTH * 2, 3);
        ctx.fill();
        // Each arrow is 2 * reach tall and about reach wide, so three fit inside with a margin.
        chevrons('#ffe94a', 3.5, PAD_HALF_WIDTH - 4.5, [-8.5, 0, 8.5]);
      });
    }

    // Chequered start/finish line across the road at sample 0.
    const sq = 8;
    const squares = Math.round((roadHalf * 2) / sq);
    along(0, () => {
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < squares; c++) {
          ctx.fillStyle = (r + c) % 2 === 0 ? '#ffffff' : '#1c1c22';
          ctx.fillRect(r * sq - sq, c * sq - roadHalf, sq, sq);
        }
      }
    });

    return canvas;
  }
}

/**
 * A small tileable texture: a base colour with soft blotches of nearby
 * colours. Blotches that cross an edge are repeated on the far side so the
 * tile has no visible seam.
 */
function mottle(size: number, spec: Mottle, seed: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rand = makeRng(seed);
  ctx.fillStyle = spec.base;
  ctx.fillRect(0, 0, size, size);
  ctx.globalAlpha = 0.45;
  for (let i = 0; i < spec.blotches; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = spec.minR + rand() * (spec.maxR - spec.minR);
    ctx.fillStyle = spec.tints[Math.floor(rand() * spec.tints.length)];
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        ctx.beginPath();
        ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  return canvas;
}
