import * as THREE from 'three';
import { makeRng } from './rng';
import LAYOUT from './tracks/dino-falls.json';

/**
 * The track: Dino Falls.
 *
 * Everything comes from the waypoints and features in tracks/dino-falls.json:
 * the centre line, which parts are dirt and which are shallow water, how high
 * each part is, and where the bridge, boost pads and item rows go. From that
 * one definition we build the terrain, paint its texture, build the fences,
 * bridge and water, and answer "what is under this point", so the picture and
 * the physics can never disagree.
 *
 * World units are the layout's own units: layout point (x, y) is world (x, z),
 * with height as world y. The lap runs in waypoint order and is a figure of
 * eight: the high road crosses over the river on the bridge.
 */

const WAYPOINTS = LAYOUT.track.waypoints;
const FEATURES = LAYOUT.track.features;
const MAP_W = LAYOUT.coordinate_system.width;
const MAP_H = LAYOUT.coordinate_system.height;
const SAMPLES_PER_WAYPOINT = 24;

export const ROAD_HALF = LAYOUT.track.nominal_dirt_width_px / 2;
const WATER_HALF = LAYOUT.track.nominal_water_width_px / 2;
/** Soft wall, marked by the fences: how far from the centre line a kart may stray. */
export const WALL_DIST = 64;
/** On the bridge the wall is the railing, just outside the road. */
const BRIDGE_WALL = ROAD_HALF + 4;
/** The walls narrow from one to the other over this many samples either side of the bridge. */
const WALL_TAPER = 16;

/** Height of the upper level above the start line. */
const HIGH = 42;
// Where things happen, in waypoint numbers (5.5 = halfway from waypoint 5 to 6).
const CLIMB_FROM = FEATURES.climb_from_waypoint;
const CLIMB_TO = FEATURES.climb_to_waypoint;
const LIP = FEATURES.waterfall_lip_waypoint;
/** The cliff the waterfall pours over: the ground drops away between these two points. */
const CLIFF_FROM = LIP + 0.25;
const CLIFF_TO = LIP + 0.5;
/** The stream that feeds the falls starts a little before the lip... */
const WATER_FROM = LIP - 0.6;
/** ...and the river hands back to dirt just past this waypoint. */
const WATER_TO = FEATURES.river_ends_waypoint + 0.15;

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

/** Average grass colour, for the plain ground beyond the edge of the terrain. */
export const GRASS = '#4bb04a';

export type Surface = 'road' | 'water' | 'grass';

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

const smooth = (t: number) => {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
};

/** Height of the road at a point along the lap, given as a waypoint number. */
function roadHeight(w: number): number {
  if (w < CLIMB_FROM) return 0;
  if (w < CLIMB_TO) return HIGH * smooth((w - CLIMB_FROM) / (CLIMB_TO - CLIMB_FROM));
  if (w < CLIFF_FROM) return HIGH;
  if (w < CLIFF_TO) return HIGH * (1 - smooth((w - CLIFF_FROM) / (CLIFF_TO - CLIFF_FROM)));
  return 0;
}

function canvasTexture(canvas: HTMLCanvasElement, repeat = false): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

export class Track {
  readonly count = WAYPOINTS.length * SAMPLES_PER_WAYPOINT;
  /** Evenly spaced centre-line samples. Sample 0 is the start/finish line. */
  readonly xs = new Float32Array(this.count);
  readonly zs = new Float32Array(this.count);
  /** Which waypoint each sample is at (fractional), for looking up height and surface. */
  private readonly at = new Float32Array(this.count);
  /** Whether each sample is on the bridge deck. */
  private readonly bridge = new Uint8Array(this.count);
  /** How far from the centre line the soft wall is at each sample. */
  private readonly wall = new Float32Array(this.count);
  /** World distance between neighbouring samples. */
  readonly spacing: number;
  readonly texture: THREE.CanvasTexture;
  /**
   * Boost pads: the sample each is at, how far right of the centre line it
   * sits (some are in the middle of the road, some come as a pair either
   * side), and its centre point.
   */
  readonly boostPads: { sample: number; lane: number; x: number; z: number }[];
  /** The sample at each row of item eggs. */
  readonly itemRows: number[];

  // Terrain height grid.
  private readonly cols = Math.ceil((MAP_W + MARGIN * 2) / CELL) + 1;
  private readonly rows = Math.ceil((MAP_H + MARGIN * 2) / CELL) + 1;
  private readonly heights = new Float32Array(this.cols * this.rows);

  constructor() {
    // A uniform Catmull-Rom spline with tension 0.5 through the waypoints.
    const curve = new THREE.CatmullRomCurve3(
      WAYPOINTS.map((w) => new THREE.Vector3(w.x, 0, w.y)),
      true,
      'catmullrom',
      0.5,
    );
    this.spacing = curve.getLength() / this.count;
    const pts = curve.getSpacedPoints(this.count);

    // Rotate the samples so that number 0 is the start/finish line.
    const [startX, startZ] = LAYOUT.track.start_finish.centre;
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
      this.at[i] = curve.getUtoTmapping(src / this.count, 0) * WAYPOINTS.length;
    }

    // The bridge: every sample within half its length of the middle.
    const mid = this.sampleAt(FEATURES.bridge_waypoint);
    const reach = Math.round(FEATURES.bridge_half_length / this.spacing);
    for (let n = -reach; n <= reach; n++) this.bridge[this.wrap(mid + n)] = 1;
    for (let i = 0; i < this.count; i++) {
      // Samples to the nearest bridge sample, to taper the wall in towards the railings.
      let gap = WALL_TAPER;
      for (let n = 0; n < WALL_TAPER && gap === WALL_TAPER; n++) {
        if (this.bridge[this.wrap(i + n)] || this.bridge[this.wrap(i - n)]) gap = n;
      }
      this.wall[i] = BRIDGE_WALL + (WALL_DIST - BRIDGE_WALL) * smooth(gap / WALL_TAPER);
    }

    this.boostPads = FEATURES.boost_pads.flatMap((pad) => {
      const sample = this.sampleAt(pad.waypoint);
      return pad.lanes.map((lane) => {
        const [x, z] = this.beside(sample, lane);
        return { sample, lane, x, z };
      });
    });
    this.itemRows = FEATURES.item_row_waypoints.map((w) => this.sampleAt(w));

    this.buildTerrain();
    this.texture = canvasTexture(this.paint());
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.generateMipmaps = true;
  }

  private wrap(index: number): number {
    return ((index % this.count) + this.count) % this.count;
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

  private isWater(index: number): boolean {
    const w = this.at[index];
    return w >= WATER_FROM && w < WATER_TO;
  }

  /** Height of the road surface at a sample. */
  roadY(index: number): number {
    return roadHeight(this.at[this.wrap(index)]);
  }

  /** How far from the centre line the soft wall is at a sample. */
  wallAt(index: number): number {
    return this.wall[this.wrap(index)];
  }

  /**
   * What is under a point. If `near` is given, only the stretch of track around
   * that sample is considered: a kart is always matched to the piece of road
   * it was just on, so it can never "jump" to another part of the lap that
   * happens to pass close by, or to the road above or below it at the bridge.
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
    const water = this.isWater(index);
    const surface: Surface = dist > (water ? WATER_HALF : ROAD_HALF) ? 'grass' : water ? 'water' : 'road';
    return { dist, index, x: this.xs[index], z: this.zs[index], surface };
  }

  /**
   * Height of whatever a kart at this point stands on, given the sample of
   * road it is on: the bridge deck if that sample is on the bridge, otherwise
   * the ground (which under the bridge is the river).
   */
  groundAt(x: number, z: number, index: number): number {
    return this.bridge[this.wrap(index)] ? this.roadY(index) : this.heightAt(x, z);
  }

  /** Whether a sample is on the bridge deck. */
  onBridge(index: number): boolean {
    return this.bridge[this.wrap(index)] === 1;
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

  // ---- Terrain ----------------------------------------------------------------

  private buildTerrain(): void {
    const { cols, rows, heights } = this;
    const base = new Float32Array(cols * rows);
    const dist = new Float32Array(cols * rows);

    // Every point of ground starts at the height of the nearest piece of road
    // (ignoring the bridge, which is in the air: the ground under it belongs to
    // the river). Where two parts of the lap at different heights meet, that
    // makes a cliff.
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
    // level across its width, and a sharp drop at the waterfall.
    for (let i = 0; i < heights.length; i++) {
      const keep = 1 - smooth((dist[i] - (WALL_DIST + 4)) / 30);
      heights[i] = a[i] + (base[i] - a[i]) * keep;
    }
  }

  /**
   * The road's height level with a point, given the sample nearest to it. The
   * point is slid along the road between that sample and its neighbours, so
   * the height changes smoothly up a slope instead of in one step per sample
   * (which made the climb bumpy to drive).
   */
  private heightBeside(x: number, z: number, nearest: number): number {
    let w = this.at[nearest];
    let bestGap = Infinity;
    for (const other of [this.wrap(nearest - 1), this.wrap(nearest + 1)]) {
      // Skip the join where waypoint numbers wrap round; the road is level there anyway.
      if (Math.abs(this.at[other] - this.at[nearest]) > 1) continue;
      const sx = this.xs[other] - this.xs[nearest];
      const sz = this.zs[other] - this.zs[nearest];
      const t = Math.max(0, Math.min(1, ((x - this.xs[nearest]) * sx + (z - this.zs[nearest]) * sz) / (sx * sx + sz * sz)));
      const gap = Math.hypot(x - (this.xs[nearest] + sx * t), z - (this.zs[nearest] + sz * t));
      if (gap < bestGap) {
        bestGap = gap;
        w = this.at[nearest] + (this.at[other] - this.at[nearest]) * t;
      }
    }
    return roadHeight(w);
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
    return { x: MAP_W / 2, z: MAP_H / 2 };
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
   * Left off the river and the waterfall, and the bridge has railings instead.
   */
  makeFences(): THREE.Object3D {
    const group = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({
      map: this.fenceTexture(),
      alphaTest: 0.5,
      side: THREE.DoubleSide,
    });
    const fenced = (i: number) => !this.isWater(i);
    for (const [from, steps] of this.runs(fenced)) {
      for (const side of [-1, 1]) {
        const geometry = this.strip(from, steps, FENCE_PANEL, (i) => {
          const [x, z] = this.beside(i, side * this.wall[i]);
          const y = this.bridge[i] ? this.roadY(i) : this.heightAt(x, z);
          return [x, y, z, x, y + FENCE_HEIGHT, z];
        });
        group.add(new THREE.Mesh(geometry, material));
      }
    }
    return group;
  }

  /** The bridge: a plank deck across the river, with a pillar at each corner of the span. */
  makeBridge(): THREE.Object3D {
    const group = new THREE.Group();
    const [[from, steps]] = this.runs((i) => this.bridge[i] === 1);

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
    const deck = new THREE.Mesh(
      this.strip(from, steps, 9, (i) => {
        const [lx, lz] = this.beside(i, -BRIDGE_WALL);
        const [rx, rz] = this.beside(i, BRIDGE_WALL);
        const y = this.roadY(i);
        return [lx, y, lz, rx, y, rz];
      }),
      new THREE.MeshBasicMaterial({ map: canvasTexture(planks, true), side: THREE.DoubleSide }),
    );
    group.add(deck);

    // Pillars either side of the river, under the deck.
    const pillar = new THREE.BoxGeometry(7, 1, 7);
    const wood = new THREE.MeshBasicMaterial({ color: 0x6b4526 });
    const mid = this.wrap(from + Math.round(steps / 2));
    const out = Math.round((WATER_HALF + 14) / this.spacing);
    for (const along of [-out, out]) {
      for (const side of [-1, 1]) {
        const i = this.wrap(mid + along);
        const [x, z] = this.beside(i, side * (BRIDGE_WALL - 4));
        const bottom = this.heightAt(x, z);
        const top = this.roadY(i);
        const post = new THREE.Mesh(pillar, wood);
        post.scale.y = top - bottom;
        post.position.set(x, (top + bottom) / 2, z);
        group.add(post);
      }
    }
    return group;
  }

  /**
   * Moving water: a rippling surface on the river and white water pouring down
   * the falls. Call `update` with the time each frame.
   */
  makeWater(): { object: THREE.Object3D; update: (time: number) => void } {
    const group = new THREE.Group();
    const rand = makeRng(5);

    // River: see-through ripples that drift downstream over the painted water.
    const ripple = document.createElement('canvas');
    ripple.width = ripple.height = 128;
    let ctx = ripple.getContext('2d')!;
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

    // Falls: solid streaks of white and pale blue.
    const streak = document.createElement('canvas');
    streak.width = streak.height = 64;
    ctx = streak.getContext('2d')!;
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

    // Both lie just above the ground. The strip's texture runs along the flow.
    const surface = (lift: number) => (i: number) => {
      const [lx, lz] = this.beside(i, -WATER_HALF);
      const [rx, rz] = this.beside(i, WATER_HALF);
      const y = this.roadY(i) + lift;
      return [lx, y, lz, rx, y, rz] as [number, number, number, number, number, number];
    };
    const riverFrom = this.sampleAt(WATER_FROM);
    const riverSteps = this.wrap(this.sampleAt(WATER_TO) - riverFrom);
    group.add(
      new THREE.Mesh(
        this.strip(riverFrom, riverSteps, 60, surface(0.35)),
        new THREE.MeshBasicMaterial({ map: rippleTex, transparent: true, depthWrite: false }),
      ),
    );
    const fallsFrom = this.sampleAt(CLIFF_FROM - 0.14);
    const fallsSteps = this.wrap(this.sampleAt(CLIFF_TO + 0.12) - fallsFrom);
    group.add(
      new THREE.Mesh(
        this.strip(fallsFrom, fallsSteps, 26, surface(0.7)),
        new THREE.MeshBasicMaterial({ map: streakTex }),
      ),
    );

    return {
      object: group,
      update(time) {
        // The texture's first axis runs along the flow; sliding it backwards moves the water forwards.
        rippleTex.offset.x = -(time * 0.55) % 1;
        rippleTex.offset.y = Math.sin(time * 0.7) * 0.04;
        streakTex.offset.x = -(time * 2.4) % 1;
      },
    };
  }

  // ---- Painting ---------------------------------------------------------------

  /** A path along the centre line between two samples. */
  private path(from: number, steps: number): Path2D {
    const path = new Path2D();
    path.moveTo(this.xs[from], this.zs[from]);
    for (let n = 1; n <= steps; n++) {
      const i = this.wrap(from + n);
      path.lineTo(this.xs[i], this.zs[i]);
    }
    return path;
  }

  private pathBetween(fromWaypoint: number, toWaypoint: number): Path2D {
    const from = this.sampleAt(fromWaypoint);
    return this.path(from, this.wrap(this.sampleAt(toWaypoint) - from));
  }

  private paint(): HTMLCanvasElement {
    const { cols, rows, heights } = this;
    const canvas = document.createElement('canvas');
    // The canvas covers exactly the area of the height grid.
    const spanX = (cols - 1) * CELL;
    const spanZ = (rows - 1) * CELL;
    canvas.width = Math.round(spanX * TEXTURE_SCALE);
    canvas.height = Math.round(spanZ * TEXTURE_SCALE);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(canvas.width / spanX, canvas.height / spanZ);
    ctx.translate(MARGIN, MARGIN);

    const pattern = (tile: HTMLCanvasElement) => ctx.createPattern(tile, 'repeat')!;
    const grass = pattern(mottle(96, GRASS, ['#5cc257', '#3f9c41', '#55b84e'], 46, 5, 13, 1));
    const dirt = pattern(mottle(64, '#d9a66b', ['#e4b47c', '#c9955a', '#d19e62'], 44, 2, 7, 2));
    const water = pattern(mottle(64, '#3fb6e6', ['#63c9f0', '#2f9fd6', '#8ddcf7'], 36, 2, 8, 3));
    const rand = makeRng(11);

    ctx.fillStyle = grass;
    ctx.fillRect(-MARGIN, -MARGIN, spanX, spanZ);

    // Ground cover by height and steepness: the upper level is a sunnier
    // green, and anything steep is bare rock.
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const i = r * cols + c;
        const h = heights[i];
        const slope = Math.hypot(heights[i + 1] - h, heights[i + cols] - h) / CELL;
        const x = c * CELL - MARGIN;
        const z = r * CELL - MARGIN;
        if (h > 1) {
          ctx.fillStyle = `rgba(250, 235, 120, ${(0.2 * h) / HIGH})`;
          ctx.fillRect(x, z, CELL + 0.5, CELL + 0.5);
        }
        if (slope > 0.22) {
          const shade = 0.85 + rand() * 0.3;
          ctx.fillStyle = `rgba(${132 * shade}, ${100 * shade}, ${74 * shade}, ${Math.min(1, (slope - 0.22) * 4)})`;
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

    // The dirt road, in one unbroken pass: everything except the bridge, whose
    // deck is in the air and has the river on the ground beneath it.
    for (const [from, steps] of this.runs((i) => !this.bridge[i])) {
      const road = this.path(from, steps);
      stroke(road, 'rgba(60, 40, 20, 0.35)', ROAD_HALF * 2 + 12); // soft shadow at the edge
      stroke(road, '#8a623c', ROAD_HALF * 2 + 5); // dark rim
      stroke(road, dirt, ROAD_HALF * 2);
      stroke(road, 'rgba(255, 244, 214, 0.6)', 3, [16, 26]); // centre dashes
    }

    // The river: the stream to the lip, the falls, then shallow water back to the dirt.
    ctx.lineCap = 'round';
    const river = this.pathBetween(WATER_FROM, WATER_TO);
    stroke(river, '#1f7fb5', WATER_HALF * 2 + 7); // deep-blue bank
    stroke(river, water, WATER_HALF * 2);
    ctx.lineCap = 'butt';

    // The shadow of the bridge on the river below it.
    for (const [from, steps] of this.runs((i) => this.bridge[i] === 1)) {
      stroke(this.path(from, steps), 'rgba(10, 30, 60, 0.28)', BRIDGE_WALL * 2 + 6);
    }

    // Foam where the waterfall lands.
    const landing = this.sampleAt(CLIFF_TO + 0.35);
    for (let n = 0; n < 26; n++) {
      const angle = rand() * Math.PI * 2;
      const reach = rand() * WATER_HALF * 0.95;
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
    ctx.setLineDash([]);

    /** Draw something at a sample, turned to face along the track (x = forwards). */
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

    // Arrows on the road showing the way.
    for (const waypoint of FEATURES.arrow_waypoints) {
      along(this.sampleAt(waypoint), () => chevrons('rgba(255, 250, 225, 0.9)', 6, 15, [-9, 9]));
    }

    // Boost pads: a slim orange panel with three yellow arrows inside it.
    for (const pad of this.boostPads) {
      along(pad.sample, () => {
        ctx.translate(0, pad.lane);
        const edge = 2.5;
        ctx.fillStyle = '#3b2414';
        ctx.beginPath();
        ctx.roundRect(-PAD_LENGTH / 2 - edge, -PAD_HALF_WIDTH - edge, PAD_LENGTH + edge * 2, PAD_HALF_WIDTH * 2 + edge * 2, 5);
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
    const squares = Math.round((ROAD_HALF * 2) / sq);
    along(0, () => {
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < squares; c++) {
          ctx.fillStyle = (r + c) % 2 === 0 ? '#ffffff' : '#1c1c22';
          ctx.fillRect(r * sq - sq, c * sq - ROAD_HALF, sq, sq);
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
function mottle(
  size: number,
  base: string,
  tints: string[],
  blotches: number,
  minR: number,
  maxR: number,
  seed: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rand = makeRng(seed);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  ctx.globalAlpha = 0.45;
  for (let i = 0; i < blotches; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = minR + rand() * (maxR - minR);
    ctx.fillStyle = tints[Math.floor(rand() * tints.length)];
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
