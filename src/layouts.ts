import DINO_FALLS from './tracks/dino-falls.json';
import GLACIER_GLIDE from './tracks/glacier-glide.json';

/**
 * Track layouts and themes.
 *
 * A layout (src/tracks/*.json) says where everything on a track is. Places
 * along the lap are given as waypoint numbers: 5.5 means halfway from waypoint
 * 5 to waypoint 6. A theme says what a kind of track looks and sounds like, so
 * several tracks can share one.
 */

/** What a kart can be driving on. 'grass' is anything off the road: grass, or deep snow. */
export type Surface = 'road' | 'water' | 'ice' | 'lake' | 'grass';

export interface Layout {
  id: string;
  name: string;
  theme: string;
  /** Width and height of the map, in world units. */
  size: [number, number];
  /** Where the start/finish line is. Karts cross it in waypoint order. */
  start: [number, number];
  roadWidth: number;
  /** How many laps make a race on this track. */
  laps: number;
  /** The centre line, as [x, y] points joined by a smooth closed curve. */
  waypoints: [number, number][];
  /** Height of the road as [waypoint, height] pairs, eased smoothly from one to the next. */
  heights: [number, number][];
  /** Stretches that are not plain road. */
  surfaces: { from: number; to: number; type: Surface }[];
  /** Where water pours over a cliff, and where the foam at its foot is. */
  waterfall?: { from: number; to: number; foamAt: number };
  /** Bridges: the middle of each, and how far it runs either side. The road beneath belongs to another part of the lap. */
  bridges: { at: number; halfLength: number }[];
  /** Boost pads: where along the lap, and how far right of the centre line each one sits. */
  boostPads: { waypoint: number; lanes: number[] }[];
  itemRows: number[];
  /** Painted arrows on the road. */
  arrows: number[];
  /** Things on the road to steer round. */
  rocks: { waypoint: number; lane: number; radius: number; sheet: string; sprite: string }[];
  /** Trails of dinosaur footprints beside the road. */
  footprints: { from: number; to: number; lane: number }[];
  scenery: {
    landmarks: { sheet: string; sprite: string; x: number; y: number; height: number; mirror?: boolean }[];
    scatter: {
      sheet: string;
      sprite: string;
      count: number;
      /** Planted between `near` and `far` units beyond the fence. */
      near: number;
      far: number;
      /** Smallest and tallest, in world units. */
      min: number;
      max: number;
      seed: number;
    }[];
    /** Corners that get an arrow sign on the outside. */
    signs: number[];
    /** Things that stand over the road to be driven through. */
    arches: { sheet: string; sprite: string; waypoint: number; width: number }[];
  };
}

/** A blotchy tile: a base colour, colours to mottle it with, and how big the blotches are. */
export interface Mottle {
  base: string;
  tints: string[];
  blotches: number;
  minR: number;
  maxR: number;
}

/** The looping sound for each thing the wheels can be on (null = silence). */
export type SurfaceLoopId =
  | 'surfaceRoad'
  | 'surfaceWater'
  | 'surfaceBridge'
  | 'surfaceGrass'
  | 'surfaceSnow'
  | 'surfaceIce'
  | 'surfaceLake'
  | 'surfacePowder';

export interface Theme {
  /** Colour of the flat plain beyond the terrain; close to the average ground colour. */
  plain: string;
  ground: Mottle;
  road: Mottle;
  /** Dark line along the edge of the road. */
  roadRim: string;
  /** Dashes down the middle of the road. */
  dashes: string;
  /** Tint laid over high ground, as "r, g, b". */
  highTint: string;
  /** Colour of anything steep, as [r, g, b]. */
  cliff: [number, number, number];
  sky: { top: string; haze: string; hills: [string, string, string]; volcano: boolean };
  /** Sprite sheets this theme's tracks use for scenery. */
  kits: string[];
  sounds: Record<Surface | 'bridge', SurfaceLoopId | null>;
}

export const THEMES: Record<string, Theme> = {
  jungle: {
    plain: '#4bb04a',
    ground: { base: '#4bb04a', tints: ['#5cc257', '#3f9c41', '#55b84e'], blotches: 46, minR: 5, maxR: 13 },
    road: { base: '#d9a66b', tints: ['#e4b47c', '#c9955a', '#d19e62'], blotches: 44, minR: 2, maxR: 7 },
    roadRim: '#8a623c',
    dashes: 'rgba(255, 244, 214, 0.6)',
    highTint: '250, 235, 120',
    cliff: [132, 100, 74],
    sky: { top: '#2f7fe0', haze: '#c9ecf7', hills: ['#7fb6c9', '#58a878', '#3f9650'], volcano: true },
    kits: ['scenery', 'props'],
    sounds: {
      road: 'surfaceRoad',
      water: 'surfaceWater',
      ice: 'surfaceIce',
      lake: 'surfaceLake',
      grass: 'surfaceGrass',
      bridge: 'surfaceBridge',
    },
  },
  snow: {
    plain: '#e9f1fa',
    ground: { base: '#e9f1fa', tints: ['#ffffff', '#d6e4f4', '#f4f8fd'], blotches: 40, minR: 6, maxR: 15 },
    road: { base: '#f3ead9', tints: ['#fbf5ea', '#e6dac4', '#efe4d0'], blotches: 44, minR: 2, maxR: 7 },
    roadRim: '#9fb3c8',
    dashes: 'rgba(120, 150, 185, 0.55)',
    highTint: '150, 190, 240',
    cliff: [118, 158, 205],
    sky: { top: '#3d6fd0', haze: '#dcecfb', hills: ['#b9cdea', '#dfe9f7', '#ffffff'], volcano: false },
    kits: ['snow', 'props'],
    sounds: {
      road: 'surfaceSnow',
      water: 'surfaceWater',
      ice: 'surfaceIce',
      lake: 'surfaceLake',
      grass: 'surfacePowder',
      bridge: 'surfaceBridge',
    },
  },
};

export const LAYOUTS = [DINO_FALLS, GLACIER_GLIDE] as unknown as Layout[];
